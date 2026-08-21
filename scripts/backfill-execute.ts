/**
 * Normalize an existing photograph, move its references, and keep the original.
 *
 * THE ORIGINAL IS NEVER DELETED HERE. Not behind a flag, not after
 * verification, not at all: this file contains no storage delete of any kind,
 * and the test asserts it by reading the source. After a successful run the
 * bucket holds BOTH files and the live rows point at the new master, which is
 * what makes this phase reversible — a bad result is undone by pointing the
 * rows back, not by restoring something that no longer exists. Deleting
 * originals is C3, after somebody has looked at the pictures.
 *
 *   npx tsx scripts/backfill-execute.ts                     # plan, writes a manifest
 *   npx tsx scripts/backfill-execute.ts --execute \
 *     --batch-id batch-1 --source-manifest <path> \
 *     --yes-i-understand-originals-are-retained
 *
 * The manifest carries a checksum of what the plan expected to find. If a
 * photograph, a gallery or a draft has changed since, the checksum stops
 * matching and the run aborts before writing anything.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import {
  JPEG_MASTER,
  MASTER_CACHE_CONTROL,
  MAX_INPUT_PIXELS,
  NORMALIZER_VERSION,
  assertAcceptedFormat,
  assertUsableBytes,
  assertUsableSource,
  masterEncoding,
  masterKey,
  targetSize,
} from "../lib/imageNormalize";
import { ImageReferenceGraph, classifyObject, type TableRows } from "../lib/imageReferences";
import {
  MAX_EXECUTION_BATCH,
  MigrationRefused,
  assertBatchSize,
  assertExecuteFlags,
  manifestChecksum,
  migrationRefusal,
  planRepoints,
  rollbackFor,
  type Manifest,
  type ManifestEntry,
} from "../lib/imageBackfill";
import { displayDimensions, parseHeader } from "./backfill-images";

const BUCKET = "product-images";
sharp.cache(false);
sharp.concurrency(1);

const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Source .env.local first.`);
  return value;
}
const restHeaders = () => ({
  apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
  Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
});

async function rest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(env("NEXT_PUBLIC_SUPABASE_URL") + path, {
    ...init,
    headers: { ...restHeaders(), "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function getJson(path: string, accept?: string): Promise<unknown> {
  const response = await fetch(env("NEXT_PUBLIC_SUPABASE_URL") + path, {
    headers: { ...restHeaders(), ...(accept ? { Accept: accept } : {}) },
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

const publicUrl = (key: string) =>
  `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${key}`;

/* ─────────────────────────────── inventory ──────────────────────────────── */

async function listObjects(): Promise<Array<{ key: string; bytes: number; mime: string | null; createdAt: string | null }>> {
  const list = async (prefix: string) => {
    const response = await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { ...restHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: "name", order: "asc" } }),
    });
    return (await response.json()) as Array<Record<string, unknown>>;
  };
  const root = await list("");
  const out: Array<{ key: string; bytes: number; mime: string | null; createdAt: string | null }> = [];
  const add = (prefix: string, row: Record<string, unknown>) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    out.push({
      key: prefix ? `${prefix}/${row.name}` : String(row.name),
      bytes: Number(meta.size ?? 0),
      mime: (meta.mimetype as string) ?? null,
      createdAt: (row.created_at as string) ?? null,
    });
  };
  for (const row of root) if (row.id) add("", row);
  for (const folder of root.filter((r) => !r.id).map((r) => String(r.name))) {
    for (const row of await list(folder)) if (row.id) add(folder, row);
  }
  return out;
}

