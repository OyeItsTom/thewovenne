/**
 * C6 — normalize live originals and move their references. RETAINS ORIGINALS.
 *
 *   npx tsx --env-file=.env.local scripts/c6-normalize-execute.ts --execute \
 *     --batch-id c6-1 \
 *     --source-manifest reports/c6-normalize/manifest-c6-1.json \
 *     --yes-i-understand-originals-are-retained
 *
 * THIS TOOL DELETES NOTHING. Not the original, not a master, not a row. After
 * a successful run the original is still in the bucket, byte for byte, and the
 * rows that used to point at it point at a smaller master instead. That is the
 * entire safety model: if a master turns out wrong, the fix is to point the
 * rows back at bytes that are still there. Reclaiming those bytes is C3's
 * separate, irreversible decision, under its own review.
 *
 * WHY THIS IS THIN. Every judgement this file makes is imported. What counts
 * as a repointable reference, what a cart means, how to roll back, what the
 * normalizer produces, what the checksum protects, whether a source is in
 * scope — all of it lives in lib/imageC6.ts, lib/imageBackfill.ts and
 * lib/imageNormalize.ts, shared with C2 which has run this shape 35 times.
 * What is written here is only the sequence, because C2's own sequencer is a
 * private function inside its script and copying a proven executor is safer
 * than editing one.
 *
 * THE SHAPE OF THE RUN. Each source is proven and migrated alone:
 *
 *     re-prove A -> normalize -> upload A's master -> verify it
 *       -> compare-and-set each of A's rows -> read back -> verify
 *       -> ledger -> then B
 *
 * Nothing is pre-authorised. B's checks run after A is already migrated,
 * against live data, because the world may have changed in between.
 *
 * FIRST FAILURE STOPS EVERYTHING. A source that fails after some of its rows
 * were rewritten has those rows put back before the batch ends.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import sharp from "sharp";
import {
  MigrationRefused,
  assertValidBatchId,
  describeRetainedIdentity,
  planRepoints,
  retainedIdentityDiff,
  retainedIdentitySet,
  rollbackFor,
} from "../lib/imageBackfill";
import {
  C6_MANIFEST_KIND,
  MAX_C6_BATCH,
  assertC6BatchSize,
  assertC6InScope,
  assertCoherentC6Manifest,
  c6ManifestChecksum,
  classifyForC6,
  isC6Eligible,
  type C6Candidate,
  type C6Manifest,
  type C6ManifestEntry,
  type C6Reference,
} from "../lib/imageC6";
import {
  JPEG_MASTER,
  MASTER_CACHE_CONTROL,
  MAX_INPUT_PIXELS,
  NORMALIZER_VERSION,
  masterEncoding,
  masterKey,
  targetSize,
} from "../lib/imageNormalize";
import { ImageReferenceGraph, type TableRows } from "../lib/imageReferences";
import { enumerateAllObjects, type StorageEntry } from "../lib/storagePrefixes";

const BUCKET = "product-images";
const LEDGER_DIR = "reports/c6-normalize";
const REFERENCE_TABLES = ["product_images", "products", "product_versions", "site_content", "carts"];

const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const MiB = (n: number) => (n / 1048576).toFixed(2);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
const restHeaders = () => ({
  apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
  Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
  "Content-Type": "application/json",
});
const publicUrl = (key: string) =>
  `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${key}`;
const rest = (path: string, init?: RequestInit) =>
  fetch(env("NEXT_PUBLIC_SUPABASE_URL") + path,
    { ...init, headers: { ...restHeaders(), ...(init?.headers ?? {}) } });

/* ─────────────────────── the migration command line ────────────────────── */

/**
 * The flags a C6 run must carry.
 *
 * The acknowledgement is C2's, deliberately: C6 does exactly what C2 does and
 * makes exactly the same promise — the original is retained. Sharing the words
 * is honest where sharing them with C3 or C5 would be dangerous, and the
 * manifest `kind` check keeps the two tools from consuming each other's plans
 * even when the command lines look alike.
 *
 * The two DESTRUCTIVE acknowledgements are refused outright. Someone reaching
 * for a deletion command and landing here should get an error, not a migration.
 */
export const C6_FLAGS = {
  execute: "--execute",
  batchId: "--batch-id",
  manifest: "--source-manifest",
  acknowledgement: "--yes-i-understand-originals-are-retained",
} as const;

