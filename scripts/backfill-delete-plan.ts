/**
 * C3 PLANNER — READ-ONLY. Decides what could eventually be deleted, and
 * deletes nothing.
 *
 * THIS SCRIPT HAS NO DELETION PATH. It contains no `.remove(`, no `.delete(`,
 * no HTTP DELETE, no --execute flag of any kind, and constructs no supabase-js
 * client. It reads production and writes one local manifest under the
 * gitignored reports/ directory. The test asserts all of that by reading this
 * source, so adding a destructive call here fails the suite.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-delete-plan.ts \
 *     --batch-id c3-delete-1
 *
 * What it does: rebuilds the live reference graph, pairs every C2-migrated
 * original with the master its ledger row names, re-proves every eligibility
 * condition against fresh data, classifies each original, and writes the
 * eligible ones into a checksummed manifest for review.
 *
 * Eligibility lives in lib/imageDeletion.ts, not here.
 *
 * The manifest carries no `executable` flag. It used to, always false, meaning
 * "this PR cannot delete" — a claim about the build rather than the batch, and
 * one that stopped being true when the executor shipped. Execution authority is
 * the executor's command line plus the checks it re-runs against live data; see
 * the note above DeletionManifest in lib/imageDeletion.ts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  assertValidBatchId,
  manifestPathFor,
  writeManifestExclusive,
  MigrationRefused,
} from "../lib/imageBackfill";
import {
  MANIFEST_KIND,
  MAX_DELETION_BATCH,
  isDeletionLedgerName,
  validateDeletionEvidence,
  type RawLedgerRecord,
  type ValidatedDeletion,
  classifyForDeletion,
  deletionManifestChecksum,
  isEligible,
  type C3State,
  type DeletionCandidate,
  type DeletionManifest,
  type DeletionManifestEntry,
  type LiveReferenceIdentity,
} from "../lib/imageDeletion";
import { NORMALIZER_VERSION } from "../lib/imageNormalize";
import { ImageReferenceGraph, type TableRows } from "../lib/imageReferences";

const BATCH_ID_FLAG = "--batch-id";
const BUCKET = "product-images";
const LEDGER_DIR = "reports/image-backfill";

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
const headers = () => ({
  apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
  Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
});
const rest = (path: string) => fetch(env("NEXT_PUBLIC_SUPABASE_URL") + path, { headers: headers() });
const publicUrl = (key: string) =>
  `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${key}`;

/* ─────────────────────────────── production reads ───────────────────────── */

const REFERENCE_TABLES = ["product_images", "products", "product_versions", "site_content", "carts"];

async function fetchTables(): Promise<{ tables: TableRows[]; unreadable: string[] }> {
  const tables: TableRows[] = [];
  const unreadable: string[] = [];
  for (const table of REFERENCE_TABLES) {
    const response = await rest(`/rest/v1/${table}?select=*`);
    if (!response.ok) { unreadable.push(table); continue; }
    const rows = await response.json();
    if (!Array.isArray(rows)) { unreadable.push(table); continue; }
    tables.push({ table, rows });
  }
  return { tables, unreadable };
}

async function listObjects(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const prefix of ["products/", "styles/", "lookbook/", "staging/", "tmp/"]) {
    for (let offset = 0; ; offset += 100) {
      const response = await fetch(
        `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/list/${BUCKET}`,
        { method: "POST", headers: { ...headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }) }
      );
      const page = await response.json();
      if (!Array.isArray(page) || page.length === 0) break;
      for (const o of page) if (o.id) out.set(`${prefix}${o.name}`, o.metadata?.size ?? 0);
      if (page.length < 100) break;
    }
  }
  return out;
}

/** HEAD only. Reading a master back is proof it is servable; it downloads nothing. */
async function readable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

/* ──────────────────────────────── the C2 ledgers ────────────────────────── */

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
 * What C2 actually did, read from its own ledgers.
 *
 * This is the only admissible evidence that an original has a master: a row
 * with status "migrated" AND verification "passed". A source that failed, or
 * that no ledger mentions, is not a C3 candidate at all — which is what keeps
 * this tool off the pre-existing orphans.
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
        sourcePath: row.sourcePath,
        sourceBytes: row.sourceBytes,
        sourceChecksum: row.sourceChecksum,
        sourceDimensions: row.sourceDimensions ?? null,
        sourceFormat: row.sourceFormat ?? null,
        masterPath: row.masterPath,
        masterBytes: row.masterBytes ?? null,
        masterDimensions: row.masterDimensions ?? null,
        normalizerVersion: row.normalizerVersion,
      });
    }
  }
  return out;
}

/* ─────────────────────── deletion evidence, read defensively ───────────── */