async function fetchTables(): Promise<{ tables: TableRows[]; unreadable: string[] }> {
  const spec = (await getJson("/rest/v1/", "application/openapi+json")) as { paths?: Record<string, unknown> };
  const names = Object.keys(spec.paths ?? {})
    .filter((p) => p !== "/" && !p.includes("{") && !p.startsWith("/rpc"))
    .map((p) => p.replace(/^\//, ""));
  const tables: TableRows[] = [];
  const unreadable: string[] = [];
  for (const table of names) {
    try {
      const rows = (await getJson(`/rest/v1/${table}?select=*&limit=10000`)) as Array<Record<string, unknown>>;
      if (Array.isArray(rows)) tables.push({ table, rows });
      else unreadable.push(table);
    } catch {
      unreadable.push(table);
    }
  }
  return { tables, unreadable };
}

/* ───────────────────────────────── planning ─────────────────────────────── */

interface Plan extends ManifestEntry {
  displayWidth: number;
  displayHeight: number;
  targetWidth: number;
  targetHeight: number;
  orientation: number | null;
  format: string | null;
  references: Record<string, number>;
  liveReferences: number;
  estimatedMasterBytes: number;
}

async function buildPlan(limit: number): Promise<{ plans: Plan[]; graph: ImageReferenceGraph; objects: Awaited<ReturnType<typeof listObjects>> }> {
  const objects = await listObjects();
  const { tables, unreadable } = await fetchTables();
  const graph = new ImageReferenceGraph(tables, unreadable);
  const plans: Plan[] = [];
  const now = new Date();

  for (const object of objects) {
    if (plans.length >= limit) break;
    if (!object.key.startsWith("products/")) continue;
    const live = graph.liveReferenceCount(BUCKET, object.key);
    const historical = graph.historicalReferenceCount(BUCKET, object.key);
    const classification = classifyObject({
      object: { bucket: BUCKET, ...object },
      liveReferences: live, historicalReferences: historical,
      graphIsComplete: graph.isComplete, now,
    });
    const references = graph.referencesFor(BUCKET, object.key);
    const { repoints, blockers } = planRepoints(references, publicUrl(object.key));

    const header = parseHeader((await readRange(publicUrl(object.key))) ?? Buffer.alloc(0));
    const display = displayDimensions(header);
    const refusal = migrationRefusal({
      classification, liveReferences: live, graphIsComplete: graph.isComplete,
      format: header.format, hasWarnings: !display, blockers: blockers.length,
    });
    if (refusal || !display) continue;

    const target = targetSize(display);
    if (target.width === display.width && target.height === display.height) continue; // nothing to gain
    plans.push({
      sourcePath: object.key, sourceBytes: object.bytes, repoints,
      displayWidth: display.width, displayHeight: display.height,
      targetWidth: target.width, targetHeight: target.height,
      orientation: header.orientation, format: header.format,
      references: graph.breakdown(BUCKET, object.key), liveReferences: live,
      estimatedMasterBytes: Math.round(((target.width * target.height) / 1e6) * 0.375 * 1e6),
    });
  }
  return { plans, graph, objects };
}

async function readRange(url: string, bytes = 262143): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { headers: { Range: `bytes=0-${bytes}` } });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * A batch chosen to exercise the risky paths, not the easy ones.
 *
 * Orientation is the axis that matters: a photograph stored sideways is the one
 * a careless migration ruins, so the first five deliberately span 6, 1, 3 and 8
 * — 3 included because the catalogue contains exactly two of them and an
 * untested rotation is a bad thing to discover in batch nine.
 */
function chooseBatch(plans: Plan[]): Plan[] {
  const chosen: Plan[] = [];
  const take = (predicate: (p: Plan) => boolean) => {
    const found = plans.find((p) => predicate(p) && !chosen.includes(p));
    if (found) chosen.push(found);
  };
  take((p) => p.orientation === 6);
  take((p) => p.orientation === 1);
  take((p) => p.orientation === 3);
  take((p) => p.orientation === 8);
  // The fifth is the largest remaining, which is the most detailed textile and
  // the biggest single saving available.
  const rest = plans.filter((p) => !chosen.includes(p)).sort((a, b) => b.sourceBytes - a.sourceBytes);
  if (rest[0]) chosen.push(rest[0]);
  return chosen.slice(0, MAX_EXECUTION_BATCH);
}

/* ─────────────────────────────── execution ──────────────────────────────── */

interface LedgerRecord extends Record<string, unknown> {
  timestamp: string;
  batchId: string;
  sourcePath: string;
  status: string;
}

async function execute(batchId: string, manifestPath: string) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  assertBatchSize(manifest.entries.length);
  if (manifest.batchId !== batchId) {
    throw new MigrationRefused(
      `manifest is for batch "${manifest.batchId}", not "${batchId}"`, "batch_id_mismatch");
  }
  if (manifest.normalizerVersion !== NORMALIZER_VERSION) {
    throw new MigrationRefused("manifest was built by a different normalizer version", "version_mismatch");
  }
  if (manifestChecksum(manifest.entries, sha256) !== manifest.checksum) {
    throw new MigrationRefused("manifest checksum does not match its own contents", "manifest_tampered");
  }

  // The world may have moved since the plan. Rebuild and compare.
  const { tables, unreadable } = await fetchTables();
  const graph = new ImageReferenceGraph(tables, unreadable);
  if (!graph.isComplete) {
    throw new MigrationRefused("reference graph incomplete — refusing to migrate", "graph_incomplete");
  }
  const liveEntries: ManifestEntry[] = manifest.entries.map((entry) => {
    const references = graph.referencesFor(BUCKET, entry.sourcePath);
    const { repoints } = planRepoints(references, publicUrl(entry.sourcePath));
    return { sourcePath: entry.sourcePath, sourceBytes: entry.sourceBytes, repoints };
  });
  if (manifestChecksum(liveEntries, sha256) !== manifest.checksum) {
    throw new MigrationRefused(
      "live data no longer matches the manifest — replan and review before executing", "data_moved");
  }

  console.log(`\n  EXECUTING batch "${batchId}" — ${manifest.entries.length} source(s). Originals are RETAINED.\n`);
  const records: LedgerRecord[] = [];
  for (const entry of manifest.entries) {
    records.push(await migrateOne(batchId, entry, graph));
  }

  const dir = "reports/image-backfill";
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/executed-${batchId}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n  ledger: ${file}`);
  const ok = records.filter((r) => r.status === "migrated").length;
  console.log(`  migrated ${ok}/${records.length}. Every original is still in the bucket.`);
  console.log("  NEXT: owner visual review, then C3 decides about deletion. Do not run batch 2.\n");
}

async function migrateOne(batchId: string, entry: ManifestEntry, graph: ImageReferenceGraph): Promise<LedgerRecord> {
  const started = new Date().toISOString();
  const sourceUrl = publicUrl(entry.sourcePath);
  const base: LedgerRecord = {
    timestamp: started, batchId, sourcePath: entry.sourcePath, sourceUrl,
    sourceBytes: entry.sourceBytes, normalizerVersion: NORMALIZER_VERSION,
    referencesBefore: entry.repoints.length, status: "pending",
  };
  const applied: Array<{ table: string; rowId: string; column: string; oldUrl: string; newUrl: string }> = [];

  try {
    console.log(`  ── ${entry.sourcePath}`);
    const download = await fetch(sourceUrl);
    if (!download.ok) throw new Error(`source unreadable (${download.status})`);
    const source = Buffer.from(await download.arrayBuffer());
    assertUsableBytes(source.byteLength);
    assertAcceptedFormat(source);

    const meta = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
    if (!meta.width || !meta.height) throw new Error("source has no dimensions");
    const rotated = (meta.orientation ?? 1) >= 5;
    const display = { width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height };
    assertUsableSource(display);
    const target = targetSize(display);

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
    if (!check.width || !check.height || master.byteLength === 0) throw new Error("normalized output invalid");
    if (check.width !== target.width || check.height !== target.height) {
      throw new Error(`normalized to ${check.width}x${check.height}, expected ${target.width}x${target.height}`);
    }

    const key = masterKey(sha256(source), encoding.ext);
    const masterUrl = publicUrl(key);
    const upload = await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/${BUCKET}/${key}`, {
      method: "POST",
      headers: { ...restHeaders(), "Content-Type": encoding.contentType, "cache-control": MASTER_CACHE_CONTROL, "x-upsert": "false" },
      body: new Uint8Array(master),
    });
    const duplicate = upload.status === 409 || (!upload.ok && /exists|duplicate/i.test(await upload.clone().text()));
    if (!upload.ok && !duplicate) throw new Error(`master upload failed (${upload.status})`);

    const readable = await fetch(masterUrl, { headers: { Range: "bytes=0-0" } });
    if (!readable.ok) throw new Error(`master not readable (${readable.status})`);

    Object.assign(base, {
      sourceChecksum: sha256(source), sourceFormat: meta.format,
      sourceDimensions: `${meta.width}x${meta.height}`, displayDimensions: `${display.width}x${display.height}`,
      orientation: meta.orientation ?? null, masterPath: key, masterUrl,
      masterBytes: master.byteLength, masterDimensions: `${check.width}x${check.height}`,
      masterWasDuplicate: duplicate, alpha: hasRealAlpha,
    });
    console.log(`     master ${key}  ${(master.byteLength / 1048576).toFixed(2)} MiB  ${check.width}x${check.height}${duplicate ? "  (already existed)" : ""}`);

    // ── repoint, one row at a time, each guarded by compare-and-set ──
    for (const repoint of entry.repoints) {
      const query = `/rest/v1/${repoint.table}?id=eq.${encodeURIComponent(repoint.rowId)}&${repoint.column}=eq.${encodeURIComponent(repoint.oldUrl)}`;
      const response = await rest(query, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ [repoint.column]: masterUrl }),
      });
      if (!response.ok) throw new Error(`${repoint.table}/${repoint.rowId} patch failed (${response.status})`);
      const updated = (await response.json()) as unknown[];
      // Zero rows means the value was not what the plan recorded: somebody
      // edited it after the snapshot. Stop, and put back what we changed.
      if (updated.length !== 1) {
        throw new Error(`compare-and-set matched ${updated.length} rows for ${repoint.table}/${repoint.rowId}`);
      }
      applied.push({ ...repoint, newUrl: masterUrl });
    }

    // ── read back and verify ──
    const after = await fetchTables();
    const afterGraph = new ImageReferenceGraph(after.tables, after.unreadable);
    const stillOnSource = afterGraph.liveReferenceCount(BUCKET, entry.sourcePath);
    const onMaster = afterGraph.liveReferenceCount(BUCKET, key);
    if (stillOnSource !== 0) throw new Error(`${stillOnSource} live reference(s) still point at the original`);
    if (onMaster < entry.repoints.length) {
      throw new Error(`master has ${onMaster} live reference(s), expected at least ${entry.repoints.length}`);
    }

    Object.assign(base, {
      rowsUpdatedByTable: countByTable(applied),
      referencesAfterOnSource: stillOnSource, referencesAfterOnMaster: onMaster,
      verification: "passed", rollbackData: rollbackFor(applied),
      bytesAddedNow: master.byteLength, bytesReclaimableAfterC3: entry.sourceBytes,
      status: "migrated",
    });
    console.log(`     repointed ${applied.length} row(s); original retained; source now has ${stillOnSource} live refs`);
    return base;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`     FAILED: ${message}`);
    if (applied.length > 0) {
      console.log(`     rolling back ${applied.length} row(s)…`);
      const restored = await rollback(applied);
      Object.assign(base, { rolledBack: restored.length, rollbackComplete: restored.length === applied.length });
      console.log(`     rollback restored ${restored.length}/${applied.length}`);
    }
    Object.assign(base, { status: "failed", error: message, referencesAfterOnSource: null });
    return base;
  }
}

