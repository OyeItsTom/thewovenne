/**
 * C7 — permanently remove the originals C6 migrated. THIS DELETES BYTES.
 *
 *   npx tsx --env-file=.env.local scripts/c7-reclaim-execute.ts --execute \
 *     --batch-id c7-1 \
 *     --source-manifest reports/c7-reclaim/manifest-c7-1.json \
 *     --yes-i-understand-this-permanently-removes-migrated-originals
 *
 * THERE IS NO ROLLBACK. C6 could always put a row back, because the bytes it
 * pointed away from were still there. Here the bytes are the thing being
 * removed, so every check has to happen BEFORE the delete, and the only
 * response to a surprise is to stop.
 *
 * WHAT IT DELETES. Exactly one named object per entry, and only after proving,
 * against live data, that: C6 migrated it, a person approved that batch, the
 * bytes are still the migrated bytes, nothing live still points at it, and the
 * master that replaced it exists, is readable, is unchanged and still carries
 * the references that were moved to it. Anything else stops the run.
 *
 * WHAT IT NEVER TOUCHES. No database row, ever — this tool sends no PATCH, no
 * POST, no PUT. No cart. No prefix, folder or wildcard. No master. The path
 * guard that runs immediately before each delete is C3's, unchanged.
 *
 * THE SHAPE OF THE RUN. Each original is proven and removed alone:
 *
 *     re-prove A -> PREDELETE_VERIFIED -> DELETE A -> prove A gone
 *       -> prove A's master still healthy and referenced -> DELETE_CONFIRMED
 *       -> then B
 *
 * Nothing is pre-authorised. B's checks run after A is already gone, against
 * live data, because the world may have changed in between.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import sharp from "sharp";
import { MigrationRefused, assertValidBatchId } from "../lib/imageBackfill";
import {
  C7_EXPECTED_NORMALIZER_VERSION,
  C7_FLAGS,
  C7_MANIFEST_KIND,
  assertC7BatchSize,
  assertC7Flags,
  assertCoherentC7Manifest,
  c7ManifestChecksum,
  classifyForC7,
  isC7Eligible,
  isRevertedWithoutReapply,
  readC6MigrationEvidence,
  type C7Candidate,
  type C7Manifest,
} from "../lib/imageC7";
import { assertSafeToDeletePath, type LiveReferenceIdentity } from "../lib/imageDeletion";
import {
  HISTORICAL_REFERENCE_TABLES,
  ImageReferenceGraph,
  LIVE_REFERENCE_TABLES,
  type TableRows,
} from "../lib/imageReferences";
import { enumerateAllObjects, type StorageEntry } from "../lib/storagePrefixes";

const BUCKET = "product-images";
const C6_DIR = "reports/c6-normalize";
const LEDGER_DIR = "reports/c7-reclaim";
const APPROVALS = `${C6_DIR}/APPROVALS.json`;
const REVERTS = `${C6_DIR}/c6-reverts.ndjson`;
const CART_TABLE = "carts";
const SITE_CONTENT_TABLE = "site_content";
const CLASSIFIED = new Set<string>([...LIVE_REFERENCE_TABLES, ...HISTORICAL_REFERENCE_TABLES]);

const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
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

/* ─────────────────────────────── live reads ────────────────────────────── */

/**
 * EVERY table PostgREST exposes. Reading only the classified five would make
 * "nothing references this" a claim about a subset, which is not the claim
 * that authorises removing bytes.
 */
