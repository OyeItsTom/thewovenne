/**
 * C5 — delete duplicate orphans. THIS SCRIPT IS IRREVERSIBLE.
 *
 * C3 deleted an original because C2 had built a normalised master to replace
 * it, and the site had been repointed at that master. C5 has no master and no
 * migration: its candidates are files an admin uploaded twice, stored under
 * two UUIDs, one of which nothing references.
 *
 *   npx tsx --env-file=.env.local scripts/orphan-delete-execute.ts --execute \
 *     --batch-id c5-orphan-1 \
 *     --source-manifest reports/c5-orphan-delete/manifest-c5-orphan-1.json \
 *     --yes-i-understand-the-duplicate-is-the-only-other-copy
 *
 * All four flags are required, and the acknowledgement is neither C2's nor
 * C3's. Three tools in this series now delete or move photographs and their
 * command lines must not be interchangeable — a half-remembered C3 line must
 * fail here rather than do something.
 *
 * WHAT MAKES THIS DIFFERENT FROM C3, AND HARDER.
 *
 * C3's safety claim was about one object: a better copy exists at a path the
 * database now points at. C5's claim is about a PAIR — "these two files are
 * byte-identical, and something live points at the other one". A pair can rot
 * in ways a single object cannot: the twin can be deleted, replaced in place,
 * or detached from every row that referenced it, all while the candidate sits
 * untouched and still looks like a safe duplicate.
 *
 * So every check C3 ran on one object, this runs on two — including a second
 * full download and digest. The moment before deleting a candidate, this tool
 * has just proved that the twin exists, still carries a live reference, and
 * still hashes to exactly the same bytes. If any of that has moved since the
 * plan was written, the batch stops.
 *
 * THE SHAPE OF THE RUN. Each object is proven and destroyed alone:
 *
 *     re-prove the PAIR for A  ->  write A's evidence  ->  delete A
 *       ->  verify A gone and A's twin intact  ->  ledger  ->  then B
 *
 * Nothing is pre-authorised. B's checks run after A is already deleted,
 * against live data, because the world may have changed in between.
 *
 * FIRST FAILURE STOPS EVERYTHING. There is no rollback and no partial-success
 * path worth continuing down.
 *
 * WHAT THIS TOUCHES. It reads the database, reads storage, appends to a local
 * gitignored ledger, and deletes exactly one named object at a time. It issues
 * no PATCH, no POST to any table, and no write to carts or site_content.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { MigrationRefused, assertValidBatchId } from "../lib/imageBackfill";
import {
  C5_MANIFEST_KIND,
  assertC5BatchSize,
  assertC5InScope,
  assertCoherentOrphanManifest,
  classifyOrphan,
  isC5Eligible,
  orphanManifestChecksum,
  type C5ReferenceIdentity,
  type OrphanCandidate,
  type OrphanManifest,
} from "../lib/imageOrphans";
import { enumerateAllObjects, type StorageEntry } from "../lib/storagePrefixes";

const BUCKET = "product-images";
const LEDGER_DIR = "reports/c5-orphan-delete";
const LIVE_TABLES = new Set(["product_images", "products", "product_versions", "site_content", "carts"]);
const HISTORICAL_TABLES = new Set(["admin_audit_log"]);

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
const sha256Bytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MiB = (n: number) => (n / 1048576).toFixed(2);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
const headers = () => ({
  apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
  Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
});
const publicUrl = (key: string) =>
  `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${key}`;

/* ─────────────────────── the destructive command line ──────────────────── */

/**
 * The flags a C5 run must carry. Absent any one of them, nothing happens.
 *
 * The acknowledgement names what is actually at stake here — that the file
 * being kept is the only other copy — and shares no suffix with C2's or C3's,
 * so muscle memory from thirty-four C3 deletions cannot carry into this.
 */
export const C5_FLAGS = {
  execute: "--execute",
  batchId: "--batch-id",
  manifest: "--source-manifest",
  acknowledgement: "--yes-i-understand-the-duplicate-is-the-only-other-copy",
} as const;

