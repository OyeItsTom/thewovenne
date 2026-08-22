/**
 * C3 — delete retained originals. THIS SCRIPT IS IRREVERSIBLE.
 *
 * C2 moved every live reference from an original to a normalised master and
 * kept the original, which is why five C2 batches could be run from an
 * unmerged branch: a bad result was undone by pointing rows back. Nothing
 * undoes this. After a successful run the original is gone and the master is
 * the only copy of that photograph in production.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-delete-execute.ts --execute \
 *     --batch-id c3-delete-1 \
 *     --source-manifest reports/image-backfill/manifest-c3-delete-1.json \
 *     --yes-i-understand-original-deletion-is-permanent
 *
 * All four flags are required. The acknowledgement is not C2's, and offering
 * C2's is itself an error rather than a no-op — after five batches of muscle
 * memory, a half-remembered command line is a real way to delete a photograph
 * while believing you are retaining it.
 *
 * THE SHAPE OF THE RUN. Deletion is not batched in the usual sense. Each
 * object is proven and destroyed alone:
 *
 *     re-prove everything about A  ->  write A's evidence  ->  delete A
 *       ->  verify A gone and A's master intact  ->  ledger  ->  then B
 *
 * Nothing is pre-authorised. The seventeen checks for B run after A is already
 * deleted, against live data, because the world may have changed in between —
 * somebody may have put B in a basket while A was being removed. The gap
 * between the last check and the delete is one HTTP call by construction.
 *
 * FIRST FAILURE STOPS EVERYTHING. There is no rollback to attempt and no
 * partial-success path worth continuing down, so anything unexpected — a new
 * reference, a checksum that moved, a ledger that would not write, a delete
 * whose outcome is unclear — ends the batch where it stands.
 *
 * WHAT THIS TOUCHES. It reads the database, reads storage, appends to a local
 * gitignored ledger, and deletes exactly one named object at a time. It issues
 * no PATCH, no POST to any table, and no write to carts or site_content: C2
 * already moved the references, and C3 has no business editing rows.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { MigrationRefused, assertValidBatchId } from "../lib/imageBackfill";
import {
  MANIFEST_KIND,
  assertDeleteFlags,
  assertDeletionBatchSize,
  assertSafeToDeletePath,
  classifyForDeletion,
  deletionManifestChecksum,
  isEligible,
  type DeletionCandidate,
  type DeletionManifest,
  type DeletionStatus,
  type LiveReferenceIdentity,
  type PreDeleteEvidence,
} from "../lib/imageDeletion";
import { NORMALIZER_VERSION } from "../lib/imageNormalize";
import { ImageReferenceGraph, type TableRows } from "../lib/imageReferences";

const BUCKET = "product-images";
const LEDGER_DIR = "reports/image-backfill";
const REFERENCE_TABLES = ["product_images", "products", "product_versions", "site_content", "carts"];

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

/* ─────────────────────────── reads, and only reads ─────────────────────── */