/** Put every row this source changed back to the original URL. */
async function rollback(
  applied: Array<{ table: string; rowId: string; column: string; oldUrl: string; newUrl: string }>
): Promise<string[]> {
  const restored: string[] = [];
  for (const step of rollbackFor(applied)) {
    const query = `/rest/v1/${step.table}?id=eq.${encodeURIComponent(step.rowId)}&${step.column}=eq.${encodeURIComponent(step.from)}`;
    const response = await rest(query, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ [step.column]: step.to }),
    });
    if (response.ok && ((await response.json()) as unknown[]).length === 1) {
      restored.push(`${step.table}/${step.rowId}`);
    }
  }
  return restored;
}

function countByTable(applied: Array<{ table: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of applied) out[a.table] = (out[a.table] ?? 0) + 1;
  return out;
}

/* ──────────────────────────────── entry point ───────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--execute")) {
    const { batchId, manifestPath } = assertExecuteFlags(argv);
    await execute(batchId, manifestPath);
    return;
  }

  console.log("\n  PLAN ONLY. Nothing is written without --execute and its manifest.\n");
  const { plans, objects } = await buildPlan(Infinity);
  const batch = chooseBatch(plans);
  assertBatchSize(batch.length);

  const MiB = (n: number) => (n / 1048576).toFixed(2);
  console.log(`  eligible sources: ${plans.length}   proposing the first ${batch.length}\n`);
  let sourceTotal = 0;
  let masterTotal = 0;
  for (const p of batch) {
    sourceTotal += p.sourceBytes;
    masterTotal += p.estimatedMasterBytes;
    console.log(`  SOURCE      ${p.sourcePath}`);
    console.log(`  CURRENT     ${MiB(p.sourceBytes)} MiB  ${p.displayWidth}x${p.displayHeight}  ${p.format}  EXIF orientation ${p.orientation ?? "none"}`);
    console.log(`  REFERENCES  ${Object.entries(p.references).map(([t, n]) => `${t}: ${n}`).join("  ")}  (live ${p.liveReferences})`);
    console.log(`  WOULD WRITE ${p.repoints.length} row(s): ${p.repoints.map((r) => `${r.table}/${r.rowId.slice(0, 8)}`).join(", ")}`);
    console.log(`  MASTER      ${p.targetWidth}x${p.targetHeight}, ~${MiB(p.estimatedMasterBytes)} MiB`);
    console.log(`  ORIGINAL    RETAINED — C2 never deletes; ${MiB(p.sourceBytes)} MiB reclaimable later in C3\n`);
  }

  const entries: ManifestEntry[] = batch.map((p) => ({
    sourcePath: p.sourcePath, sourceBytes: p.sourceBytes, repoints: p.repoints,
  }));
  const batchId = `batch-${new Date().toISOString().slice(0, 10)}-1`;
  const manifest: Manifest = {
    batchId, createdAt: new Date().toISOString(), normalizerVersion: NORMALIZER_VERSION,
    entries, checksum: manifestChecksum(entries, sha256),
  };
  mkdirSync("reports/image-backfill", { recursive: true });
  const path = `reports/image-backfill/manifest-${batchId}.json`;
  writeFileSync(path, JSON.stringify(manifest, null, 1));

  const bucketBytes = objects.reduce((s, o) => s + o.bytes, 0);
  console.log(`  bucket now              ${objects.length} objects  ${(bucketBytes / 1073741824).toFixed(4)} GiB`);
  console.log(`  masters this batch adds ~${MiB(masterTotal)} MiB   (storage goes UP; nothing is reclaimed until C3)`);
  console.log(`  reclaimable later       ${MiB(sourceTotal)} MiB across ${batch.length} originals`);
  console.log(`\n  manifest: ${path}`);
  console.log(`  to execute:\n    npx tsx scripts/backfill-execute.ts --execute --batch-id ${batchId} \\\n      --source-manifest ${path} --yes-i-understand-originals-are-retained\n`);
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
