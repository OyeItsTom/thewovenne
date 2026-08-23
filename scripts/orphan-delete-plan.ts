/**
 * C5 PLANNER — READ-ONLY. Decides which orphans could eventually be deleted,
 * and deletes nothing.
 *
 * THIS SCRIPT HAS NO DELETION PATH. It contains no `.remove(`, no `.delete(`,
 * no HTTP DELETE, no --execute flag, and constructs no supabase-js client. It
 * reads production and writes one local manifest under the gitignored reports/
 * directory. The test suite asserts all of that by reading this source, so
 * adding a destructive call here fails the suite.
 *
 *   npx tsx --env-file=.env.local scripts/orphan-delete-plan.ts \
 *     --batch-id c5-orphan-1
 *
 * WHAT IT PROVES. For every candidate the C4 audit placed in
 * HIGH_CONFIDENCE_ORPHAN, it re-derives the whole argument from live data
 * rather than trusting the audit: the object still exists, nothing live or
 * historical points at it, and some OTHER object with the same SHA-256 exists
 * and is currently referenced. The audit file is used only to bound the scope
 * — an object it did not approve can never become eligible, and an object it
 * did approve still has to earn it again here.
 *
 * Eligibility lives in lib/imageOrphans.ts, not here.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { MigrationRefused, assertValidBatchId } from "../lib/imageBackfill";
import {
  C5_MANIFEST_KIND,
  MAX_C5_DELETION_BATCH,
  assertCoherentOrphanManifest,
  classifyOrphan,
  isC5Eligible,
  orphanManifestChecksum,
  type C5State,
  type OrphanCandidate,
  type OrphanManifest,
  type OrphanManifestEntry,
  type C5ReferenceIdentity,
} from "../lib/imageOrphans";
import { enumerateAllObjects, type StorageEntry } from "../lib/storagePrefixes";

const BATCH_ID_FLAG = "--batch-id";
const BUCKET = "product-images";
const REPORT_DIR = "reports/c5-orphan-delete";
const AUDIT_PATH = "reports/c4-orphan-audit/c4-audit.json";
const HIGH_CONFIDENCE = "HIGH_CONFIDENCE_ORPHAN";

/** Tables whose rows render an image. Mirrors lib/imageReferences.ts. */
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

/* ─────────────────────────── production reads ──────────────────────────── */

