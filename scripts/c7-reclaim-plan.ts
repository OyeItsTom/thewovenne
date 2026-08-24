/**
 * C7 PLANNER — READ-ONLY. Decides which C6 originals could be reclaimed, and
 * changes nothing.
 *
 * THIS SCRIPT HAS NO WRITE PATH TO PRODUCTION. It contains no `.remove(`, no
 * HTTP DELETE, no PATCH, no storage upload. It reads production and C6's
 * ledgers, and writes one local manifest under the gitignored reports/
 * directory. The test suite asserts all of that by reading this source.
 *
 *   npx tsx --env-file=.env.local scripts/c7-reclaim-plan.ts --batch-id c7-1
 *
 * WHAT IT PROVES. For every original C6 recorded as migrated, it re-derives the
 * argument from live data rather than trusting the ledger: the object still
 * exists, its bytes and digest still match what was migrated, the master it was
 * paired with still exists and still carries the references that were moved to
 * it, nothing live points at the original any more, and a person has approved
 * the batch it came from. The ledger bounds the scope; an entry still has to
 * earn its place.
 *
 * Eligibility lives in lib/imageC7.ts, not here.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { MigrationRefused, assertValidBatchId } from "../lib/imageBackfill";
import {
  C7_EXPECTED_NORMALIZER_VERSION,
  C7_MANIFEST_KIND,
  MAX_C7_DELETE_BATCH,
  assertCoherentC7Manifest,
  c7ManifestChecksum,
  classifyForC7,
  isC7Eligible,
  isRevertedWithoutReapply,
  readC6MigrationEvidence,
  type C7Candidate,
  type C7Manifest,
  type C7ManifestEntry,
  type C7State,
} from "../lib/imageC7";
import { type LiveReferenceIdentity } from "../lib/imageDeletion";
import {
  HISTORICAL_REFERENCE_TABLES,
  ImageReferenceGraph,
  LIVE_REFERENCE_TABLES,
  type TableRows,
} from "../lib/imageReferences";
import { enumerateAllObjects, type StorageEntry } from "../lib/storagePrefixes";

const BATCH_ID_FLAG = "--batch-id";
const BUCKET = "product-images";
const C6_DIR = "reports/c6-normalize";
const REPORT_DIR = "reports/c7-reclaim";
const APPROVALS = `${C6_DIR}/APPROVALS.json`;
const REVERTS = `${C6_DIR}/c6-reverts.ndjson`;
const CART_TABLE = "carts";
const SITE_CONTENT_TABLE = "site_content";
const CLASSIFIED = new Set<string>([...LIVE_REFERENCE_TABLES, ...HISTORICAL_REFERENCE_TABLES]);

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
const sha256Bytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MiB = (n: number) => (n / 1048576).toFixed(2);
const GiB = (n: number) => (n / 1073741824).toFixed(4);

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

/**
 * EVERY table PostgREST exposes, not just the five that are classified.
 *
 * "Nothing references this object" is the claim that authorises a delete, and
 * it cannot be made from a subset. A reference living in a table nobody has
 * classified has to be SEEN before it can be called unknown — reading only the
 * known tables would report zero and mean nothing.
 */