const FOREIGN_ACKNOWLEDGEMENTS = [
  "--yes-i-understand-originals-are-retained",        // C2
  "--yes-i-understand-original-deletion-is-permanent", // C3
];

export function assertC5Flags(argv: string[]): { batchId: string; manifestPath: string } {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (!has(C5_FLAGS.execute)) {
    throw new MigrationRefused("Not an execution run.", "not_execute");
  }
  if (!has(C5_FLAGS.acknowledgement)) {
    throw new MigrationRefused(
      `Deletion also needs ${C5_FLAGS.acknowledgement}.`, "missing_acknowledgement");
  }
  // Another tool's acknowledgement is an error, not a no-op: its presence
  // means somebody is running a half-remembered C2 or C3 command line here.
  for (const foreign of FOREIGN_ACKNOWLEDGEMENTS) {
    if (has(foreign)) {
      throw new MigrationRefused(
        `${foreign} belongs to another tool. C5 deletes duplicate uploads and needs its own acknowledgement.`,
        "wrong_acknowledgement");
    }
  }
  const batchId = valueOf(C5_FLAGS.batchId);
  const manifestPath = valueOf(C5_FLAGS.manifest);
  if (!batchId) throw new MigrationRefused(`${C5_FLAGS.batchId} is required.`, "missing_batch_id");
  if (!manifestPath) throw new MigrationRefused(`${C5_FLAGS.manifest} is required.`, "missing_manifest");
  return { batchId: assertValidBatchId(batchId), manifestPath };
}

/* ─────────────────────────── reads, and only reads ─────────────────────── */