/**
 * Load the append-only deletion ledgers, without trusting them.
 *
 * These files are historical evidence and are never modified here — only read,
 * line by line, with every parse failure discarded rather than repaired. A
 * record that cannot be parsed is not a record; a file whose name does not
 * match the executor's own pattern is not a ledger. Nothing in the contents is
 * ever used as a path, a command, or anything but data to compare.
 */
function deletionLedgerRecords(): Map<string, { records: RawLedgerRecord[]; file: string }> {
  const out = new Map<string, { records: RawLedgerRecord[]; file: string }>();
  for (const file of readdirSync(LEDGER_DIR)) {
    if (!isDeletionLedgerName(file)) continue;
    let text: string;
    try {
      text = readFileSync(`${LEDGER_DIR}/${file}`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: RawLedgerRecord;
      try {
        row = JSON.parse(line) as RawLedgerRecord;
      } catch {
        continue; // a malformed line proves nothing
      }
      if (typeof row !== "object" || row === null) continue;
      const key = row.sourcePath;
      if (typeof key !== "string" || key.length === 0) continue;
      const bucketed = out.get(key) ?? { records: [], file };
      bucketed.records.push(row);
      out.set(key, bucketed);
    }
  }
  return out;
}

/* ──────────────────────────────── entry point ───────────────────────────── */

const MiB = (n: number) => (n / 1048576).toFixed(2);

async function main() {
  const argv = process.argv.slice(2);
  // Same identity discipline as C2: the batch id is required, validated, and
  // fixed at generation time. No autogenerated names.
  const explicit = argv[argv.indexOf(BATCH_ID_FLAG) + 1];
  if (!argv.includes(BATCH_ID_FLAG) || !explicit) {
    throw new MigrationRefused(
      `${BATCH_ID_FLAG} <id> is required, e.g. ${BATCH_ID_FLAG} c3-delete-1.`,
      "missing_batch_id"
    );
  }
  const batchId = assertValidBatchId(explicit);

  console.log("\n  C3 PLAN ONLY — READ-ONLY. This tool has no deletion path.\n");

  const { tables, unreadable } = await fetchTables();
  const graph = new ImageReferenceGraph(tables, unreadable);
  const objects = await listObjects();
  const pairings = ledgerPairings();
  const deletionLedgers = deletionLedgerRecords();
  // Evidence is validated against what C2 recorded, never accepted on its own.
  const deletionProof = (p: LedgerPairing): ValidatedDeletion | null => {
    const found = deletionLedgers.get(p.sourcePath);
    if (!found) return null;
    return validateDeletionEvidence(found.records, {
      sourcePath: p.sourcePath, sourceBytes: p.sourceBytes, sourceChecksum: p.sourceChecksum,
      masterPath: p.masterPath, normalizerVersion: p.normalizerVersion,
    }, found.file);
  };

  const bucketBytes = [...objects.values()].reduce((s, b) => s + b, 0);
  const masters = [...objects.keys()].filter((k) => /-v\d+\.(jpg|webp|png)$/i.test(k));
  console.log(`  bucket                 ${objects.size} objects   ${(bucketBytes / 1073741824).toFixed(4)} GiB`);
  console.log(`  normalised masters     ${masters.length}`);
  console.log(`  C2 migrated originals  ${pairings.size}   (from ${readdirSync(LEDGER_DIR).filter((f) => f.startsWith("executed-")).length} ledgers)`);
  console.log(`  graph complete         ${graph.isComplete}${unreadable.length ? ` (unreadable: ${unreadable.join(", ")})` : ""}\n`);

  const verdicts: Array<{ pairing: LedgerPairing; candidate: DeletionCandidate; state: C3State; reason: string; blockers: LiveReferenceIdentity[] }> = [];

  for (const pairing of [...pairings.values()].sort((a, b) => b.sourceBytes - a.sourceBytes)) {
    const sourceUrl = publicUrl(pairing.sourcePath);
    const masterUrl = publicUrl(pairing.masterPath);
    const refs = graph.referencesFor(BUCKET, pairing.sourcePath);
    const live = refs.filter((r) => r.live);
    const historical = refs.filter((r) => !r.live);

    const candidate: DeletionCandidate = {
      sourcePath: pairing.sourcePath,
      sourceUrl,
      sourceBytes: pairing.sourceBytes,
      sourceExists: objects.has(pairing.sourcePath),
      sourceFormat: pairing.sourceFormat,
      masterPath: pairing.masterPath,
      masterUrl,
      masterExists: objects.has(pairing.masterPath),
      masterReadable: objects.has(pairing.masterPath) ? await readable(masterUrl) : false,
      masterNormalizerVersion: pairing.normalizerVersion,
      expectedNormalizerVersion: NORMALIZER_VERSION,
      masterLiveReferences: graph.liveReferenceCount(BUCKET, pairing.masterPath),
      ledgerVerified: true,
      deletionEvidence: deletionProof(pairing),
      graphIsComplete: graph.isComplete,
      liveReferencesOnSource: live.map((r) => ({ table: r.table, rowId: r.rowId, field: r.field })),
      historicalReferencesOnSource: historical.length,
      unknownReferencesOnSource: 0,
    };
    const verdict = classifyForDeletion(candidate);
    verdicts.push({ pairing, candidate, ...verdict });
  }

  /* ── report ── */
  const byState = new Map<C3State, typeof verdicts>();
  for (const v of verdicts) byState.set(v.state, [...(byState.get(v.state) ?? []), v]);

  console.log("  ── classification ──\n");
  for (const [state, group] of [...byState.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const bytes = group.reduce((s, v) => s + v.pairing.sourceBytes, 0);
    console.log(`  ${state.padEnd(32)} ${String(group.length).padStart(3)}   ${MiB(bytes).padStart(9)} MiB`);
  }

  // Already done is not the same as in the way. C3_DELETED is finished work and
  // is reported as such, apart from the things still standing between an
  // original and its deletion.
  const done = verdicts.filter((v) => v.state === "C3_DELETED");
  if (done.length) {
    console.log("\n  ── already deleted by C3 (terminal, not reclaimable again) ──\n");
    for (const v of done) {
      console.log(`  ${v.pairing.sourcePath}  (${MiB(v.pairing.sourceBytes)} MiB reclaimed)`);
      console.log(`     ${v.reason}`);
    }
  }

  const blocked = verdicts.filter((v) => !isEligible(v.state) && v.state !== "C3_DELETED");
  if (blocked.length) {
    console.log("\n  ── blocked, with the reason ──\n");
    for (const v of blocked) {
      console.log(`  ${v.state}  ${v.pairing.sourcePath}  (${MiB(v.pairing.sourceBytes)} MiB)`);
      console.log(`     ${v.reason}`);
      for (const b of v.blockers) console.log(`     blocker: ${b.table}/${b.rowId} .${b.field}`);
    }
  }

  const eligible = verdicts.filter((v) => isEligible(v.state));
  const eligibleBytes = eligible.reduce((s, v) => s + v.pairing.sourceBytes, 0);
  const doneBytes = done.reduce((s, v) => s + v.pairing.sourceBytes, 0);
  console.log(`\n  ELIGIBLE  ${eligible.length} original(s), ${MiB(eligibleBytes)} MiB still reclaimable.`);
  if (done.length) {
    console.log(`  DELETED   ${done.length} original(s), ${MiB(doneBytes)} MiB already reclaimed by C3.`);
  }

  /* ── manifest: only the first MAX_DELETION_BATCH, largest first ── */
  const chosen = eligible.slice(0, MAX_DELETION_BATCH);
  const entries: DeletionManifestEntry[] = chosen.map((v) => ({
    sourcePath: v.pairing.sourcePath,
    sourceBytes: v.pairing.sourceBytes,
    sourceChecksum: v.pairing.sourceChecksum,
    masterPath: v.pairing.masterPath,
    expectedLiveReferencesOnSource: v.candidate.liveReferencesOnSource.length,
    expectedLiveReferencesOnMaster: v.candidate.masterLiveReferences,
    historicalReferencesOnSource: v.candidate.historicalReferencesOnSource,
  }));

  if (entries.length === 0) {
    console.log("\n  Nothing is eligible. No manifest written.\n");
    return;
  }

  const manifest: DeletionManifest = {
    kind: MANIFEST_KIND,
    batchId, createdAt: new Date().toISOString(), normalizerVersion: NORMALIZER_VERSION,
    entries,
    checksum: deletionManifestChecksum({ batchId, normalizerVersion: NORMALIZER_VERSION, entries }, sha256),
  };
  mkdirSync(LEDGER_DIR, { recursive: true });
  const path = manifestPathFor(batchId);
  writeManifestExclusive(path, manifest as never, (p, data) =>
    writeFileSync(p, data, { flag: "wx" }));

  console.log(`\n  proposed first C3 batch: ${entries.length} original(s), ${MiB(entries.reduce((s, e) => s + e.sourceBytes, 0))} MiB`);
  for (const e of entries) console.log(`    ${e.sourcePath}  ${MiB(e.sourceBytes)} MiB  ->  ${e.masterPath}`);
  console.log(`\n  manifest: ${path}`);
  console.log(`  checksum: ${manifest.checksum}`);
  // This planner still cannot delete anything. The executor can, and lives in
  // scripts/backfill-delete-execute.ts — so the banner says what is true of
  // THIS tool rather than making a claim about the repository it ships in.
  console.log("\n  This tool has deleted nothing. Executing the batch is a separate,");
  console.log("  irreversible step: scripts/backfill-delete-execute.ts\n");
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
