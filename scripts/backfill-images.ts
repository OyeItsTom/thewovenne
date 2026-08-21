/**
 * What a backfill WOULD do to the existing catalogue. It does none of it.
 *
 * READ-ONLY BY CONSTRUCTION, NOT BY FLAG. There is no `--execute` here to
 * forget, no destructive branch behind a guard, and no code path that could be
 * reached by a typo: this file contains no insert, update, upsert, delete,
 * remove or upload call at all, and scripts/image-backfill.test.ts asserts that
 * by reading the source. Making a destructive tool default to safe is how
 * destructive accidents happen; the writing belongs in a later PR that has to
 * be reviewed on its own terms.
 *
 * WHAT IT IS FOR. The catalogue holds ~2.17 GiB of camera originals — 13 to 28MB
 * each, around 50 megapixels — and nothing on the site can display more than
 * 1920 across. This prints, per photograph, exactly what normalizing it would
 * produce, who is currently pointing at it, and what it would save, so the
 * numbers can be argued with before anything is touched.
 *
 *   npx tsx scripts/backfill-images.ts            # summary
 *   npx tsx scripts/backfill-images.ts --verbose  # per-photograph detail
 *   npx tsx scripts/backfill-images.ts --limit 20
 *
 * It writes one thing: a report under reports/image-backfill/, which is
 * gitignored. Nothing else leaves this process.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  MAX_LONG_EDGE,
  NORMALIZER_VERSION,
  TARGET_SHORT_EDGE,
  masterEncoding,
  masterKey,
  targetSize,
} from "../lib/imageNormalize";
import {
  ImageReferenceGraph,
  HISTORICAL_REFERENCE_TABLES,
  LIVE_REFERENCE_TABLES,
  classifyObject,
  isDeletionEligible,
  type Classification,
  type StorageObject,
  type TableRows,
} from "../lib/imageReferences";

const BUCKET = "product-images";
const PRODUCT_PREFIX = "products/";

/**
 * Bytes per megapixel of normalized output, measured on twelve real Wovenne
 * photographs at the approved q92 / 4:4:4 settings.
 *
 * A single "79% smaller" figure was tempting and would have been wrong: the
 * saving depends on what is IN the photograph, and on whether the source is
 * even large enough to resize. Estimating from the target's megapixels and a
 * measured range gives a number that scales per image and carries its own
 * uncertainty, which is what an operator actually needs before authorising a
 * migration.
 */
const YIELD_MB_PER_MP = { low: 0.134, mid: 0.375, high: 0.551 };

interface Candidate {
  timestamp: string;
  sourcePath: string;
  sourceUrl: string;
  sourceBytes: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  sourceFormat: string | null;
  orientation: number | null;
  alpha: boolean | null;
  sourceChecksum: string | null;
  liveReferences: number;
  historicalReferences: number;
  references: Record<string, number>;
  associated: Array<{ table: string; rowId: string }>;
  shared: boolean;
  classification: Classification;
  normalizationRequired: boolean;
  expectedMasterDimensions: string | null;
  expectedMasterPath: string | null;
  normalizerVersion: number;
  masterAlreadyExists: boolean;
  estimatedMasterBytes: number | null;
  estimatedBytesSaved: number | null;
  deletionEligibleToday: boolean;
  warnings: string[];
}

/* ─────────────────────────────── read-only I/O ──────────────────────────── */

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Source .env.local first.`);
  return value;
}

async function readJson(path: string, accept?: string): Promise<unknown> {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}` };
  if (accept) headers.Accept = accept;
  const response = await fetch(url + path, { method: "GET", headers });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

/** Storage listing uses POST, but it is a query: it returns rows and changes nothing. */
async function listObjects(prefix: string): Promise<StorageObject[]> {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const out: StorageObject[] = [];
  let offset = 0;
  for (;;) {
    const response = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    if (!response.ok) throw new Error(`list ${prefix} -> ${response.status}`);
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!row.id) continue;
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      out.push({
        bucket: BUCKET,
        key: prefix ? `${prefix}/${row.name}` : String(row.name),
        bytes: Number(meta.size ?? 0),
        mime: (meta.mimetype as string) ?? null,
        createdAt: (row.created_at as string) ?? null,
      });
    }
    offset += rows.length;
    if (rows.length < 1000) break;
  }
  return out;
}