async function fetchTables(): Promise<{ tables: TableRows[]; unreadable: string[]; names: string[] }> {
  const tables: TableRows[] = [];
  const unreadable: string[] = [];
  let names: string[] = [];
  try {
    const spec = await (await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/`, { headers: headers() })).json();
    names = Object.keys(spec?.paths ?? {})
      .filter((p) => p !== "/" && !p.startsWith("/rpc/")).map((p) => p.slice(1));
  } catch {
    throw new MigrationRefused(
      "the PostgREST schema could not be read, so the set of reference tables is unknown",
      "schema_unreadable");
  }
  if (names.length === 0) {
    throw new MigrationRefused("PostgREST exposed no tables", "schema_unreadable");
  }
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
  return { tables, unreadable, names };
}

async function listAll(): Promise<Map<string, number>> {
  const listPage = async (prefix: string, offset: number): Promise<StorageEntry[]> => {
    const response = await fetch(
      `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/list/${BUCKET}`,
      { method: "POST", headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }) }
    );
    const page = await response.json();
    return Array.isArray(page) ? page : [];
  };
  return new Map((await enumerateAllObjects(listPage)).map((o) => [o.key, o.bytes]));
}

async function digest(key: string): Promise<string | null> {
  try {
    const response = await fetch(publicUrl(key));
    if (!response.ok) return null;
    return sha256Bytes(Buffer.from(await response.arrayBuffer()));
  } catch { return null; }
}

async function readable(key: string): Promise<boolean> {
  try { return (await fetch(publicUrl(key), { method: "HEAD" })).ok; } catch { return false; }
}

/** Display dimensions of a stored object, without decoding the whole file. */
async function masterDimensions(key: string): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    const response = await fetch(publicUrl(key));
    if (!response.ok) return null;
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    if (!meta.width || !meta.height) return null;
    return `${meta.width}x${meta.height}`;
  } catch { return null; }
}

/**
 * Which C6 batches a person has signed off.
 *
 * C7 will not reclaim on the strength of a machine's own record that it did
 * the work. Approval is a separate, human, file-backed fact, and its absence
 * is a refusal rather than a default.
 */
function approvedBatches(): Set<string> {
  if (!existsSync(APPROVALS)) {
    throw new MigrationRefused(
      `${APPROVALS} is missing — C7 will not reclaim without a record of which batches were approved.`,
      "missing_approvals");
  }
  const parsed = JSON.parse(readFileSync(APPROVALS, "utf8"));
  const approved = new Set<string>();
  for (const entry of parsed?.batches ?? []) {
    if (entry?.approved === true && typeof entry.batchId === "string") approved.add(entry.batchId);
  }
  if (approved.size === 0) {
    throw new MigrationRefused(`${APPROVALS} records no approved batch.`, "no_approved_batches");
  }
  return approved;
}

/** Every C6 MIGRATED record, from every C6 ledger. */
function c6Evidence() {
  const found = new Map<string, ReturnType<typeof readC6MigrationEvidence>>();
  if (!existsSync(C6_DIR)) {
    throw new MigrationRefused(`${C6_DIR} is missing — there is no migration to reclaim from.`, "no_ledgers");
  }
  const ledgers = readdirSync(C6_DIR).filter((f) => /^c6-migrated-.*\.ndjson$/.test(f)).sort();
  if (ledgers.length === 0) {
    throw new MigrationRefused(`${C6_DIR} holds no C6 migration ledger.`, "no_ledgers");
  }
  // Every source named anywhere, then evidence read across ALL ledgers at once
  // so a REFUSED line in one file cannot be hidden by a MIGRATED line in another.
  const all: Array<Record<string, unknown>> = [];
  const perFile = new Map<string, string>();
  for (const file of ledgers) {
    for (const line of readFileSync(`${C6_DIR}/${file}`, "utf8").trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        all.push(record);
        if (typeof record.sourcePath === "string") perFile.set(record.sourcePath, file);
      } catch { /* an unparseable line is not evidence */ }
    }
  }
  for (const sourcePath of new Set(all.map((r) => r.sourcePath).filter((s): s is string => typeof s === "string"))) {
    found.set(sourcePath, readC6MigrationEvidence(all, sourcePath, perFile.get(sourcePath) ?? "unknown"));
  }
  return found;
}

/**
 * Sources already committed to an earlier C7 manifest.
 *
 * Manifests are prepared as a sequence and reviewed before any of them runs,
 * so the same original must not appear in two of them. Without this, planning
 * c7-2 straight after c7-1 proposes the identical five: the eligibility that
 * qualified them has not changed yet, because nothing has been deleted.
 */
function alreadyPlanned(): Set<string> {
  const planned = new Set<string>();
  if (!existsSync(REPORT_DIR)) return planned;
  for (const file of readdirSync(REPORT_DIR).filter((f) => /^manifest-.*\.json$/.test(f))) {
    try {
      const m = JSON.parse(readFileSync(`${REPORT_DIR}/${file}`, "utf8")) as C7Manifest;
      if (m?.kind !== C7_MANIFEST_KIND) continue;
      for (const e of m.entries ?? []) {
        if (typeof e?.sourcePath === "string") planned.add(e.sourcePath);
      }
    } catch { /* an unreadable manifest reserves nothing */ }
  }
  return planned;
}

function revertRecords(): Array<{ action?: unknown; sourcePath?: unknown; timestamp?: unknown }> {
  if (!existsSync(REVERTS)) return [];
  return readFileSync(REVERTS, "utf8").trim().split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
}

/* ──────────────────────────────── entry point ──────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const explicit = argv[argv.indexOf(BATCH_ID_FLAG) + 1];
  if (!argv.includes(BATCH_ID_FLAG) || !explicit) {
    throw new MigrationRefused(`${BATCH_ID_FLAG} <id> is required, e.g. ${BATCH_ID_FLAG} c7-1.`, "missing_batch_id");
  }
  const batchId = assertValidBatchId(explicit);

  console.log("\n  C7 PLAN ONLY — READ-ONLY. This tool has no deletion path.\n");

  const approved = approvedBatches();
  const evidence = c6Evidence();
  const reverts = revertRecords();
  const { tables, unreadable, names } = await fetchTables();
  const graph = new ImageReferenceGraph(tables, unreadable);
  const unclassified = names.filter((t) => !CLASSIFIED.has(t));
  const objects = await listAll();

  const bucketBytes = [...objects.values()].reduce((s, b) => s + b, 0);
  console.log(`  bucket                 ${objects.size} objects   ${GiB(bucketBytes)} GiB`);
  console.log(`  C6 migration records   ${evidence.size}`);
  console.log(`  approved C6 batches    ${[...approved].sort().join(", ")}`);
  console.log(`  tables read            ${tables.length}/${names.length}${unreadable.length ? ` (unreadable: ${unreadable.join(", ")})` : ""}`);
  console.log(`  unclassified tables    ${unclassified.length}${unclassified.length ? ` (${unclassified.join(", ")})` : ""}`);
  console.log(`  graph complete         ${graph.isComplete}\n`);

  const verdicts: Array<{ path: string; state: C7State; reason: string; bytes: number; entry: C7ManifestEntry | null }> = [];

  for (const [sourcePath, ev] of [...evidence.entries()].sort()) {
    const refs = graph.referencesFor(BUCKET, sourcePath);
    const live = refs.filter((r) => r.live);
    const identity = (r: { table: string; rowId: string; field: string }): LiveReferenceIdentity =>
      ({ table: r.table, rowId: r.rowId, field: r.field });

    // A source reverted and never re-applied keeps its MIGRATED line but is
    // being served right now. Treated as no evidence at all.
    const reverted = isRevertedWithoutReapply(reverts, sourcePath);

    const masterPath = ev?.masterPath ?? null;
    const masterRefs = masterPath
      ? graph.referencesFor(BUCKET, masterPath).filter((r) => r.live).map(identity)
      : [];
    const exists = objects.has(sourcePath);

    const candidate: C7Candidate = {
      sourcePath,
      sourceUrl: publicUrl(sourcePath),
      sourceBytes: objects.get(sourcePath) ?? 0,
      sourceChecksum: exists ? await digest(sourcePath) : null,
      sourceExists: exists,
      evidence: reverted ? null : ev,
      batchApproved: ev ? approved.has(ev.batchId) : false,
      masterExists: masterPath ? objects.has(masterPath) : false,
      masterReadable: masterPath && objects.has(masterPath) ? await readable(masterPath) : false,
      masterBytes: masterPath ? objects.get(masterPath) ?? null : null,
      masterDimensions: masterPath && objects.has(masterPath) ? await masterDimensions(masterPath) : null,
      masterLiveReferences: masterRefs,
      graphIsComplete: graph.isComplete,
      liveReferencesOnSource: live.filter((r) =>
        r.table !== CART_TABLE && r.table !== SITE_CONTENT_TABLE && CLASSIFIED.has(r.table)).map(identity),
      cartReferencesOnSource: live.filter((r) => r.table === CART_TABLE).map(identity),
      siteContentReferencesOnSource: live.filter((r) => r.table === SITE_CONTENT_TABLE).map(identity),
      // Unknown = a hit in a table nobody classified. ImageReferenceGraph marks
      // those live (deliberately conservative), so they are counted here by
      // table name rather than by the live flag.
      unknownReferencesOnSource: refs.filter((r) => !CLASSIFIED.has(r.table)).length,
      historicalReferencesOnSource: refs.filter((r) => !r.live).length,
      expectedNormalizerVersion: C7_EXPECTED_NORMALIZER_VERSION,
    };

    const verdict = classifyForC7(candidate);
    let entry: C7ManifestEntry | null = null;
    if (isC7Eligible(verdict.state) && ev && candidate.sourceChecksum) {
      entry = {
        sourcePath,
        sourceBytes: candidate.sourceBytes,
        sourceChecksum: candidate.sourceChecksum,
        masterPath: ev.masterPath,
        masterBytes: candidate.masterBytes!,
        masterDimensions: candidate.masterDimensions,
        normalizerVersion: ev.normalizerVersion,
        migratedInBatch: ev.batchId,
        evidenceLedger: ev.ledgerFile,
        expectedMasterReferences: masterRefs,
      };
    }
    verdicts.push({ path: sourcePath, state: verdict.state, reason: verdict.reason, bytes: candidate.sourceBytes, entry });
  }

  /* ── report ── */
  const byState = new Map<C7State, typeof verdicts>();
  for (const v of verdicts) byState.set(v.state, [...(byState.get(v.state) ?? []), v]);
  console.log("  ── classification ──\n");
  for (const [state, group] of [...byState.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const bytes = group.reduce((s, v) => s + v.bytes, 0);
    console.log(`  ${state.padEnd(36)} ${String(group.length).padStart(3)}   ${MiB(bytes).padStart(9)} MiB`);
  }
  const blocked = verdicts.filter((v) => !isC7Eligible(v.state));
  if (blocked.length) {
    console.log("\n  ── blocked, with the reason ──\n");
    for (const v of blocked.slice(0, 12)) {
      console.log(`  ${v.state}  ${v.path}`);
      console.log(`     ${v.reason}`);
    }
    if (blocked.length > 12) console.log(`  … and ${blocked.length - 12} more (see the report)`);
  }

  const planned = alreadyPlanned();
  const eligible = verdicts.filter((v) => isC7Eligible(v.state) && v.entry);
  const unplanned = eligible.filter((v) => !planned.has(v.path));
  const eligibleBytes = eligible.reduce((s, v) => s + v.bytes, 0);
  console.log(`\n  ELIGIBLE  ${eligible.length} original(s), ${MiB(eligibleBytes)} MiB`);
  console.log(`  bucket now ${GiB(bucketBytes)} GiB -> after reclaiming all eligible ${GiB(bucketBytes - eligibleBytes)} GiB`);
  console.log(`  batches at MAX_C7_DELETE_BATCH=${MAX_C7_DELETE_BATCH}: ${Math.ceil(eligible.length / MAX_C7_DELETE_BATCH)}`);
  if (planned.size > 0) {
    console.log(`  already committed to earlier manifests: ${planned.size}; still unplanned: ${unplanned.length}`);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(`${REPORT_DIR}/c7-plan.json`, JSON.stringify({
    generatedAt: new Date().toISOString(),
    bucket: { objects: objects.size, bytes: bucketBytes },
    eligible: eligible.length, eligibleBytes,
    projectedBytes: bucketBytes - eligibleBytes,
    rows: verdicts.map((v) => ({
      sourcePath: v.path, state: v.state, reason: v.reason, bytes: v.bytes,
      masterPath: v.entry?.masterPath ?? null, migratedInBatch: v.entry?.migratedInBatch ?? null,
    })),
  }, null, 1));

  const chosen = unplanned.slice(0, MAX_C7_DELETE_BATCH).map((v) => v.entry!);
  if (chosen.length === 0) {
    console.log(planned.size > 0
      ? `\n  Nothing left to plan: all ${eligible.length} eligible original(s) are already in a manifest.\n`
      : "\n  Nothing is eligible. No manifest written.\n");
    return;
  }
  const manifest: C7Manifest = {
    kind: C7_MANIFEST_KIND, batchId, createdAt: new Date().toISOString(),
    normalizerVersion: C7_EXPECTED_NORMALIZER_VERSION, entries: chosen,
    checksum: c7ManifestChecksum(
      { batchId, normalizerVersion: C7_EXPECTED_NORMALIZER_VERSION, entries: chosen }, sha256),
  };
  assertCoherentC7Manifest(manifest);

  const path = `${REPORT_DIR}/manifest-${batchId}.json`;
  if (existsSync(path)) {
    throw new MigrationRefused(`${path} already exists; batch ids are never reused.`, "manifest_exists");
  }
  writeFileSync(path, JSON.stringify(manifest, null, 1), { flag: "wx" });

  console.log(`\n  proposed C7 batch: ${chosen.length} original(s), ${MiB(chosen.reduce((s, e) => s + e.sourceBytes, 0))} MiB`);
  for (const e of chosen) {
    console.log(`    ${e.sourcePath}  ${MiB(e.sourceBytes)} MiB  (migrated in ${e.migratedInBatch})`);
    console.log(`      keeps ${e.masterPath} with ${e.expectedMasterReferences.length} live reference(s)`);
  }
  console.log(`\n  manifest: ${path}`);
  console.log(`  checksum: ${manifest.checksum}`);
  console.log("\n  This tool has changed nothing. Executing the batch is a separate step,");
  console.log("  and deleting an original cannot be undone.\n");
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