const DESTRUCTIVE_ACKNOWLEDGEMENTS = [
  "--yes-i-understand-original-deletion-is-permanent",          // C3
  "--yes-i-understand-the-duplicate-is-the-only-other-copy",    // C5
];

export function assertC6Flags(argv: string[]): { batchId: string; manifestPath: string } {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (!has(C6_FLAGS.execute)) {
    throw new MigrationRefused("Not an execution run.", "not_execute");
  }
  if (!has(C6_FLAGS.acknowledgement)) {
    throw new MigrationRefused(
      `This migration also needs ${C6_FLAGS.acknowledgement}.`, "missing_acknowledgement");
  }
  for (const destructive of DESTRUCTIVE_ACKNOWLEDGEMENTS) {
    if (has(destructive)) {
      throw new MigrationRefused(
        `${destructive} belongs to a deletion tool. C6 migrates and retains; it never deletes.`,
        "wrong_acknowledgement");
    }
  }
  const batchId = valueOf(C6_FLAGS.batchId);
  const manifestPath = valueOf(C6_FLAGS.manifest);
  if (!batchId) throw new MigrationRefused(`${C6_FLAGS.batchId} is required.`, "missing_batch_id");
  if (!manifestPath) throw new MigrationRefused(`${C6_FLAGS.manifest} is required.`, "missing_manifest");
  return { batchId: assertValidBatchId(batchId), manifestPath };
}

/* ─────────────────────────────── live reads ────────────────────────────── */

async function fetchTables(): Promise<{ tables: TableRows[]; unreadable: string[] }> {
  const tables: TableRows[] = [];
  const unreadable: string[] = [];
  for (const table of REFERENCE_TABLES) {
    try {
      const response = await rest(`/rest/v1/${table}?select=*`);
      if (!response.ok) { unreadable.push(table); continue; }
      const rows = await response.json();
      if (!Array.isArray(rows)) { unreadable.push(table); continue; }
      tables.push({ table, rows });
    } catch { unreadable.push(table); }
  }
  return { tables, unreadable };
}

async function freshGraph(): Promise<ImageReferenceGraph> {
  const { tables, unreadable } = await fetchTables();
  return new ImageReferenceGraph(tables, unreadable);
}

async function listObjects(): Promise<Map<string, number>> {
  const listPage = async (prefix: string, offset: number): Promise<StorageEntry[]> => {
    const response = await fetch(
      `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/list/${BUCKET}`,
      { method: "POST", headers: { ...restHeaders() },
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }) });
    const page = await response.json();
    return Array.isArray(page) ? page : [];
  };
  return new Map((await enumerateAllObjects(listPage)).map((o) => [o.key, o.bytes]));
}

/** Graph hits, in the shape lib/imageC6 expects. */
function referencesOf(graph: ImageReferenceGraph, key: string): C6Reference[] {
  return graph.referencesFor(BUCKET, key)
    .map((r) => ({ table: r.table, rowId: r.rowId, field: r.field, live: r.live }));
}

/* ─────────────────────────────── the ledger ────────────────────────────── */

export type C6Status =
  | "MIGRATED" | "MASTER_REUSED" | "REFUSED" | "FAILED" | "ROLLED_BACK";

/**
 * Append one line, and let a failure to write stop the run.
 *
 * Not wrapped in try/catch on purpose. A migration with no record of which
 * rows moved is a migration nobody can undo, so if the ledger cannot be
 * written the work must not proceed.
 */