async function listAllObjects(): Promise<StorageObject[]> {
  const root = (await (async () => {
    const url = env("NEXT_PUBLIC_SUPABASE_URL");
    const key = env("SUPABASE_SERVICE_ROLE_KEY");
    const r = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "name", order: "asc" } }),
    });
    return (await r.json()) as Array<Record<string, unknown>>;
  })()) as Array<Record<string, unknown>>;
  const prefixes = root.filter((r) => !r.id).map((r) => String(r.name));
  const objects: StorageObject[] = [];
  for (const row of root) {
    if (!row.id) continue;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    objects.push({ bucket: BUCKET, key: String(row.name), bytes: Number(meta.size ?? 0),
      mime: (meta.mimetype as string) ?? null, createdAt: (row.created_at as string) ?? null });
  }
  for (const prefix of prefixes) objects.push(...(await listObjects(prefix)));
  return objects;
}

/** Every table PostgREST exposes, so a new one cannot be silently missed. */
async function fetchAllTables(): Promise<{ tables: TableRows[]; unreadable: string[] }> {
  const spec = (await readJson("/rest/v1/", "application/openapi+json")) as {
    paths?: Record<string, unknown>;
  };
  const names = Object.keys(spec.paths ?? {})
    .filter((p) => p !== "/" && !p.includes("{") && !p.startsWith("/rpc"))
    .map((p) => p.replace(/^\//, ""))
    .sort();
  const tables: TableRows[] = [];
  const unreadable: string[] = [];
  for (const table of names) {
    try {
      const rows = (await readJson(`/rest/v1/${table}?select=*&limit=10000`)) as Array<
        Record<string, unknown>
      >;
      if (Array.isArray(rows)) tables.push({ table, rows });
      else unreadable.push(table);
    } catch {
      unreadable.push(table);
    }
  }
  return { tables, unreadable };
}

/**
 * Enough of an image to read its header. A range request, so profiling 148
 * photographs costs a few megabytes rather than two gigabytes.
 */
async function readHeader(url: string, bytes = 262143): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { method: "GET", headers: { Range: `bytes=0-${bytes}` } });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

interface Header {
  format: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  alpha: boolean | null;
}

/**
 * Dimensions and orientation, parsed rather than decoded.
 *
 * sharp is available and would be simpler, but it wants a complete file and
 * these are up to 28MB each. The headers carry everything the plan needs, and
 * PNG is parsed by hand because a truncated PNG makes most decoders complain
 * about the missing body when the size is sitting in the first 24 bytes.
 */
export function parseHeader(buf: Buffer): Header {
  const empty: Header = { format: null, width: null, height: null, orientation: null, alpha: null };
  if (buf.length < 16) return empty;

  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") {
    const colourType = buf[25];
    return {
      format: "PNG",
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      orientation: null,
      alpha: colourType === 4 || colourType === 6 || colourType === 3,
    };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return parseJpeg(buf);
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return { ...empty, format: "WEBP" };
  }
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12).toLowerCase();
    return { ...empty, format: brand === "avif" || brand === "avis" ? "AVIF" : "HEIF" };
  }
  return empty;
}

/** SOFn for the size, APP1/TIFF tag 0x0112 for the orientation. */
function parseJpeg(buf: Buffer): Header {
  let orientation: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let isMpo = false;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = buf.readUInt16BE(i + 2);
    const start = i + 4;
    if (marker === 0xe1 && buf.toString("latin1", start, start + 6) === "Exif\0\0") {
      orientation = readExifOrientation(buf, start + 6) ?? orientation;
    }
    if (marker === 0xe2 && buf.toString("latin1", start, start + 4) === "MPF\0") isMpo = true;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (start + 5 <= buf.length) {
        height = buf.readUInt16BE(start + 1);
        width = buf.readUInt16BE(start + 3);
      }
      break;
    }
    i += 2 + length;
  }
  return { format: isMpo ? "MPO" : "JPEG", width, height, orientation, alpha: false };
}