async function freshGraph(): Promise<ImageReferenceGraph> {
  const tables: TableRows[] = [];
  const unreadable: string[] = [];
  let names: string[] = [];
  try {
    const spec = await (await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/`, { headers: headers() })).json();
    names = Object.keys(spec?.paths ?? {})
      .filter((p) => p !== "/" && !p.startsWith("/rpc/")).map((p) => p.slice(1));
  } catch {
    // An unreadable schema means an unknowable reference set. Returning a graph
    // flagged incomplete makes every candidate refuse, which is the intent.
    return new ImageReferenceGraph([], ["<schema>"]);
  }
  if (names.length === 0) return new ImageReferenceGraph([], ["<schema>"]);
  for (const table of names) {
    try {
      const response = await fetch(
        `${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/${table}?select=*`, { headers: headers() });
      if (!response.ok) { unreadable.push(table); continue; }
      const rows = await response.json();
      if (!Array.isArray(rows)) { unreadable.push(table); continue; }
      tables.push({ table, rows });
    } catch { unreadable.push(table); }
  }
  return new ImageReferenceGraph(tables, unreadable);
}

async function listObjects(): Promise<Map<string, number>> {
  const listPage = async (prefix: string, offset: number): Promise<StorageEntry[]> => {
    const response = await fetch(
      `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/list/${BUCKET}`,
      { method: "POST", headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }) });
    const page = await response.json();
    return Array.isArray(page) ? page : [];
  };
  return new Map((await enumerateAllObjects(listPage)).map((o) => [o.key, o.bytes]));
}

async function objectBytes(key: string): Promise<Buffer | null> {
  try {
    const response = await fetch(publicUrl(key));
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch { return null; }
}

async function objectReadable(key: string): Promise<boolean> {
  try { return (await fetch(publicUrl(key), { method: "HEAD" })).ok; } catch { return false; }
}

function approvedBatches(): Set<string> {
  if (!existsSync(APPROVALS)) {
    throw new MigrationRefused(`${APPROVALS} is missing.`, "missing_approvals");
  }
  const parsed = JSON.parse(readFileSync(APPROVALS, "utf8"));
  const approved = new Set<string>();
  for (const e of parsed?.batches ?? []) {
    if (e?.approved === true && typeof e.batchId === "string") approved.add(e.batchId);
  }
  return approved;
}

/** Every C6 ledger record, read fresh at execution time. */
function c6Records(): Array<Record<string, unknown>> {
  const all: Array<Record<string, unknown>> = [];
  if (!existsSync(C6_DIR)) return all;
  for (const file of readdirSync(C6_DIR).filter((f) => /^c6-migrated-.*\.ndjson$/.test(f)).sort()) {
    for (const line of readFileSync(`${C6_DIR}/${file}`, "utf8").trim().split("\n")) {
      if (!line.trim()) continue;
      try { all.push({ ...(JSON.parse(line) as Record<string, unknown>), __file: file }); } catch { /* not evidence */ }
    }
  }
  return all;
}

function revertRecords(): Array<{ action?: unknown; sourcePath?: unknown; timestamp?: unknown }> {
  if (!existsSync(REVERTS)) return [];
  return readFileSync(REVERTS, "utf8").trim().split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
}

/* ─────────────────────────────── the ledger ────────────────────────────── */

export type C7Status =
  | "PREDELETE_VERIFIED" | "DELETE_REQUESTED" | "DELETE_CONFIRMED" | "REFUSED" | "FAILED";

/**
 * Append one line, and let a failure to write stop the run.
 *
 * Not wrapped in try/catch on purpose. A deletion with no record of what was
 * removed is unreconstructable, and unlike C6 there is no way back — so if the
 * ledger cannot be written, the bytes must not be removed.
 */
function appendLedger(file: string, record: Record<string, unknown>): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`, { flag: "a" });
}

class C7Stopped extends Error {
  constructor(readonly label: string, message: string) { super(message); }
}

/* ──────────────────────────────── entry point ──────────────────────────── */

async function main() {
  const { batchId, manifestPath } = assertC7Flags(process.argv.slice(2));

  /* ── manifest integrity, before any network call ── */
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as C7Manifest;
  if (manifest.kind !== C7_MANIFEST_KIND) {
    throw new MigrationRefused(
      `manifest kind is "${manifest.kind}", not "${C7_MANIFEST_KIND}" — this is not a C7 plan`, "wrong_kind");
  }
  assertValidBatchId(manifest.batchId);
  if (manifest.batchId !== batchId) {
    throw new MigrationRefused(
      `manifest is for batch "${manifest.batchId}", not "${batchId}"`, "batch_id_mismatch");
  }
  assertC7BatchSize(manifest.entries.length);
  const selfChecksum = c7ManifestChecksum(
    { batchId: manifest.batchId, normalizerVersion: manifest.normalizerVersion, entries: manifest.entries },
    sha256);
  if (selfChecksum !== manifest.checksum) {
    throw new MigrationRefused("manifest checksum does not match its own contents", "manifest_tampered");
  }
  assertCoherentC7Manifest(manifest);

  console.log(`\n  C7 RECLAIM — batch "${batchId}", ${manifest.entries.length} original(s).`);
  console.log("  THIS PERMANENTLY DELETES BYTES. There is no rollback.\n");

  mkdirSync(LEDGER_DIR, { recursive: true });
  const ledgerFile = `${LEDGER_DIR}/c7-reclaimed-${batchId}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
  console.log(`  ledger: ${ledgerFile}\n`);

  const approved = approvedBatches();
  let deleted = 0;
  let reclaimed = 0;

  for (const entry of manifest.entries) {
    const label = entry.sourcePath;
    const record = (status: C7Status, extra: Record<string, unknown> = {}) => ({
      timestamp: new Date().toISOString(), batchId, manifestChecksum: manifest.checksum,
      sourcePath: entry.sourcePath, masterPath: entry.masterPath, status, ...extra,
    });

    try {
      console.log(`  ── ${entry.sourcePath}`);

      /* ── 1. fresh live revalidation, from scratch ── */
      const graph = await freshGraph();
      const objects = await listObjects();
      if (!graph.isComplete) throw new C7Stopped(label, "reference graph incomplete");

      const records = c6Records();
      const evidence = readC6MigrationEvidence(
        records, entry.sourcePath,
        String(records.find((r) => r.sourcePath === entry.sourcePath)?.__file ?? "unknown"));
      if (isRevertedWithoutReapply(revertRecords(), entry.sourcePath)) {
        throw new C7Stopped(label, "this original was reverted to and never re-applied — it is live");
      }
      if (!evidence) throw new C7Stopped(label, "no complete C6 migration evidence for this original");
      if (evidence.masterPath !== entry.masterPath) {
        throw new C7Stopped(label,
          `evidence pairs it with ${evidence.masterPath}, the manifest says ${entry.masterPath}`);
      }

      const exists = objects.has(entry.sourcePath);
      const sourceBuffer = exists ? await objectBytes(entry.sourcePath) : null;
      const liveChecksum = sourceBuffer ? sha256(sourceBuffer) : null;

      const refs = graph.referencesFor(BUCKET, entry.sourcePath);
      const live = refs.filter((r) => r.live);
      const identity = (r: { table: string; rowId: string; field: string }): LiveReferenceIdentity =>
        ({ table: r.table, rowId: r.rowId, field: r.field });
      const masterRefs = graph.referencesFor(BUCKET, entry.masterPath).filter((r) => r.live).map(identity);

      const masterBuffer = objects.has(entry.masterPath) ? await objectBytes(entry.masterPath) : null;
      let masterDims: string | null = null;
      if (masterBuffer) {
        const meta = await sharp(masterBuffer).metadata();
        masterDims = meta.width && meta.height ? `${meta.width}x${meta.height}` : null;
      }

      const candidate: C7Candidate = {
        sourcePath: entry.sourcePath, sourceUrl: publicUrl(entry.sourcePath),
        sourceBytes: sourceBuffer ? sourceBuffer.byteLength : 0,
        sourceChecksum: liveChecksum, sourceExists: exists,
        evidence, batchApproved: approved.has(evidence.batchId),
        masterExists: objects.has(entry.masterPath),
        masterReadable: masterBuffer !== null,
        masterBytes: masterBuffer ? masterBuffer.byteLength : null,
        masterDimensions: masterDims,
        masterLiveReferences: masterRefs,
        graphIsComplete: graph.isComplete,
        liveReferencesOnSource: live.filter((r) =>
          r.table !== CART_TABLE && r.table !== SITE_CONTENT_TABLE && CLASSIFIED.has(r.table)).map(identity),
        cartReferencesOnSource: live.filter((r) => r.table === CART_TABLE).map(identity),
        siteContentReferencesOnSource: live.filter((r) => r.table === SITE_CONTENT_TABLE).map(identity),
        unknownReferencesOnSource: refs.filter((r) => !CLASSIFIED.has(r.table)).length,
        historicalReferencesOnSource: refs.filter((r) => !r.live).length,
        expectedNormalizerVersion: C7_EXPECTED_NORMALIZER_VERSION,
      };

      const verdict = classifyForC7(candidate);
      if (!isC7Eligible(verdict.state)) {
        appendLedger(ledgerFile, record("REFUSED",
          { classification: verdict.state, reason: verdict.reason, blockers: verdict.blockers }));
        throw new C7Stopped(label, `${verdict.state}: ${verdict.reason}`);
      }

      // The manifest is a plan, not a permission: the bytes must still be the
      // reviewed bytes, and the master must still hold the reviewed references.
      if (candidate.sourceBytes !== entry.sourceBytes || liveChecksum !== entry.sourceChecksum) {
        throw new C7Stopped(label, "the original no longer matches the reviewed manifest");
      }
      const plannedRefs = new Set(entry.expectedMasterReferences.map((r) => `${r.table}/${r.rowId}/${r.field}`));
      const liveRefs = new Set(masterRefs.map((r) => `${r.table}/${r.rowId}/${r.field}`));
      if (plannedRefs.size !== liveRefs.size || [...plannedRefs].some((r) => !liveRefs.has(r))) {
        throw new C7Stopped(label, "the master's live references no longer match the reviewed plan");
      }

      // The path guard: last thing before the call, independent of all above.
      assertSafeToDeletePath(entry.sourcePath, entry.masterPath);

      /* ── 2. evidence first, deletion second ── */
      appendLedger(ledgerFile, {
        ...record("PREDELETE_VERIFIED"),
        evidence: {
          sourceBytes: candidate.sourceBytes, sourceChecksum: liveChecksum,
          masterBytes: candidate.masterBytes, masterDimensions: masterDims,
          normalizerVersion: evidence.normalizerVersion,
          migratedInBatch: evidence.batchId, evidenceLedger: evidence.ledgerFile,
          liveReferencesOnSource: 0,
          liveReferencesOnMaster: masterRefs.length,
          liveReferenceIdentitiesOnMaster: masterRefs,
          historicalReferencesOnSource: candidate.historicalReferencesOnSource,
        },
      });
      console.log(`     verified: 0 live refs, master holds ${masterRefs.length}, checksum matches`);

      /* ── 3. the delete: exactly one named object ── */
      appendLedger(ledgerFile, record("DELETE_REQUESTED", { target: entry.sourcePath }));
      const response = await fetch(
        `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/${BUCKET}/${entry.sourcePath}`,
        { method: "DELETE", headers: headers() });
      const body = await response.text();
      if (!response.ok) {
        appendLedger(ledgerFile, record("FAILED", { httpStatus: response.status, response: body.slice(0, 500) }));
        throw new C7Stopped(label, `storage delete failed (${response.status})`);
      }

      /* ── 4. verify: original gone, master untouched and still referenced ── */
      const after = await listObjects();
      if (after.has(entry.sourcePath)) {
        appendLedger(ledgerFile, record("FAILED",
          { note: "delete reported success but the object is still listed" }));
        throw new C7Stopped(label, "delete reported success but the original still exists");
      }
      if (!(await objectReadable(entry.masterPath))) {
        appendLedger(ledgerFile, record("FAILED", { note: "MASTER UNREADABLE AFTER DELETE" }));
        throw new C7Stopped(label, "the master became unreadable after the delete — STOP");
      }
      const graphAfter = await freshGraph();
      if (!graphAfter.isComplete) throw new C7Stopped(label, "graph became unreadable after the delete");
      const masterRefsAfter = graphAfter.liveReferenceCount(BUCKET, entry.masterPath);
      if (masterRefsAfter !== masterRefs.length) {
        appendLedger(ledgerFile, record("FAILED",
          { note: `master references changed during the delete: ${masterRefs.length} -> ${masterRefsAfter}` }));
        throw new C7Stopped(label, "the master's references changed during the delete");
      }

      appendLedger(ledgerFile, record("DELETE_CONFIRMED", {
        httpStatus: response.status, bytesReclaimed: entry.sourceBytes,
        masterStillReadable: true, masterLiveReferencesAfter: masterRefsAfter,
      }));
      deleted += 1;
      reclaimed += entry.sourceBytes;
      console.log(`     DELETED — ${MiB(entry.sourceBytes)} MiB reclaimed; master intact with ${masterRefsAfter} reference(s)\n`);
    } catch (error) {
      // No rollback exists, so there is nothing to salvage by continuing.
      // Whatever has already been deleted stays deleted and is recorded.
      const why = error instanceof C7Stopped ? error.message : String(error);
      console.error(`\n  STOPPED at ${label}: ${why}`);
      console.error(`  ${deleted} original(s) reclaimed before this point, ${MiB(reclaimed)} MiB.`);
      console.error("  Nothing further will be deleted.\n");
      process.exit(1);
    }
  }

  console.log(`  ${deleted}/${manifest.entries.length} reclaimed, ${MiB(reclaimed)} MiB freed.`);
  console.log("  Every master is intact and still referenced.\n");
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