/** Every read of a table is a GET with select=*. Nothing here writes a row. */
async function fetchTables(): Promise<{ tables: TableRows[]; unreadable: string[] }> {
  const tables: TableRows[] = [];
  const unreadable: string[] = [];
  for (const table of REFERENCE_TABLES) {
    const response = await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/${table}?select=*`,
      { headers: headers() });
    if (!response.ok) { unreadable.push(table); continue; }
    const rows = await response.json();
    if (!Array.isArray(rows)) { unreadable.push(table); continue; }
    tables.push({ table, rows });
  }
  return { tables, unreadable };
}

async function freshGraph(): Promise<ImageReferenceGraph> {
  const { tables, unreadable } = await fetchTables();
  return new ImageReferenceGraph(tables, unreadable);
}

async function objectExists(key: string): Promise<boolean> {
  const response = await fetch(publicUrl(key), { method: "HEAD" });
  return response.ok;
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

/* ──────────────────────────── C2 migration evidence ─────────────────────── */

interface LedgerPairing {
  sourcePath: string;
  sourceBytes: number;
  sourceChecksum: string;
  sourceDimensions: string | null;
  sourceFormat: string | null;
  masterPath: string;
  masterBytes: number | null;
  masterDimensions: string | null;
  normalizerVersion: number;
}

/**
 * The only admissible proof that an object is a C2 original.
 *
 * Read from C2's own ledgers, and only rows that both migrated AND verified.
 * A path absent from here is not a C3 candidate at any price — which is what
 * keeps this tool off the 46 pre-existing orphans and the HEIC object. There
 * is no flag that adds a path by hand.
 */
function ledgerPairings(): Map<string, LedgerPairing> {
  const out = new Map<string, LedgerPairing>();
  for (const file of readdirSync(LEDGER_DIR).filter((f) => f.startsWith("executed-") && f.endsWith(".ndjson"))) {
    for (const line of readFileSync(`${LEDGER_DIR}/${file}`, "utf8").trim().split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.status !== "migrated" || row.verification !== "passed") continue;
      if (!row.masterPath || !row.sourceChecksum) continue;
      out.set(row.sourcePath, {
        sourcePath: row.sourcePath, sourceBytes: row.sourceBytes,
        sourceChecksum: row.sourceChecksum, sourceDimensions: row.sourceDimensions ?? null,
        sourceFormat: row.sourceFormat ?? null, masterPath: row.masterPath,
        masterBytes: row.masterBytes ?? null, masterDimensions: row.masterDimensions ?? null,
        normalizerVersion: row.normalizerVersion,
      });
    }
  }
  return out;
}

/* ──────────────────────────── the append-only ledger ────────────────────── */

/**
 * Append one record and force it to disk before returning.
 *
 * Called before the delete request as well as after it, and a throw here stops
 * the batch. Evidence that only exists in memory is not evidence.
 */
function appendLedger(file: string, record: Record<string, unknown>): void {
  mkdirSync(LEDGER_DIR, { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
}

/* ──────────────────────────────── execution ─────────────────────────────── */

class DeletionStopped extends Error {
  constructor(readonly sourcePath: string, message: string) {
    super(message);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { batchId, manifestPath } = assertDeleteFlags(argv);

  /* ── manifest integrity, before anything else ── */
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DeletionManifest;
  if (manifest.kind !== MANIFEST_KIND) {
    throw new MigrationRefused(
      `manifest kind is "${manifest.kind}", not "${MANIFEST_KIND}" — this is not a C3 deletion manifest`,
      "wrong_kind");
  }
  assertDeletionBatchSize(manifest.entries.length);
  assertValidBatchId(manifest.batchId);
  if (manifest.batchId !== batchId) {
    throw new MigrationRefused(
      `manifest is for batch "${manifest.batchId}", not "${batchId}"`, "batch_id_mismatch");
  }
  if (manifest.normalizerVersion !== NORMALIZER_VERSION) {
    throw new MigrationRefused("manifest was built by a different normalizer version", "version_mismatch");
  }
  // Recomputed here, never trusted from the file.
  const selfChecksum = deletionManifestChecksum(
    { batchId: manifest.batchId, normalizerVersion: manifest.normalizerVersion, entries: manifest.entries },
    sha256);
  if (selfChecksum !== manifest.checksum) {
    throw new MigrationRefused("manifest checksum does not match its own contents", "manifest_tampered");
  }
  const paths = manifest.entries.map((e) => e.sourcePath);
  if (new Set(paths).size !== paths.length) {
    throw new MigrationRefused("manifest contains duplicate source paths", "duplicate_entries");
  }

  const pairings = ledgerPairings();
  const ledgerFile = `${LEDGER_DIR}/deleted-${batchId}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;

  console.log(`\n  C3 DELETION — batch "${batchId}", ${manifest.entries.length} original(s).`);
  console.log("  THIS IS IRREVERSIBLE. After each delete the master is the only copy.\n");
  console.log(`  ledger: ${ledgerFile}\n`);

  let deleted = 0;
  let reclaimed = 0;

  for (const entry of manifest.entries) {
    const label = entry.sourcePath;
    console.log(`  ── ${label}`);

    const record = (status: DeletionStatus, extra: Record<string, unknown> = {}) => ({
      timestamp: new Date().toISOString(), batchId, manifestChecksum: manifest.checksum,
      sourcePath: entry.sourcePath, status, ...extra,
    });

    try {
      /* ── the seventeen checks, on live data, for THIS object only ── */
      const pairing = pairings.get(entry.sourcePath);
      if (!pairing) {
        throw new DeletionStopped(label, "no verified C2 ledger row — not a proven C2 original");
      }
      if (pairing.masterPath !== entry.masterPath) {
        throw new DeletionStopped(label,
          `manifest pairs this with ${entry.masterPath}, the C2 ledger says ${pairing.masterPath}`);
      }
      if (pairing.sourceBytes !== entry.sourceBytes || pairing.sourceChecksum !== entry.sourceChecksum) {
        throw new DeletionStopped(label, "manifest disagrees with the C2 ledger about the source");
      }

      const graph = await freshGraph();
      const refs = graph.referencesFor(BUCKET, entry.sourcePath);
      const live = refs.filter((r) => r.live);
      const historical = refs.filter((r) => !r.live);

      const sourceHead = await objectHead(entry.sourcePath);
      const masterHead = await objectHead(entry.masterPath);

      const candidate: DeletionCandidate = {
        sourcePath: entry.sourcePath, sourceUrl: publicUrl(entry.sourcePath),
        sourceBytes: entry.sourceBytes, sourceExists: sourceHead.ok, sourceFormat: pairing.sourceFormat,
        masterPath: entry.masterPath, masterUrl: publicUrl(entry.masterPath),
        masterExists: masterHead.ok, masterReadable: masterHead.ok,
        masterNormalizerVersion: pairing.normalizerVersion,
        expectedNormalizerVersion: NORMALIZER_VERSION,
        masterLiveReferences: graph.liveReferenceCount(BUCKET, entry.masterPath),
        ledgerVerified: true, graphIsComplete: graph.isComplete,
        liveReferencesOnSource: live.map((r) => ({ table: r.table, rowId: r.rowId, field: r.field })),
        historicalReferencesOnSource: historical.length,
        unknownReferencesOnSource: 0,
      };

      // Idempotency: an original already absent is not a fresh deletion and not
      // a failure. It is recorded and skipped, and nothing is deleted in its
      // place. Re-running a completed batch is therefore a no-op.
      if (!sourceHead.ok) {
        console.log("     ALREADY ABSENT — recorded, nothing deleted");
        appendLedger(ledgerFile, record("ALREADY_ABSENT", {
          note: "source was not present; no deletion attempted", bytesReclaimed: 0,
        }));
        continue;
      }

      const verdict = classifyForDeletion(candidate);
      if (!isEligible(verdict.state)) {
        appendLedger(ledgerFile, record("REFUSED", {
          classification: verdict.state, reason: verdict.reason, blockers: verdict.blockers,
        }));
        throw new DeletionStopped(label, `${verdict.state}: ${verdict.reason}`);
      }
      if (sourceHead.bytes !== null && sourceHead.bytes !== entry.sourceBytes) {
        throw new DeletionStopped(label,
          `live source is ${sourceHead.bytes} bytes, manifest says ${entry.sourceBytes}`);
      }
      if (candidate.masterLiveReferences !== entry.expectedLiveReferencesOnMaster) {
        throw new DeletionStopped(label,
          `master has ${candidate.masterLiveReferences} live reference(s), manifest expected ${entry.expectedLiveReferencesOnMaster}`);
      }

      // The digest, from live bytes. The strongest statement available that
      // this is the photograph C2 migrated and somebody reviewed.
      const bytes = await objectBytes(entry.sourcePath);
      if (!bytes) throw new DeletionStopped(label, "the source could not be read back for checksumming");
      const digest = sha256Bytes(bytes);
      if (digest !== entry.sourceChecksum) {
        throw new DeletionStopped(label,
          `live source checksum ${digest.slice(0, 16)}… does not match the manifest`);
      }

      // The path guard: last thing before the call, independent of all above.
      assertSafeToDeletePath(entry.sourcePath, entry.masterPath);

      /* ── evidence first, deletion second ── */
      const masterRefIdentities: LiveReferenceIdentity[] = graph
        .referencesFor(BUCKET, entry.masterPath).filter((r) => r.live)
        .map((r) => ({ table: r.table, rowId: r.rowId, field: r.field }));

      const evidence: PreDeleteEvidence = {
        timestamp: new Date().toISOString(), batchId, manifestChecksum: manifest.checksum,
        sourcePath: entry.sourcePath, sourceBytes: entry.sourceBytes, sourceChecksum: digest,
        sourceDimensions: pairing.sourceDimensions, masterPath: entry.masterPath,
        masterBytes: masterHead.bytes, masterDimensions: pairing.masterDimensions,
        normalizerVersion: pairing.normalizerVersion, liveReferencesOnSource: 0,
        liveReferenceIdentitiesOnMaster: masterRefIdentities,
        liveReferencesOnMaster: candidate.masterLiveReferences,
        historicalReferencesOnSource: historical.length,
      };
      // A throw here means no deletion happens. That is the intended ordering.
      appendLedger(ledgerFile, { ...record("PREDELETE_VERIFIED"), evidence });
      console.log(`     verified: 0 live refs, master has ${candidate.masterLiveReferences}, checksum matches`);

      /* ── the delete: exactly one named object ── */
      appendLedger(ledgerFile, record("DELETE_REQUESTED", { target: entry.sourcePath }));
      const response = await fetch(
        `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/${BUCKET}/${entry.sourcePath}`,
        { method: "DELETE", headers: headers() }
      );
      const body = await response.text();
      if (!response.ok) {
        appendLedger(ledgerFile, record("FAILED", { httpStatus: response.status, response: body.slice(0, 500) }));
        throw new DeletionStopped(label, `storage delete failed (${response.status})`);
      }

      /* ── verify: source gone, master untouched ── */
      const stillThere = await objectExists(entry.sourcePath);
      if (stillThere) {
        appendLedger(ledgerFile, record("FAILED", {
          httpStatus: response.status, note: "delete reported success but the object is still readable",
        }));
        throw new DeletionStopped(label, "delete reported success but the source still exists");
      }
      const masterAfter = await objectHead(entry.masterPath);
      if (!masterAfter.ok) {
        appendLedger(ledgerFile, record("FAILED", { note: "MASTER UNREADABLE AFTER DELETE" }));
        throw new DeletionStopped(label, "the master became unreadable after the delete — STOP");
      }
      const graphAfter = await freshGraph();
      const masterRefsAfter = graphAfter.liveReferenceCount(BUCKET, entry.masterPath);
      if (masterRefsAfter !== candidate.masterLiveReferences) {
        appendLedger(ledgerFile, record("FAILED", {
          note: `master references moved during the delete: ${candidate.masterLiveReferences} -> ${masterRefsAfter}`,
        }));
        throw new DeletionStopped(label, "the master's references changed during the delete");
      }

      appendLedger(ledgerFile, record("DELETE_CONFIRMED", {
        httpStatus: response.status, bytesReclaimed: entry.sourceBytes,
        masterStillReadable: true, masterLiveReferencesAfter: masterRefsAfter,
      }));
      deleted++;
      reclaimed += entry.sourceBytes;
      console.log(`     DELETED — ${MiB(entry.sourceBytes)} MiB reclaimed; master intact with ${masterRefsAfter} reference(s)`);
    } catch (error) {
      // No rollback exists, so there is nothing to try and nothing to salvage
      // by continuing. Whatever has already been deleted stays deleted and is
      // recorded; the rest of the batch does not happen.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n     STOPPED: ${message}`);
      console.error(`\n  Batch halted on ${label}. ${deleted} original(s) deleted before this point.`);
      console.error("  Nothing further will be attempted. Review the ledger before re-running.\n");
      process.exit(1);
    }
  }

  console.log(`\n  ${deleted}/${manifest.entries.length} deleted, ${MiB(reclaimed)} MiB reclaimed.`);
  console.log("  Every remaining original is untouched. Masters are now the only copy of what was deleted.\n");
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