function readExifOrientation(buf: Buffer, tiff: number): number | null {
  if (tiff + 8 > buf.length) return null;
  const le = buf.toString("latin1", tiff, tiff + 2) === "II";
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > buf.length) return null;
  const count = u16(ifd0);
  for (let e = 0; e < count; e += 1) {
    const entry = ifd0 + 2 + e * 12;
    if (entry + 12 > buf.length) break;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

/** Display shape: EXIF 5-8 mean the stored pixels are turned on their side. */
export function displayDimensions(h: Header): { width: number; height: number } | null {
  if (!h.width || !h.height) return null;
  const rotated = (h.orientation ?? 1) >= 5;
  return rotated ? { width: h.height, height: h.width } : { width: h.width, height: h.height };
}

export function estimateMasterBytes(
  width: number,
  height: number,
  sourceBytes: number,
  yieldMbPerMp: number = YIELD_MB_PER_MP.mid
): number {
  const megapixels = (width * height) / 1e6;
  // Never claim a normalized master would be larger than what is already there.
  return Math.min(sourceBytes, Math.round(megapixels * yieldMbPerMp * 1e6));
}

/* ────────────────────────────────── the plan ────────────────────────────── */

async function main() {
  const args = new Set(process.argv.slice(2));
  const verbose = args.has("--verbose") || args.has("-v");
  const limitArg = process.argv.find((a, i) => process.argv[i - 1] === "--limit");
  const limit = limitArg ? Number(limitArg) : Infinity;

  console.log("\n  READ-ONLY PLAN. This tool cannot write, upload or delete anything.\n");

  const objects = await listAllObjects();
  const { tables, unreadable } = await fetchAllTables();
  const graph = new ImageReferenceGraph(tables, unreadable);

  if (!graph.isComplete) {
    console.log(`  WARNING: ${unreadable.length} table(s) unreadable — nothing will be called an orphan.`);
    console.log(`           ${unreadable.join(", ")}\n`);
  }

  const existingKeys = new Set(objects.map((o) => o.key));
  const now = new Date();
  const candidates: Candidate[] = [];
  const byClass = new Map<Classification, { count: number; bytes: number }>();

  let profiled = 0;
  for (const object of objects) {
    const live = graph.liveReferenceCount(BUCKET, object.key);
    const historical = graph.historicalReferenceCount(BUCKET, object.key);
    const classification = classifyObject({
      object, liveReferences: live, historicalReferences: historical,
      graphIsComplete: graph.isComplete, now,
    });
    const bucketed = byClass.get(classification) ?? { count: 0, bytes: 0 };
    bucketed.count += 1; bucketed.bytes += object.bytes;
    byClass.set(classification, bucketed);

    const isProductSource =
      object.key.startsWith(PRODUCT_PREFIX) &&
      (classification === "REFERENCED_PRODUCT_SOURCE" || classification === "REFERENCED_SHARED_SOURCE");
    if (!isProductSource || candidates.length >= limit) continue;

    const url = `${env("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${object.key}`;
    const header = parseHeader((await readHeader(url)) ?? Buffer.alloc(0));
    const display = displayDimensions(header);
    profiled += display ? 1 : 0;
    const warnings: string[] = [];
    if (!display) warnings.push("header unreadable — dimensions unknown, cannot plan");
    if (header.format === "HEIF") warnings.push("HEIC/HEIF container — out of scope until PR B");

    const target = display ? targetSize(display) : null;
    const required = Boolean(display && target && (target.width !== display.width || target.height !== display.height));
    // The master key is derived from the SOURCE bytes, which this tool has not
    // downloaded in full. It is therefore reported as unknown rather than
    // guessed: a wrong key in a plan is worse than an absent one.
    const expectedMasterPath: string | null = null;
    const estimated = display && target ? estimateMasterBytes(target.width, target.height, object.bytes) : null;

    candidates.push({
      timestamp: now.toISOString(),
      sourcePath: object.key,
      sourceUrl: url,
      sourceBytes: object.bytes,
      sourceWidth: header.width, sourceHeight: header.height,
      displayWidth: display?.width ?? null, displayHeight: display?.height ?? null,
      sourceFormat: header.format,
      orientation: header.orientation,
      alpha: header.alpha,
      sourceChecksum: null,
      liveReferences: live, historicalReferences: historical,
      references: graph.breakdown(BUCKET, object.key),
      associated: graph.associatedEntities(BUCKET, object.key),
      shared: graph.isShared(BUCKET, object.key),
      classification,
      normalizationRequired: required,
      expectedMasterDimensions: target ? `${target.width}x${target.height}` : null,
      expectedMasterPath,
      normalizerVersion: NORMALIZER_VERSION,
      masterAlreadyExists: false,
      estimatedMasterBytes: estimated,
      estimatedBytesSaved: estimated === null ? null : object.bytes - estimated,
      deletionEligibleToday: isDeletionEligible(classification, live),
      warnings,
    });
  }

  report({ objects, candidates, byClass, graph, existingKeys, verbose, now });
}

function report(ctx: {
  objects: StorageObject[];
  candidates: Candidate[];
  byClass: Map<Classification, { count: number; bytes: number }>;
  graph: ImageReferenceGraph;
  existingKeys: Set<string>;
  verbose: boolean;
  now: Date;
}) {
  const { objects, candidates, byClass, graph, verbose, now } = ctx;
  const GiB = (n: number) => (n / 1073741824).toFixed(4);
  const MiB = (n: number) => (n / 1048576).toFixed(2);
  const totalBytes = objects.reduce((s, o) => s + o.bytes, 0);

  console.log("  ── REFERENCE SOURCES ─────────────────────────────────────────");
  console.log(`  live:       ${LIVE_REFERENCE_TABLES.join(", ")}`);
  console.log(`  historical: ${HISTORICAL_REFERENCE_TABLES.join(", ")} (never counts as live)`);

  console.log("\n  ── CLASSIFICATION (MEASURED) ─────────────────────────────────");
  for (const [name, v] of [...byClass.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${name.padEnd(30)} ${String(v.count).padStart(4)} objects  ${MiB(v.bytes).padStart(9)} MiB`);
  }

  const srcBytes = candidates.reduce((s, c) => s + c.sourceBytes, 0);
  const estBytes = candidates.reduce((s, c) => s + (c.estimatedMasterBytes ?? c.sourceBytes), 0);
  const resize = candidates.filter((c) => c.normalizationRequired).length;
  const zero = byClass.get("CONFIRMED_ZERO_REFERENCE") ?? { count: 0, bytes: 0 };
  const review = (["HEIC_REVIEW", "UNKNOWN_REVIEW", "RECENT_ZERO_REFERENCE", "HISTORICAL_REFERENCE_ONLY"] as Classification[])
    .reduce((acc, k) => { const v = byClass.get(k); return { count: acc.count + (v?.count ?? 0), bytes: acc.bytes + (v?.bytes ?? 0) }; }, { count: 0, bytes: 0 });
  const other = totalBytes - srcBytes - zero.bytes - review.bytes;

  console.log("\n  ── STORAGE (MEASURED) ────────────────────────────────────────");
  console.log(`  current bucket                 ${String(objects.length).padStart(4)} objects  ${GiB(totalBytes)} GiB`);
  console.log(`  product sources to normalize   ${String(candidates.length).padStart(4)} objects  ${GiB(srcBytes)} GiB   (${resize} need resizing)`);
  console.log(`  confirmed zero-reference       ${String(zero.count).padStart(4)} objects  ${GiB(zero.bytes)} GiB`);
  console.log(`  manual review                  ${String(review.count).padStart(4)} objects  ${GiB(review.bytes)} GiB`);
  console.log(`  other referenced assets                     ${GiB(other)} GiB`);

  const lo = candidates.reduce((s, c) => s + (c.displayWidth && c.displayHeight ? estimateMasterBytes(...sizeOf(c), c.sourceBytes, YIELD_MB_PER_MP.low) : c.sourceBytes), 0);
  const hi = candidates.reduce((s, c) => s + (c.displayWidth && c.displayHeight ? estimateMasterBytes(...sizeOf(c), c.sourceBytes, YIELD_MB_PER_MP.high) : c.sourceBytes), 0);
  console.log("\n  ── PROJECTION (ESTIMATED) ────────────────────────────────────");
  console.log(`  after backfill only            ${GiB(estBytes + zero.bytes + review.bytes + other)} GiB`);
  console.log(`  after confirmed cleanup only   ${GiB(totalBytes - zero.bytes)} GiB   (MEASURED)`);
  console.log(`  after both                     ${GiB(estBytes + review.bytes + other)} GiB   (range ${GiB(lo + review.bytes + other)} – ${GiB(hi + review.bytes + other)})`);
  const finalBytes = estBytes + review.bytes + other;
  console.log(`  total reduction                ${(100 * (totalBytes - finalBytes) / totalBytes).toFixed(1)}%`);
  console.log(`  phase-1 peak (originals kept)  ${GiB(totalBytes + estBytes)} GiB`);

  const heic = objects.filter((o) => /\.hei[cf]$/i.test(o.key) || (o.mime ?? "").includes("hei"));
  if (heic.length) {
    console.log("\n  ── HEIC / HEIF — REVIEW ONLY, NOT MIGRATED ───────────────────");
    for (const o of heic) {
      const stem = o.key.replace(/\.[^.]+$/, "");
      const siblings = objects.filter((x) => x.key !== o.key && x.key.replace(/\.[^.]+$/, "") === stem);
      console.log(`  ${o.key}  ${MiB(o.bytes)} MiB  live refs: ${graph.liveReferenceCount(BUCKET, o.key)}`);
      for (const s of siblings) {
        console.log(`    shares its UUID with ${s.key} (${MiB(s.bytes)} MiB, ${graph.liveReferenceCount(BUCKET, s.key)} live refs)`);
      }
    }
  }

  if (verbose) {
    console.log("\n  ── PER PHOTOGRAPH ────────────────────────────────────────────");
    for (const c of candidates) {
      console.log(`\n  SOURCE      ${c.sourcePath}`);
      console.log(`  CURRENT     ${MiB(c.sourceBytes)} MiB  ${c.displayWidth}x${c.displayHeight}  ${c.sourceFormat}  EXIF orientation ${c.orientation ?? "none"}`);
      console.log(`  REFERENCES  ${Object.entries(c.references).map(([t, n]) => `${t}: ${n}`).join("  ") || "none"}   (live ${c.liveReferences}, historical ${c.historicalReferences})`);
      console.log(`  NORMALIZE   required: ${c.normalizationRequired ? "yes" : "no (already within limits)"}   expected ${c.expectedMasterDimensions}`);
      console.log(`  MASTER      products/<sha256-of-source>-v${c.normalizerVersion}.jpg  (hash needs the full download; C2 computes it)`);
      console.log(`  ESTIMATED   ~${MiB(c.estimatedMasterBytes ?? 0)} MiB   saving ~${MiB(c.estimatedBytesSaved ?? 0)} MiB`);
      console.log(`  DELETE SOURCE?  NO — C1 never deletes; eligibility is decided in C3 after C2 migration and verification`);
      for (const w of c.warnings) console.log(`  WARNING     ${w}`);
    }
  }

  const dir = "reports/image-backfill";
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${now.toISOString().replace(/[:.]/g, "-")}.ndjson`;
  writeFileSync(file, candidates.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`\n  ledger: ${file}  (${candidates.length} records, gitignored)`);
  console.log("  NOTHING WAS CHANGED. No upload, no update, no delete.\n");
}

function sizeOf(c: Candidate): [number, number] {
  const t = targetSize({ width: c.displayWidth ?? 1, height: c.displayHeight ?? 1 });
  return [t.width, t.height];
}

/** Exported for the tests; the constants come from PR #135, never redefined. */
export const PLAN_RULES = { TARGET_SHORT_EDGE, MAX_LONG_EDGE, NORMALIZER_VERSION, YIELD_MB_PER_MP, masterKey, masterEncoding, createHash };

if (require.main === module) {
  void main().catch((error) => {
    console.error("\n  plan failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