function appendLedger(file: string, record: Record<string, unknown>): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`, { flag: "a" });
}

class C6Stopped extends Error {
  constructor(readonly label: string, message: string) { super(message); }
}

/* ──────────────────────────────── entry point ──────────────────────────── */

async function main() {
  const { batchId, manifestPath } = assertC6Flags(process.argv.slice(2));

  /* ── manifest integrity, before any network call ── */
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as C6Manifest;
  if (manifest.kind !== C6_MANIFEST_KIND) {
    throw new MigrationRefused(
      `manifest kind is "${manifest.kind}", not "${C6_MANIFEST_KIND}" — this is not a C6 plan`, "wrong_kind");
  }
  assertValidBatchId(manifest.batchId);
  if (manifest.batchId !== batchId) {
    throw new MigrationRefused(
      `manifest is for batch "${manifest.batchId}", not "${batchId}"`, "batch_id_mismatch");
  }
  assertC6BatchSize(manifest.entries.length);
  const selfChecksum = c6ManifestChecksum(
    { batchId: manifest.batchId, normalizerVersion: manifest.normalizerVersion, entries: manifest.entries },
    sha256);
  if (selfChecksum !== manifest.checksum) {
    throw new MigrationRefused("manifest checksum does not match its own contents", "manifest_tampered");
  }
  assertCoherentC6Manifest(manifest);

  console.log(`\n  C6 MIGRATION — batch "${batchId}", ${manifest.entries.length} original(s).`);
  console.log("  Originals are RETAINED. This tool deletes nothing.\n");

  mkdirSync(LEDGER_DIR, { recursive: true });
  const ledgerFile = `${LEDGER_DIR}/c6-migrated-${batchId}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
  console.log(`  ledger: ${ledgerFile}\n`);

  let migrated = 0;
  let addedBytes = 0;

  for (const entry of manifest.entries) {
    const label = entry.sourcePath;
    const sourceUrl = publicUrl(entry.sourcePath);
    const applied: Array<{ table: string; rowId: string; column: string; oldUrl: string; newUrl: string }> = [];
    const record = (status: C6Status, extra: Record<string, unknown> = {}) => ({
      timestamp: new Date().toISOString(), batchId, manifestChecksum: manifest.checksum,
      sourcePath: entry.sourcePath, status, ...extra,
    });

    try {
      console.log(`  ── ${entry.sourcePath}`);

      /* ── 1. fresh live revalidation, before anything is produced ── */
      assertC6InScope(entry.sourcePath);
      const graph = await freshGraph();
      const objects = await listObjects();
      if (!graph.isComplete) throw new C6Stopped(label, "reference graph incomplete");
      if (!objects.has(entry.sourcePath)) throw new C6Stopped(label, "source is no longer in the bucket");

      const download = await fetch(sourceUrl);
      if (!download.ok) throw new C6Stopped(label, `source unreadable (${download.status})`);
      const source = Buffer.from(await download.arrayBuffer());

      if (source.byteLength !== entry.sourceBytes) {
        throw new C6Stopped(label, `source is ${source.byteLength} bytes, manifest says ${entry.sourceBytes}`);
      }
      const liveChecksum = sha256(source);
      if (liveChecksum !== entry.sourceChecksum) {
        throw new C6Stopped(label, `source checksum ${liveChecksum.slice(0, 16)}… does not match the manifest`);
      }

      const meta = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      if (!meta.width || !meta.height) throw new C6Stopped(label, "source dimensions unreadable");
      const rotated = (meta.orientation ?? 1) >= 5;
      const display = rotated
        ? { width: meta.height, height: meta.width }
        : { width: meta.width, height: meta.height };
      if (display.width !== entry.sourceWidth || display.height !== entry.sourceHeight) {
        throw new C6Stopped(label,
          `display dimensions are ${display.width}x${display.height}, manifest says ${entry.sourceWidth}x${entry.sourceHeight}`);
      }
      if ((meta.orientation ?? null) !== entry.orientation) {
        throw new C6Stopped(label, `EXIF orientation is ${meta.orientation ?? null}, manifest says ${entry.orientation}`);
      }

      const target = targetSize(display);
      if (target.width !== entry.targetWidth || target.height !== entry.targetHeight) {
        throw new C6Stopped(label,
          `target is now ${target.width}x${target.height}, manifest planned ${entry.targetWidth}x${entry.targetHeight}`);
      }
      if (target.width === display.width && target.height === display.height) {
        throw new C6Stopped(label, "there is nothing to gain; the source is already at target size");
      }

      // The full rule set, re-run against live data — scope, references,
      // blockers and all. The manifest is a plan, not a permission.
      const references = referencesOf(graph, entry.sourcePath);
      const candidate: C6Candidate = {
        sourcePath: entry.sourcePath, exists: true, sourceBytes: source.byteLength,
        sourceChecksum: liveChecksum, displayWidth: display.width, displayHeight: display.height,
        orientation: meta.orientation ?? null, format: meta.format ?? null,
        references, graphIsComplete: graph.isComplete, auditedSafeCandidate: true,
      };
      const verdict = classifyForC6(candidate, planRepoints, sourceUrl);
      if (!isC6Eligible(verdict.state)) {
        appendLedger(ledgerFile, record("REFUSED",
          { classification: verdict.state, reason: verdict.reason, blockers: verdict.blockers }));
        throw new C6Stopped(label, `${verdict.state}: ${verdict.reason}`);
      }

      // The exact rows, still holding the exact values the plan recorded.
      const planned = new Set(entry.repoints.map((r) => `${r.table}/${r.rowId}/${r.column}/${r.oldUrl}`));
      const livePlan = new Set(verdict.repoints.map((r) => `${r.table}/${r.rowId}/${r.column}/${r.oldUrl}`));
      if (planned.size !== livePlan.size || [...planned].some((p) => !livePlan.has(p))) {
        throw new C6Stopped(label, "the live reference set no longer matches the reviewed plan");
      }

      // WHICH references must survive on the retained original, by identity.
      const retainedBefore = retainedIdentitySet(graph.referencesFor(BUCKET, entry.sourcePath), sourceUrl);

      /* ── 2. normalize, and verify the output before it is uploaded ── */
      const stats = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).ensureAlpha().stats();
      const alphaChannel = stats.channels[stats.channels.length - 1];
      const hasRealAlpha = Boolean(meta.hasAlpha) && alphaChannel.min < 255;
      const encoding = masterEncoding(hasRealAlpha);

      const pipeline = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
        .rotate().toColourspace("srgb").withIccProfile("srgb")
        .resize({ ...target, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" });
      const master = hasRealAlpha
        ? await pipeline.webp({ lossless: true, effort: 4 }).toBuffer()
        : await pipeline.jpeg({ ...JPEG_MASTER, mozjpeg: false }).toBuffer();

      const check = await sharp(master).metadata();
      if (!check.width || !check.height || master.byteLength === 0) {
        throw new C6Stopped(label, "normalized output invalid");
      }
      if (check.width !== target.width || check.height !== target.height) {
        throw new C6Stopped(label,
          `normalized to ${check.width}x${check.height}, expected ${target.width}x${target.height}`);
      }

      /* ── 3. upload an immutable, content-addressed master ── */
      //
      // The key is masterKey(sha256(SOURCE)), so identical input always
      // produces identical output at identical path. There is no master-A /
      // master-B: a repeat run computes the same key, is told the object
      // exists, and proceeds only after proving the existing one is right.
      const key = masterKey(liveChecksum, encoding.ext);
      const masterUrl = publicUrl(key);
      const upload = await fetch(
        `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/${BUCKET}/${key}`,
        { method: "POST",
          headers: {
            apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
            Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": encoding.contentType,
            "cache-control": MASTER_CACHE_CONTROL,
            "x-upsert": "false",
          },
          body: new Uint8Array(master) });
      const duplicate = upload.status === 409
        || (!upload.ok && /exists|duplicate/i.test(await upload.clone().text()));
      if (!upload.ok && !duplicate) {
        appendLedger(ledgerFile, record("FAILED", { stage: "upload", httpStatus: upload.status }));
        throw new C6Stopped(label, `master upload failed (${upload.status})`);
      }

      /* ── 4. verify the master is real, readable and correct ── */
      const readBack = await fetch(masterUrl);
      if (!readBack.ok) {
        appendLedger(ledgerFile, record("FAILED", { stage: "master_readback", httpStatus: readBack.status }));
        throw new C6Stopped(label, `master not readable (${readBack.status})`);
      }
      const liveMaster = Buffer.from(await readBack.arrayBuffer());
      const liveMeta = await sharp(liveMaster).metadata();
      if (liveMeta.width !== target.width || liveMeta.height !== target.height) {
        throw new C6Stopped(label,
          `the master in storage is ${liveMeta.width}x${liveMeta.height}, expected ${target.width}x${target.height}`);
      }
      // An existing master is success ONLY after this check. Reusing a
      // same-named object without reading it back would trust a name.
      if (duplicate) {
        console.log(`     master ${key} already existed — verified ${liveMeta.width}x${liveMeta.height}`);
      } else {
        addedBytes += liveMaster.byteLength;
      }
      console.log(`     master ${key}  ${MiB(liveMaster.byteLength)} MiB  ${liveMeta.width}x${liveMeta.height}`);

      /* ── 5. repoint, one row at a time, each guarded by compare-and-set ── */
      for (const repoint of entry.repoints) {
        const query = `/rest/v1/${repoint.table}?id=eq.${encodeURIComponent(repoint.rowId)}` +
          `&${repoint.column}=eq.${encodeURIComponent(repoint.oldUrl)}`;
        const response = await rest(query, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ [repoint.column]: masterUrl }),
        });
        if (!response.ok) {
          throw new C6Stopped(label, `${repoint.table}/${repoint.rowId} patch failed (${response.status})`);
        }
        const updated = (await response.json()) as unknown[];
        // Zero rows means the value was not what the plan recorded: somebody
        // edited it after the snapshot. Stop, and put back what we changed.
        if (updated.length !== 1) {
          throw new C6Stopped(label,
            `compare-and-set matched ${updated.length} rows for ${repoint.table}/${repoint.rowId}`);
        }
        applied.push({ ...repoint, newUrl: masterUrl });
      }

      /* ── 6. read back and verify the final state ── */
      const afterGraph = await freshGraph();
      if (!afterGraph.isComplete) throw new C6Stopped(label, "graph became unreadable after the repoints");
      const afterReferences = afterGraph.referencesFor(BUCKET, entry.sourcePath);
      const afterPlan = planRepoints(
        afterReferences.map((r) => ({ table: r.table, rowId: r.rowId, field: r.field, live: r.live })),
        sourceUrl);
      if (afterPlan.repoints.length !== 0) {
        throw new C6Stopped(label,
          `${afterPlan.repoints.length} migratable reference(s) still point at the original`);
      }
      // Everything meant to STAY must still be there — the same row, the same
      // field, the same URL. A count would hide one cart losing a reference
      // while another gained one.
      const retainedAfter = retainedIdentitySet(afterReferences, sourceUrl);
      const diff = retainedIdentityDiff(retainedBefore, retainedAfter);
      if (!diff.unchanged) {
        throw new C6Stopped(label,
          `retained references changed: missing ${diff.missing.map(describeRetainedIdentity).join(", ") || "none"}`);
      }
      const onMaster = afterGraph.liveReferenceCount(BUCKET, key);
      if (onMaster < entry.repoints.length) {
        throw new C6Stopped(label, `master carries ${onMaster} reference(s), expected ${entry.repoints.length}`);
      }

      /* ── 7. THE ORIGINAL IS STILL THERE. Prove it, then record. ── */
      const originalAfter = await fetch(sourceUrl, { method: "HEAD" });
      if (!originalAfter.ok) {
        throw new C6Stopped(label, "the original is no longer readable — C6 must never remove it");
      }

      appendLedger(ledgerFile, record(duplicate ? "MASTER_REUSED" : "MIGRATED", {
        sourceBytes: source.byteLength, sourceChecksum: liveChecksum,
        sourceDimensions: `${display.width}x${display.height}`, orientation: meta.orientation ?? null,
        masterPath: key, masterUrl, masterBytes: liveMaster.byteLength,
        masterDimensions: `${liveMeta.width}x${liveMeta.height}`,
        normalizerVersion: NORMALIZER_VERSION, masterWasDuplicate: duplicate,
        repointed: applied.map((a) => `${a.table}/${a.rowId}.${a.column}`),
        referencesOnMaster: onMaster, retainedOnOriginal: [...retainedAfter],
        originalRetained: true,
      }));
      migrated += 1;
      console.log(`     ${applied.length} reference(s) moved; original retained (${MiB(source.byteLength)} MiB)\n`);
    } catch (error) {
      /* ── rollback anything this source already changed ── */
      const why = error instanceof C6Stopped ? error.message : String(error);
      let restored = 0;
      if (applied.length > 0) {
        for (const step of rollbackFor(applied)) {
          const query = `/rest/v1/${step.table}?id=eq.${encodeURIComponent(step.rowId)}` +
            `&${step.column}=eq.${encodeURIComponent(step.from)}`;
          const response = await rest(query, {
            method: "PATCH", headers: { Prefer: "return=representation" },
            body: JSON.stringify({ [step.column]: step.to }),
          });
          if (response.ok && ((await response.json()) as unknown[]).length === 1) restored += 1;
        }
        appendLedger(ledgerFile, record("ROLLED_BACK", {
          reason: why, applied: applied.length, restored,
          rollbackComplete: restored === applied.length, originalRetained: true,
        }));
      } else {
        appendLedger(ledgerFile, record("FAILED", { reason: why, originalRetained: true }));
      }
      console.error(`\n  STOPPED at ${label}: ${why}`);
      if (applied.length) console.error(`  rollback restored ${restored}/${applied.length} row(s)`);
      console.error(`  ${migrated} source(s) migrated before this point. The original is untouched.\n`);
      process.exit(1);
    }
  }

  console.log(`  ${migrated}/${manifest.entries.length} migrated, ${MiB(addedBytes)} MiB of masters added.`);
  console.log("  Every original is retained. Reclaiming them is a separate C3 decision.\n");
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
