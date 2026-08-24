/**
 * C6 PLANNER — READ-ONLY. Decides which live originals could be normalised,
 * and changes nothing.
 *
 * THIS SCRIPT HAS NO WRITE PATH. It contains no `.remove(`, no `.delete(`, no
 * HTTP DELETE/PATCH/PUT, no storage upload, and constructs no supabase-js
 * client. It reads production and writes one local manifest under the
 * gitignored reports/ directory. The test suite asserts all of that by reading
 * this source.
 *
 *   npx tsx --env-file=.env.local scripts/c6-normalize-plan.ts --batch-id c6-1
 *
 * WHAT IT PROVES. For every source the storage audit placed in
 * SAFE_OPTIMIZATION_CANDIDATE, it re-derives the argument from live data
 * rather than trusting the audit: the object still exists, its header still
 * reads, it is still live-referenced, it is still oversized against the
 * current policy, and — the part that actually matters — every one of its live
 * references is one this tool knows how to rewrite. The audit bounds the
 * scope; an entry still has to earn its place here.
 *
 * Eligibility lives in lib/imageC6.ts, not here.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { MigrationRefused, assertValidBatchId, planRepoints } from "../lib/imageBackfill";
import {
  C6_MANIFEST_KIND,
  MAX_C6_BATCH,
  assertCoherentC6Manifest,
  classifyForC6,
  isC6Eligible,
  c6ManifestChecksum,
  type C6Candidate,
  type C6Manifest,
  type C6ManifestEntry,
  type C6Reference,
  type C6State,
} from "../lib/imageC6";
import { NORMALIZER_VERSION, targetSize } from "../lib/imageNormalize";
import { enumerateAllObjects, type StorageEntry } from "../lib/storagePrefixes";
import { parseHeader, displayDimensions } from "./backfill-images";

const BATCH_ID_FLAG = "--batch-id";
const BUCKET = "product-images";
const REPORT_DIR = "reports/c6-normalize";
const AUDIT_PATH = "reports/image-storage-optimization/classified.json";
const SAFE = "SAFE_OPTIMIZATION_CANDIDATE";

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
  refs: Map<string, C6Reference[]>;
  productName: Map<string, string>;
}

/** Every table PostgREST exposes, so no reference source is missed by assumption. */
async function buildGraph(): Promise<Graph> {
  const spec = await (await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/`, { headers: headers() })).json();
  const tables = Object.keys(spec?.paths ?? {})
    .filter((p) => p !== "/" && !p.startsWith("/rpc/")).map((p) => p.slice(1));

  const refs = new Map<string, C6Reference[]>();
  const productName = new Map<string, string>();
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
          const live = LIVE_TABLES.has(table);
          const historical = HISTORICAL_TABLES.has(table);
          if (!live && !historical) continue;
          const rowId = String(row.id ?? row.product_id ?? row.user_id ?? row.slug ?? "?");
          refs.set(key, [...(refs.get(key) ?? []), { table, rowId, field: column, live }]);
          if (live && typeof row.name === "string" && !productName.has(key)) {
            productName.set(key, row.name);
          }
        }
      }
    }
  }
  return { complete: unreadable.length === 0, unreadable, refs, productName };
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

/** Reads the header only — enough for dimensions and orientation, not the pixels. */
async function header(key: string) {
  try {
    const response = await fetch(publicUrl(key), { headers: { Range: "bytes=0-262143" } });
    if (!response.ok) return null;
    return parseHeader(Buffer.from(await response.arrayBuffer()));
  } catch { return null; }
}

/** Downloads the object so its digest pins the plan to exact bytes. */
async function digest(key: string): Promise<string | null> {
  try {
    const response = await fetch(publicUrl(key));
    if (!response.ok) return null;
    return sha256Bytes(Buffer.from(await response.arrayBuffer()));
  } catch { return null; }
}

/** The audited scope, read as a boundary and nothing more. */
function approvedScope(): Set<string> {
  if (!existsSync(AUDIT_PATH)) {
    throw new MigrationRefused(
      `${AUDIT_PATH} is missing — C6 will not plan without the audit that bounds its scope.`,
      "missing_audit");
  }
  const audit = JSON.parse(readFileSync(AUDIT_PATH, "utf8"));
  const approved = new Set<string>();
  for (const o of audit.objects ?? []) if (o?.opt === SAFE) approved.add(o.key);
  if (approved.size === 0) {
    throw new MigrationRefused(`${AUDIT_PATH} lists no ${SAFE} objects.`, "empty_scope");
  }
  return approved;
}

/* ──────────────────────────────── entry point ──────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const explicit = argv[argv.indexOf(BATCH_ID_FLAG) + 1];
  if (!argv.includes(BATCH_ID_FLAG) || !explicit) {
    throw new MigrationRefused(`${BATCH_ID_FLAG} <id> is required, e.g. ${BATCH_ID_FLAG} c6-1.`, "missing_batch_id");
  }
  const batchId = assertValidBatchId(explicit);

  console.log("\n  C6 PLAN ONLY — READ-ONLY. This tool has no write path.\n");

  const approved = approvedScope();
  const graph = await buildGraph();
  const objects = await listAll();

  const bucketBytes = [...objects.values()].reduce((s, b) => s + b, 0);
  console.log(`  bucket                 ${objects.size} objects   ${(bucketBytes / 1073741824).toFixed(4)} GiB`);
  console.log(`  audit scope            ${approved.size} SAFE_OPTIMIZATION_CANDIDATE`);
  console.log(`  graph complete         ${graph.complete}${graph.unreadable.length ? ` (unreadable: ${graph.unreadable.join(", ")})` : ""}\n`);

  const verdicts: Array<{ c: C6Candidate; state: C6State; reason: string; entry: C6ManifestEntry | null; name: string | null }> = [];

  for (const key of [...approved].sort((a, b) => (objects.get(b) ?? 0) - (objects.get(a) ?? 0))) {
    const h = await header(key);
    const d = h ? displayDimensions(h) : null;
    const candidate: C6Candidate = {
      sourcePath: key,
      exists: objects.has(key),
      sourceBytes: objects.get(key) ?? 0,
      sourceChecksum: objects.has(key) ? await digest(key) : null,
      displayWidth: d?.width ?? null,
      displayHeight: d?.height ?? null,
      orientation: h?.orientation ?? null,
      format: h?.format ?? null,
      references: graph.refs.get(key) ?? [],
      graphIsComplete: graph.complete,
      auditedSafeCandidate: approved.has(key),
    };
    const v = classifyForC6(candidate, planRepoints, publicUrl(key));
    let entry: C6ManifestEntry | null = null;
    if (isC6Eligible(v.state) && candidate.displayWidth && candidate.displayHeight && candidate.sourceChecksum) {
      const t = targetSize({ width: candidate.displayWidth, height: candidate.displayHeight });
      entry = {
        sourcePath: key,
        sourceBytes: candidate.sourceBytes,
        sourceChecksum: candidate.sourceChecksum,
        sourceWidth: candidate.displayWidth,
        sourceHeight: candidate.displayHeight,
        orientation: candidate.orientation,
        targetWidth: t.width,
        targetHeight: t.height,
        repoints: v.repoints,
        retained: v.retained.map((r) => ({ table: r.table, rowId: r.rowId })),
      };
    }
    verdicts.push({ c: candidate, state: v.state, reason: v.reason, entry, name: graph.productName.get(key) ?? null });
  }

  /* ── report ── */
  const byState = new Map<C6State, typeof verdicts>();
  for (const v of verdicts) byState.set(v.state, [...(byState.get(v.state) ?? []), v]);
  console.log("  ── classification ──\n");
  for (const [state, group] of [...byState.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const bytes = group.reduce((s, v) => s + v.c.sourceBytes, 0);
    console.log(`  ${state.padEnd(36)} ${String(group.length).padStart(3)}   ${MiB(bytes).padStart(9)} MiB`);
  }
  const blocked = verdicts.filter((v) => !isC6Eligible(v.state));
  if (blocked.length) {
    console.log("\n  ── blocked, with the reason ──\n");
    for (const v of blocked.slice(0, 12)) {
      console.log(`  ${v.state}  ${v.c.sourcePath}  (${MiB(v.c.sourceBytes)} MiB)`);
      console.log(`     ${v.reason}`);
    }
    if (blocked.length > 12) console.log(`  … and ${blocked.length - 12} more (see the report)`);
  }

  const eligible = verdicts.filter((v) => isC6Eligible(v.state) && v.entry);
  const eligibleBytes = eligible.reduce((s, v) => s + v.c.sourceBytes, 0);
  const projected = eligible.reduce((s, v) => s + estimate(v.entry!), 0);
  console.log(`\n  ELIGIBLE  ${eligible.length} original(s), ${MiB(eligibleBytes)} MiB`);
  console.log(`  projected masters ${MiB(projected)} MiB — eventual saving ${MiB(eligibleBytes - projected)} MiB once C3 reclaims the originals`);
  console.log(`  batches at MAX_C6_BATCH=${MAX_C6_BATCH}: ${Math.ceil(eligible.length / MAX_C6_BATCH)}`);

  /* ── planning report, and the first batch only ── */
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(`${REPORT_DIR}/c6-plan.json`, JSON.stringify({
    generatedAt: new Date().toISOString(),
    bucket: { objects: objects.size, bytes: bucketBytes },
    eligible: eligible.length, eligibleBytes, projectedMasterBytes: projected,
    rows: verdicts.map((v) => ({
      sourcePath: v.c.sourcePath, product: v.name, state: v.state, reason: v.reason,
      bytes: v.c.sourceBytes, width: v.c.displayWidth, height: v.c.displayHeight,
      orientation: v.c.orientation, liveRefs: v.c.references.filter((r) => r.live).length,
      repoints: v.entry?.repoints.length ?? 0, retained: v.entry?.retained.length ?? 0,
      targetWidth: v.entry?.targetWidth ?? null, targetHeight: v.entry?.targetHeight ?? null,
    })),
  }, null, 1));

  const chosen = eligible.slice(0, MAX_C6_BATCH).map((v) => v.entry!);
  if (chosen.length === 0) {
    console.log("\n  Nothing is eligible. No manifest written.\n");
    return;
  }
  const manifest: C6Manifest = {
    kind: C6_MANIFEST_KIND, batchId, createdAt: new Date().toISOString(),
    normalizerVersion: NORMALIZER_VERSION, entries: chosen,
    checksum: c6ManifestChecksum({ batchId, normalizerVersion: NORMALIZER_VERSION, entries: chosen }, sha256),
  };
  assertCoherentC6Manifest(manifest);

  const path = `${REPORT_DIR}/manifest-${batchId}.json`;
  if (existsSync(path)) {
    throw new MigrationRefused(`${path} already exists; batch ids are never reused.`, "manifest_exists");
  }
  writeFileSync(path, JSON.stringify(manifest, null, 1), { flag: "wx" });

  console.log(`\n  proposed C6 batch: ${chosen.length} original(s), ${MiB(chosen.reduce((s, e) => s + e.sourceBytes, 0))} MiB`);
  for (const e of chosen) {
    console.log(`    ${e.sourcePath}  ${MiB(e.sourceBytes)} MiB  ${e.sourceWidth}x${e.sourceHeight} -> ${e.targetWidth}x${e.targetHeight}`);
    console.log(`      ${e.repoints.length} reference(s) to move${e.retained.length ? `, ${e.retained.length} retained` : ""}`);
  }
  console.log(`\n  manifest: ${path}`);
  console.log(`  checksum: ${manifest.checksum}`);
  console.log("\n  This tool has changed nothing. Executing the batch is a separate step,");
  console.log("  and C6 never deletes the original.\n");
}

/** Projected master size, from the measured cost of the 35 real q92 masters. */
const BYTES_PER_PIXEL = 0.5429;
function estimate(e: C6ManifestEntry): number {
  return Math.min(e.sourceBytes, Math.round(BYTES_PER_PIXEL * e.targetWidth * e.targetHeight));
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof MigrationRefused ? `refused (${error.reason}): ${error.message}` : error;
    console.error("\n  ", message, "\n");
    process.exit(1);
  });
}