function keysIn(value: unknown, out: string[]): void {
  if (value == null) return;
  if (typeof value === "string") {
    const marker = `/${BUCKET}/`;
    let at = value.indexOf(marker);
    while (at >= 0) {
      const rest = value.slice(at + marker.length);
      const key = decodeURIComponent(rest.split(/["'\s,}\]\\]/)[0].split("?")[0]);
      if (key) out.push(key);
      at = value.indexOf(marker, at + 1);
    }
    return;
  }
  if (Array.isArray(value)) { for (const v of value) keysIn(v, out); return; }
  if (typeof value === "object") { for (const v of Object.values(value)) keysIn(v, out); }
}

interface Graph {
  complete: boolean;
  unreadable: string[];
  live: Map<string, C5ReferenceIdentity[]>;
  historical: Map<string, number>;
}

/** Every table PostgREST exposes. GET only; nothing here writes a row. */
async function freshGraph(): Promise<Graph> {
  const spec = await (await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/`, { headers: headers() })).json();
  const tables = Object.keys(spec?.paths ?? {})
    .filter((p) => p !== "/" && !p.startsWith("/rpc/")).map((p) => p.slice(1));

  const live = new Map<string, C5ReferenceIdentity[]>();
  const historical = new Map<string, number>();
  const unreadable: string[] = [];

  for (const table of tables) {
    let rows: unknown;
    try {
      const response = await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/${table}?select=*`,
        { headers: headers() });
      if (!response.ok) { unreadable.push(table); continue; }
      rows = await response.json();
    } catch { unreadable.push(table); continue; }
    if (!Array.isArray(rows)) { unreadable.push(table); continue; }

    for (const row of rows as Record<string, unknown>[]) {
      for (const [column, value] of Object.entries(row)) {
        const found: string[] = [];
        keysIn(value, found);
        for (const key of found) {
          if (LIVE_TABLES.has(table)) {
            const rowId = String(row.id ?? row.product_id ?? row.order_id ?? row.slug ?? "?");
            live.set(key, [...(live.get(key) ?? []), { table, rowId, field: column }]);
          } else if (HISTORICAL_TABLES.has(table)) {
            historical.set(key, (historical.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }
  return { complete: unreadable.length === 0, unreadable, live, historical };
}

async function listObjects(): Promise<Map<string, number>> {
  const listPage = async (prefix: string, offset: number): Promise<StorageEntry[]> => {
    const response = await fetch(
      `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/list/${BUCKET}`,
      { method: "POST", headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }) }
    );
    const page = await response.json();
    return Array.isArray(page) ? page : [];
  };
  const objects = await enumerateAllObjects(listPage);
  return new Map(objects.map((o) => [o.key, o.bytes]));
}

async function objectHead(key: string): Promise<{ ok: boolean; bytes: number | null }> {
  const response = await fetch(publicUrl(key), { method: "HEAD" });
  const length = response.headers.get("content-length");
  return { ok: response.ok, bytes: length === null ? null : Number(length) };
}

/** Downloads the object so its digest can be recomputed from live bytes. */
async function objectBytes(key: string): Promise<Buffer | null> {
  const response = await fetch(publicUrl(key));
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

/* ─────────────────────────────── the ledger ────────────────────────────── */

export type C5Status =
  | "PREDELETE_VERIFIED"
  | "DELETE_REQUESTED"
  | "DELETE_CONFIRMED"
  | "ALREADY_ABSENT"
  | "REFUSED"
  | "FAILED";

/**
 * Append one line, and let a failure to write stop the run.
 *
 * Deliberately not wrapped in try/catch. An irreversible act with no record of
 * what it removed is worse than a full bucket, so if the ledger cannot be
 * written the deletion must not happen — and the only way to guarantee that
 * is to let the throw escape before the DELETE is issued.
 */
function appendLedger(file: string, record: Record<string, unknown>): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`, { flag: "a" });
}

class C5Stopped extends Error {
  constructor(readonly label: string, message: string) {
    super(message);
  }
}

/* ──────────────────────────────── entry point ──────────────────────────── */

async function main() {
  const { batchId, manifestPath } = assertC5Flags(process.argv.slice(2));

  /* ── manifest integrity, before any network call ── */
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifest = parsed as OrphanManifest;
  if (manifest.kind !== C5_MANIFEST_KIND) {
    throw new MigrationRefused(
      `manifest kind is "${manifest.kind}", not "${C5_MANIFEST_KIND}" — this is not a C5 manifest`,
      "wrong_kind");
  }
  assertValidBatchId(manifest.batchId);
  if (manifest.batchId !== batchId) {
    throw new MigrationRefused(
      `manifest is for batch "${manifest.batchId}", not "${batchId}"`, "batch_id_mismatch");
  }
  assertC5BatchSize(manifest.entries.length);
  // Recomputed here, never trusted from the file.
  const selfChecksum = orphanManifestChecksum(
    { batchId: manifest.batchId, entries: manifest.entries }, sha256);
  if (selfChecksum !== manifest.checksum) {
    throw new MigrationRefused("manifest checksum does not match its own contents", "manifest_tampered");
  }
  // Pair coherence, scope, duplicates, and the survivor-also-a-candidate case.
  assertCoherentOrphanManifest(manifest);

  const candidatePaths = new Set(manifest.entries.map((e) => e.candidatePath));

  console.log(`\n  C5 DELETION — batch "${batchId}", ${manifest.entries.length} duplicate orphan(s).`);
  console.log("  THIS IS IRREVERSIBLE. After each delete the twin is the only copy.\n");

  mkdirSync(LEDGER_DIR, { recursive: true });
  const ledgerFile = `${LEDGER_DIR}/c5-deleted-${batchId}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
  console.log(`  ledger: ${ledgerFile}\n`);

  let deleted = 0;
  let reclaimed = 0;

  for (const entry of manifest.entries) {
    const label = entry.candidatePath;
    const record = (status: C5Status, extra: Record<string, unknown> = {}) => ({
      timestamp: new Date().toISOString(), batchId, manifestChecksum: manifest.checksum,
      candidatePath: entry.candidatePath, twinPath: entry.twinPath, status, ...extra,
    });

    try {
      console.log(`  ── ${entry.candidatePath}`);

      // (15) The path guard, run first and again immediately before the call.
      assertC5InScope(entry.candidatePath, entry.twinPath);
      // (12) The twin must not be queued for deletion in this same batch.
      if (candidatePaths.has(entry.twinPath)) {
        throw new C5Stopped(label, `the twin ${entry.twinPath} is itself a candidate in this batch`);
      }

      // (1) A fresh graph and listing for EVERY object, not once per batch.
      const graph = await freshGraph();
      const objects = await listObjects();
      if (!graph.complete) {
        throw new C5Stopped(label, `reference graph incomplete (unreadable: ${graph.unreadable.join(", ")})`);
      }

      // (2) Idempotency: an entry already gone is resolved, never re-deleted,
      // and never treated as licence to delete anything else.
      if (!objects.has(entry.candidatePath)) {
        const head = await objectHead(entry.candidatePath);
        if (!head.ok) {
          appendLedger(ledgerFile, record("ALREADY_ABSENT",
            { note: "candidate was not in the bucket at execution time; nothing was deleted" }));
          console.log("     ALREADY ABSENT — nothing deleted\n");
          continue;
        }
        throw new C5Stopped(label, "candidate is missing from the listing but still readable — ambiguous");
      }

      // (6,7,8) The twin, proved from live state.
      const twinLive = graph.live.get(entry.twinPath) ?? [];
      const twinHead = await objectHead(entry.twinPath);
      const candidateHead = await objectHead(entry.candidatePath);

      // (3,4,5,13) The candidate, proved from live state across ALL tables.
      const candidateLive = graph.live.get(entry.candidatePath) ?? [];
      const candidateHistorical = graph.historical.get(entry.candidatePath) ?? 0;

      // (9,10) Both digests, from live bytes. The strongest available statement
      // that these two files are the same photograph right now.
      const candidateBuffer = await objectBytes(entry.candidatePath);
      if (!candidateBuffer) throw new C5Stopped(label, "the candidate could not be read back for checksumming");
      const twinBuffer = await objectBytes(entry.twinPath);
      if (!twinBuffer) throw new C5Stopped(label, "the twin could not be read back for checksumming");
      const candidateDigest = sha256Bytes(candidateBuffer);
      const twinDigest = sha256Bytes(twinBuffer);

      const candidate: OrphanCandidate = {
        path: entry.candidatePath,
        exists: objects.has(entry.candidatePath) && candidateHead.ok,
        bytes: candidateBuffer.byteLength,
        checksum: candidateDigest,
        liveReferences: candidateLive,
        historicalReferences: candidateHistorical,
        twin: {
          path: entry.twinPath,
          exists: objects.has(entry.twinPath) && twinHead.ok,
          bytes: twinBuffer.byteLength,
          checksum: twinDigest,
          liveReferences: twinLive,
        },
        graphIsComplete: graph.complete,
        auditedHighConfidence: true, // membership was proved when the manifest was planned
      };

      const verdict = classifyOrphan(candidate);
      if (!isC5Eligible(verdict.state)) {
        appendLedger(ledgerFile, record("REFUSED",
          { classification: verdict.state, reason: verdict.reason, blockers: verdict.blockers }));
        throw new C5Stopped(label, `${verdict.state}: ${verdict.reason}`);
      }

      // (14) The world must still match the reviewed plan, not merely be safe.
      if (candidateDigest !== entry.candidateChecksum) {
        throw new C5Stopped(label,
          `live candidate checksum ${candidateDigest.slice(0, 16)}… does not match the manifest`);
      }
      if (twinDigest !== entry.twinChecksum) {
        throw new C5Stopped(label,
          `live twin checksum ${twinDigest.slice(0, 16)}… does not match the manifest`);
      }
      if (candidateBuffer.byteLength !== entry.candidateBytes) {
        throw new C5Stopped(label,
          `live candidate is ${candidateBuffer.byteLength} bytes, manifest says ${entry.candidateBytes}`);
      }
      if (twinBuffer.byteLength !== entry.twinBytes) {
        throw new C5Stopped(label,
          `live twin is ${twinBuffer.byteLength} bytes, manifest says ${entry.twinBytes}`);
      }
      if (twinLive.length !== entry.expectedTwinLiveReferences) {
        throw new C5Stopped(label,
          `twin has ${twinLive.length} live reference(s), manifest expected ${entry.expectedTwinLiveReferences}`);
      }

      // The path guard again, last thing before the call, independent of all
      // the above — this is the check that does not depend on any other check.
      assertC5InScope(entry.candidatePath, entry.twinPath);

      /* ── evidence first, deletion second ── */
      const evidence = {
        timestamp: new Date().toISOString(), batchId, manifestChecksum: manifest.checksum,
        candidatePath: entry.candidatePath,
        candidateBytes: candidateBuffer.byteLength,
        candidateChecksum: candidateDigest,
        candidateLiveReferences: 0,
        candidateHistoricalReferences: 0,
        twinPath: entry.twinPath,
        twinBytes: twinBuffer.byteLength,
        twinChecksum: twinDigest,
        twinLiveReferences: twinLive.length,
        twinLiveReferenceIdentities: twinLive,
        graphComplete: graph.complete,
      };
      // A throw here means no deletion happens. That is the intended ordering.
      appendLedger(ledgerFile, { ...record("PREDELETE_VERIFIED"), evidence });
      console.log(`     verified: 0 live refs, 0 audit refs, twin ${entry.twinPath} has ${twinLive.length} ref(s), digests match`);

      /* ── the delete: exactly one named object ── */
      appendLedger(ledgerFile, record("DELETE_REQUESTED", { target: entry.candidatePath }));
      const response = await fetch(
        `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/${BUCKET}/${entry.candidatePath}`,
        { method: "DELETE", headers: headers() }
      );
      if (!response.ok) {
        const body = await response.text();
        appendLedger(ledgerFile, record("FAILED", { httpStatus: response.status, response: body.slice(0, 500) }));
        throw new C5Stopped(label, `storage delete failed (${response.status})`);
      }

      /* ── prove the outcome, both halves ── */
      const gone = await objectHead(entry.candidatePath);
      if (gone.ok) {
        appendLedger(ledgerFile, record("FAILED", { note: "delete reported success but the candidate still exists" }));
        throw new C5Stopped(label, "delete reported success but the candidate still exists");
      }
      const twinAfter = await objectHead(entry.twinPath);
      if (!twinAfter.ok) {
        appendLedger(ledgerFile, record("FAILED", { note: "TWIN UNREADABLE AFTER DELETE" }));
        throw new C5Stopped(label, "the twin became unreadable after the delete — STOP");
      }
      const graphAfter = await freshGraph();
      const twinRefsAfter = (graphAfter.live.get(entry.twinPath) ?? []).length;
      if (twinRefsAfter < 1) {
        appendLedger(ledgerFile, record("FAILED", { note: "TWIN LOST ITS LAST LIVE REFERENCE", twinRefsAfter }));
        throw new C5Stopped(label, "the twin has no live reference after the delete — STOP");
      }

      appendLedger(ledgerFile, record("DELETE_CONFIRMED", {
        reclaimedBytes: entry.candidateBytes,
        twinStillReadable: true,
        twinLiveReferencesAfter: twinRefsAfter,
      }));
      deleted += 1;
      reclaimed += entry.candidateBytes;
      console.log(`     DELETED — ${MiB(entry.candidateBytes)} MiB reclaimed; twin intact with ${twinRefsAfter} reference(s)\n`);
    } catch (error) {
      // FIRST FAILURE STOPS THE WHOLE BATCH. No continue, no skip, no retry.
      const why = error instanceof C5Stopped ? error.message : String(error);
      console.error(`\n  STOPPED at ${label}: ${why}`);
      console.error(`  ${deleted} object(s) deleted before this point. Nothing further will be attempted.\n`);
      process.exit(1);
    }
  }

  console.log(`  ${deleted}/${manifest.entries.length} deleted, ${MiB(reclaimed)} MiB reclaimed.`);
  console.log("  Every remaining object is untouched. Twins are now the only copy of what was deleted.\n");
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