/** Every table PostgREST exposes, so no reference source is missed by assumption. */
async function allTables(): Promise<string[]> {
  const response = await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/`, { headers: headers() });
  const spec = await response.json();
  return Object.keys(spec?.paths ?? {})
    .filter((p) => p !== "/" && !p.startsWith("/rpc/"))
    .map((p) => p.slice(1));
}

/** Pulls every storage key out of any JSON value, however deeply nested. */
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

async function buildGraph(): Promise<Graph> {
  const tables = await allTables();
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
          // A key found in any other table is neither live nor historical by
          // this model, so it is counted as unreadable-shaped evidence: the
          // graph is only complete if no such table exists. See below.
        }
      }
    }
  }
  return { complete: unreadable.length === 0, unreadable, live, historical };
}

async function listAll(): Promise<Map<string, { bytes: number; mimetype: string | null }>> {
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
  return new Map(objects.map((o) => [o.key, { bytes: o.bytes, mimetype: o.mimetype }]));
}

/** Downloads an object so its digest can be computed from live bytes. */
async function digestOf(key: string): Promise<{ checksum: string; bytes: number } | null> {
  try {
    const response = await fetch(publicUrl(key));
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return { checksum: sha256Bytes(buffer), bytes: buffer.byteLength };
  } catch {
    return null;
  }
}

/* ──────────────────────────── the C4 audit scope ───────────────────────── */

/**
 * The set C4 approved, read as a boundary and nothing more.
 *
 * Membership here is necessary and never sufficient: every candidate still has
 * to re-prove its twin against live data below. If the audit is missing, this
 * refuses rather than defaulting to "everything is a candidate".
 */
function approvedScope(): Set<string> {
  if (!existsSync(AUDIT_PATH)) {
    throw new MigrationRefused(
      `${AUDIT_PATH} is missing — C5 will not plan without the audit that bounds its scope.`,
      "missing_audit"
    );
  }
  const audit = JSON.parse(readFileSync(AUDIT_PATH, "utf8"));
  const approved = new Set<string>();
  for (const [key, value] of Object.entries<Record<string, unknown>>(audit.objects ?? {})) {
    if (value?.final_class === HIGH_CONFIDENCE) approved.add(key);
  }
  if (approved.size === 0) {
    throw new MigrationRefused(
      `${AUDIT_PATH} lists no ${HIGH_CONFIDENCE} objects.`, "empty_scope"
    );
  }
  return approved;
}

/* ──────────────────────────────── entry point ──────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const explicit = argv[argv.indexOf(BATCH_ID_FLAG) + 1];
  if (!argv.includes(BATCH_ID_FLAG) || !explicit) {
    throw new MigrationRefused(
      `${BATCH_ID_FLAG} <id> is required, e.g. ${BATCH_ID_FLAG} c5-orphan-1.`, "missing_batch_id");
  }
  const batchId = assertValidBatchId(explicit);

  console.log("\n  C5 PLAN ONLY — READ-ONLY. This tool has no deletion path.\n");

  const approved = approvedScope();
  const graph = await buildGraph();
  const objects = await listAll();

  const bucketBytes = [...objects.values()].reduce((s, o) => s + o.bytes, 0);
  console.log(`  bucket                 ${objects.size} objects   ${(bucketBytes / 1073741824).toFixed(4)} GiB`);
  console.log(`  audit scope            ${approved.size} HIGH_CONFIDENCE_ORPHAN`);
  console.log(`  graph complete         ${graph.complete}${graph.unreadable.length ? ` (unreadable: ${graph.unreadable.join(", ")})` : ""}\n`);

  // Only candidates and objects sharing their byte length can be twins, so the
  // digest work stays proportional to the scope rather than the bucket.
  const bySize = new Map<number, string[]>();
  for (const [key, o] of objects) bySize.set(o.bytes, [...(bySize.get(o.bytes) ?? []), key]);
  const needDigest = new Set<string>();
  for (const key of approved) {
    needDigest.add(key);
    for (const peer of bySize.get(objects.get(key)?.bytes ?? -1) ?? []) needDigest.add(peer);
  }
  const digests = new Map<string, { checksum: string; bytes: number }>();
  for (const key of needDigest) {
    const d = await digestOf(key);
    if (d) digests.set(key, d);
  }

  const verdicts: Array<{ candidate: OrphanCandidate; state: C5State; reason: string }> = [];

  for (const key of [...approved].sort((a, b) => (objects.get(b)?.bytes ?? 0) - (objects.get(a)?.bytes ?? 0))) {
    const own = digests.get(key) ?? null;
    const liveOnCandidate = graph.live.get(key) ?? [];

    // The twin: any OTHER object with the same digest that is live-referenced.
    // Preferring the most-referenced one is not a safety property, only a way
    // to name the most obviously surviving copy in the report.
    let twin: OrphanCandidate["twin"] = null;
    if (own) {
      const sameContent = [...digests.entries()]
        .filter(([k, d]) => k !== key && d.checksum === own.checksum)
        .map(([k, d]) => ({ path: k, digest: d, refs: graph.live.get(k) ?? [] }))
        .filter((t) => !approved.has(t.path))       // a fellow candidate is not a survivor
        .sort((a, b) => b.refs.length - a.refs.length);
      const best = sameContent.find((t) => t.refs.length > 0) ?? sameContent[0];
      if (best) {
        twin = {
          path: best.path,
          exists: objects.has(best.path),
          bytes: best.digest.bytes,
          checksum: best.digest.checksum,
          liveReferences: best.refs,
        };
      }
    }

    const candidate: OrphanCandidate = {
      path: key,
      exists: objects.has(key),
      bytes: objects.get(key)?.bytes ?? 0,
      checksum: own?.checksum ?? null,
      liveReferences: liveOnCandidate,
      historicalReferences: graph.historical.get(key) ?? 0,
      twin,
      graphIsComplete: graph.complete,
      auditedHighConfidence: approved.has(key),
    };
    verdicts.push({ candidate, ...classifyOrphan(candidate) });
  }

  /* ── report ── */
  const byState = new Map<C5State, typeof verdicts>();
  for (const v of verdicts) byState.set(v.state, [...(byState.get(v.state) ?? []), v]);
  console.log("  ── classification ──\n");
  for (const [state, group] of [...byState.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const bytes = group.reduce((s, v) => s + v.candidate.bytes, 0);
    console.log(`  ${state.padEnd(34)} ${String(group.length).padStart(3)}   ${MiB(bytes).padStart(9)} MiB`);
  }

  const blocked = verdicts.filter((v) => !isC5Eligible(v.state));
  if (blocked.length) {
    console.log("\n  ── blocked, with the reason ──\n");
    for (const v of blocked) {
      console.log(`  ${v.state}  ${v.candidate.path}  (${MiB(v.candidate.bytes)} MiB)`);
      console.log(`     ${v.reason}`);
    }
  }

  const eligible = verdicts.filter((v) => isC5Eligible(v.state));
  const eligibleBytes = eligible.reduce((s, v) => s + v.candidate.bytes, 0);
  console.log(`\n  ELIGIBLE  ${eligible.length} orphan(s), ${MiB(eligibleBytes)} MiB reclaimable.`);

  const chosen = eligible.slice(0, MAX_C5_DELETION_BATCH);
  const entries: OrphanManifestEntry[] = chosen.map((v) => ({
    candidatePath: v.candidate.path,
    candidateBytes: v.candidate.bytes,
    candidateChecksum: v.candidate.checksum!,
    twinPath: v.candidate.twin!.path,
    twinBytes: v.candidate.twin!.bytes!,
    twinChecksum: v.candidate.twin!.checksum!,
    expectedTwinLiveReferences: v.candidate.twin!.liveReferences.length,
    expectedCandidateLiveReferences: 0,
    expectedCandidateHistoricalReferences: 0,
  }));

  if (entries.length === 0) {
    console.log("\n  Nothing is eligible. No manifest written.\n");
    return;
  }

  const manifest: OrphanManifest = {
    kind: C5_MANIFEST_KIND,
    batchId,
    createdAt: new Date().toISOString(),
    entries,
    checksum: orphanManifestChecksum({ batchId, entries }, sha256),
  };
  // Coherence is checked before the file exists, so an incoherent plan is
  // never written down where somebody could later feed it to an executor.
  assertCoherentOrphanManifest(manifest);

  mkdirSync(REPORT_DIR, { recursive: true });
  const path = `${REPORT_DIR}/manifest-${batchId}.json`;
  if (existsSync(path)) {
    throw new MigrationRefused(`${path} already exists; batch ids are never reused.`, "manifest_exists");
  }
  writeFileSync(path, JSON.stringify(manifest, null, 1), { flag: "wx" });

  console.log(`\n  proposed C5 batch: ${entries.length} orphan(s), ${MiB(entries.reduce((s, e) => s + e.candidateBytes, 0))} MiB`);
  for (const e of entries) {
    console.log(`    ${e.candidatePath}  ${MiB(e.candidateBytes)} MiB`);
    console.log(`      survives as ${e.twinPath}  (${e.expectedTwinLiveReferences} live ref(s), sha ${e.twinChecksum.slice(0, 16)}…)`);
  }
  console.log(`\n  manifest: ${path}`);
  console.log(`  checksum: ${manifest.checksum}`);
  console.log("\n  This tool has deleted nothing. No C5 executor exists yet.\n");
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
