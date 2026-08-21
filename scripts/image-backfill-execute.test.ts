/**
 * The migration's refusals.
 *
 * Almost every test here is a check that something does NOT happen: that a
 * sixth source is rejected, that a changed row aborts the write, that a
 * reference in a table this tool may not touch disqualifies the whole source,
 * and above all that no code path exists which could delete an original. C2 is
 * the first tool in this series that writes, so what is worth asserting is
 * where it stops.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  EXECUTE_FLAGS,
  MAX_EXECUTION_BATCH,
  MigrationRefused,
  NON_REPOINTABLE_TABLES,
  REPOINTABLE_COLUMNS,
  assertBatchSize,
  assertExecuteFlags,
  isRepointable,
  manifestChecksum,
  migrationRefusal,
  planRepoints,
  rollbackFor,
  type ManifestEntry,
} from "../lib/imageBackfill";
import { NORMALIZER_VERSION, JPEG_MASTER, targetSize } from "../lib/imageNormalize";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else { fail++; if (detail) console.log(`        ${detail}`); }
}
function refuses(name: string, fn: () => unknown, reason?: string) {
  try { fn(); check(name, false, "it was allowed"); }
  catch (e) {
    check(name, e instanceof MigrationRefused && (!reason || e.reason === reason),
      e instanceof MigrationRefused ? `reason=${e.reason}` : String(e));
  }
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ref = (table: string, rowId: string, field: string, live = true) => ({ table, rowId, field, live });
const OLD = "https://x.supabase.co/storage/v1/object/public/product-images/products/old.jpg";

async function main() {
  const exec = readFileSync("scripts/backfill-execute.ts", "utf8");
  const rules = readFileSync("lib/imageBackfill.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = strip(exec) + "\n" + strip(rules);

  console.log("\n=== C2 CANNOT DELETE AN ORIGINAL — the non-negotiable ===");
  check("no .remove( anywhere", !/\.\s*remove\s*\(/.test(code));
  check("no .delete( anywhere", !/\.\s*delete\s*\(/.test(code));
  check("no HTTP DELETE is ever issued", !/method:\s*"DELETE"/.test(code));
  check("no storage object is addressed for removal", !/storage\/v1\/object\/[^"]*"\s*,\s*\{\s*method:\s*"DELETE"/.test(code));
  check("the only storage write targets the master key", /storage\/v1\/object\/\$\{BUCKET\}\/\$\{key\}/.test(code));
  check("uploads are non-upsert", /"x-upsert":\s*"false"/.test(code));
  check("the word retained appears in the operator output", /RETAINED/.test(exec));
  check("no supabase-js client (its .remove would be one call away)", !/createClient\s*\(/.test(code));

  console.log("\n=== execution requires deliberate flags ===");
  refuses("a bare run is not an execution", () => assertExecuteFlags([]), "not_execute");
  refuses("--execute alone is refused", () => assertExecuteFlags(["--execute"]), "missing_acknowledgement");
  refuses("without --batch-id", () => assertExecuteFlags(["--execute", EXECUTE_FLAGS.acknowledgement]), "missing_batch_id");
  refuses("without --source-manifest",
    () => assertExecuteFlags(["--execute", EXECUTE_FLAGS.acknowledgement, "--batch-id", "b1"]), "missing_manifest");
  const okFlags = assertExecuteFlags(["--execute", EXECUTE_FLAGS.acknowledgement, "--batch-id", "b1", "--source-manifest", "m.json"]);
  check("all four flags together are accepted", okFlags.batchId === "b1" && okFlags.manifestPath === "m.json");
  check("the acknowledgement is long enough to be deliberate", EXECUTE_FLAGS.acknowledgement.length > 30);

  console.log("\n=== the batch ceiling is a constant, not an argument ===");
  check(`MAX_EXECUTION_BATCH is ${MAX_EXECUTION_BATCH}`, MAX_EXECUTION_BATCH === 5);
  check("five is allowed", (() => { assertBatchSize(5); return true; })());
  refuses("six is refused", () => assertBatchSize(6), "batch_too_large");
  refuses("148 is refused", () => assertBatchSize(148), "batch_too_large");
  refuses("zero is refused", () => assertBatchSize(0), "empty_batch");
  check("no CLI flag can raise it", !/--batch-size|--limit\b|maxBatch\s*=/.test(strip(exec)));
  check("the executor asserts it before doing anything", exec.includes("assertBatchSize(manifest.entries.length)"));

  console.log("\n=== manifest binds the run to what was reviewed ===");
  const entries: ManifestEntry[] = [
    { sourcePath: "products/a.jpg", sourceBytes: 100, repoints: [{ table: "product_images", rowId: "r1", column: "url", oldUrl: OLD }] },
  ];
  const sum = manifestChecksum(entries, sha);
  check("the checksum is stable", manifestChecksum(entries, sha) === sum);
  check("row order does not change it",
    manifestChecksum([{ ...entries[0], repoints: [...entries[0].repoints].reverse() }], sha) === sum);
  check("a changed URL changes it",
    manifestChecksum([{ ...entries[0], repoints: [{ ...entries[0].repoints[0], oldUrl: OLD + "x" }] }], sha) !== sum);
  check("a changed byte count changes it",
    manifestChecksum([{ ...entries[0], sourceBytes: 101 }], sha) !== sum);
  check("an extra reference changes it",
    manifestChecksum([{ ...entries[0], repoints: [...entries[0].repoints, { table: "products", rowId: "p1", column: "image_url", oldUrl: OLD }] }], sha) !== sum);
  check("the executor recomputes it against LIVE data before writing",
    exec.includes("manifestChecksum(liveEntries, sha256) !== manifest.checksum"));
  check("and aborts when the world moved", exec.includes('"data_moved"'));
  check("a mismatched batch id aborts", exec.includes('"batch_id_mismatch"'));
  check("a different normalizer version aborts", exec.includes('"version_mismatch"'));
  check("an incomplete graph aborts", exec.includes('"graph_incomplete"'));

  console.log("\n=== only whitelisted columns may be rewritten ===");
  check("product_images.url is repointable", isRepointable("product_images"));
  check("products.image_url is repointable", isRepointable("products"));
  check("product_versions.image_url is repointable", isRepointable("product_versions"));
  check("carts is NOT repointable", !isRepointable("carts"));
  check("site_content is NOT repointable", !isRepointable("site_content"));
  check("admin_audit_log is NOT repointable", !isRepointable("admin_audit_log"));
  check("the non-repointable list names both", [...NON_REPOINTABLE_TABLES].join() === "carts,site_content");
  check("exactly three columns are writable", REPOINTABLE_COLUMNS.length === 3);

  console.log("\n=== planning repoints ===");
  const single = planRepoints([ref("product_images", "r1", "url")], OLD);
  check("a single gallery reference plans one row", single.repoints.length === 1 && single.blockers.length === 0);
  const multi = planRepoints([ref("product_images", "r1", "url"), ref("product_images", "r2", "url"),
    ref("products", "p1", "image_url"), ref("product_versions", "v1", "image_url")], OLD);
  check("a multi-reference source plans every row", multi.repoints.length === 4 && multi.blockers.length === 0);
  check("each row carries its own table and column",
    multi.repoints.filter((r) => r.table === "product_versions")[0].column === "image_url");
  const withCart = planRepoints([ref("product_images", "r1", "url"), ref("carts", "c1", "items")], OLD);
  check("a cart reference becomes a BLOCKER, not a silent skip",
    withCart.blockers.length === 1 && withCart.blockers[0].table === "carts");
  const withCms = planRepoints([ref("site_content", "s1", "value")], OLD);
  check("site_content is a blocker too", withCms.blockers.length === 1);
  const withLog = planRepoints([ref("product_images", "r1", "url"), ref("admin_audit_log", "a1", "payload", false)], OLD);
  check("the audit log is never rewritten and never blocks", withLog.repoints.length === 1 && withLog.blockers.length === 0);
  const oddField = planRepoints([ref("product_images", "r1", "thumbnail_url")], OLD);
  check("a reference in an unexpected column blocks the source", oddField.blockers.length === 1);

  console.log("\n=== a source is refused unless everything is known ===");
  const base = { classification: "REFERENCED_PRODUCT_SOURCE", liveReferences: 1, graphIsComplete: true, format: "MPO", hasWarnings: false, blockers: 0 };
  check("a clean product source is accepted", migrationRefusal(base) === null);
  check("a shared source is accepted", migrationRefusal({ ...base, classification: "REFERENCED_SHARED_SOURCE", liveReferences: 3 }) === null);
  check("incomplete graph refused", migrationRefusal({ ...base, graphIsComplete: false }) !== null);
  check("HEIC refused", migrationRefusal({ ...base, format: "HEIF" }) !== null);
  check("unprofiled source refused", migrationRefusal({ ...base, hasWarnings: true }) !== null);
  check("a blocked reference refuses the whole source", migrationRefusal({ ...base, blockers: 1 }) !== null);
  check("zero references refused (that is orphan work)", migrationRefusal({ ...base, liveReferences: 0 }) !== null);
  for (const c of ["CONFIRMED_ZERO_REFERENCE", "HEIC_REVIEW", "UNKNOWN_REVIEW", "RECENT_ZERO_REFERENCE",
    "HISTORICAL_REFERENCE_ONLY", "ALREADY_NORMALIZED", "REFERENCED_NON_PRODUCT_ASSET"]) {
    check(`${c} is refused`, migrationRefusal({ ...base, classification: c }) !== null);
  }

  console.log("\n=== compare-and-set, and rollback ===");
  check("every repoint PATCH carries the old value as a predicate",
    /\?id=eq\.\$\{encodeURIComponent\(repoint\.rowId\)\}&\$\{repoint\.column\}=eq\.\$\{encodeURIComponent\(repoint\.oldUrl\)\}/.test(exec));
  check("a PATCH matching other than one row is an error", exec.includes("updated.length !== 1"));
  check("rollback is attempted when rows were already applied", exec.includes("if (applied.length > 0)"));
  const applied = [{ table: "product_images", rowId: "r1", column: "url", oldUrl: OLD, newUrl: "NEW" }];
  const undo = rollbackFor(applied);
  check("rollback reverses the direction", undo[0].from === "NEW" && undo[0].to === OLD);
  check("rollback keeps table and row", undo[0].table === "product_images" && undo[0].rowId === "r1");
  check("rollback is itself compare-and-set", /=eq\.\$\{encodeURIComponent\(step\.from\)\}/.test(exec));
  check("nothing empties the rollback list before it is used", !/applied\s*=\s*\[\]/.test(strip(exec)));

  console.log("\n=== verification before the source is called migrated ===");
  check("the master must decode to the expected size", exec.includes("expected ${target.width}x${target.height}"));
  check("the master must be readable over HTTP", exec.includes("master not readable"));
  check("the graph is rebuilt after repointing", exec.includes("const afterGraph = new ImageReferenceGraph"));
  check("the original must end with zero live references", exec.includes("live reference(s) still point at the original"));
  check("the master must carry the expected references", exec.includes("expected at least"));
  check("verification failure routes to the catch, which rolls back", exec.includes("throw new Error(`${stillOnSource}"));

  console.log("\n=== normalization rules are PR #135's, not a copy ===");
  check("constants are imported", exec.includes('from "../lib/imageNormalize"'));
  check("no local target-size arithmetic", !/TARGET_SHORT_EDGE\s*=/.test(strip(exec)));
  check("quality is still 92 / 4:4:4", Number(JPEG_MASTER.quality) === 92 && String(JPEG_MASTER.chromaSubsampling) === "4:4:4");
  check("normalizer version is v1", NORMALIZER_VERSION === 1);
  check("portrait target unchanged", JSON.stringify(targetSize({ width: 6120, height: 8160 })) === '{"width":2400,"height":3200}');
  check("square target unchanged", JSON.stringify(targetSize({ width: 6112, height: 6112 })) === '{"width":2400,"height":2400}');
  check("small sources are skipped, not enlarged", exec.includes("nothing to gain"));

  console.log("\n=== orientation 1, 3, 6, 8 through the C2 pipeline ===");
  for (const orientation of [1, 3, 6, 8] as const) {
    const src = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#7a2b2b" } })
      .withMetadata({ orientation }).jpeg().toBuffer();
    const meta = await sharp(src).metadata();
    check(`orientation ${orientation}: fixture really carries it`, meta.orientation === orientation);
    const rotated = (meta.orientation ?? 1) >= 5;
    const display = { width: rotated ? meta.height! : meta.width!, height: rotated ? meta.width! : meta.height! };
    const out = await sharp(src).rotate().toColourspace("srgb").withIccProfile("srgb")
      .resize({ ...targetSize(display), fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .jpeg({ ...JPEG_MASTER }).toBuffer();
    const after = await sharp(out).metadata();
    const expected = targetSize(display);
    check(`orientation ${orientation}: master is ${expected.width}x${expected.height}`,
      after.width === expected.width && after.height === expected.height, `${after.width}x${after.height}`);
    check(`orientation ${orientation}: EXIF no longer needed`, (after.orientation ?? 1) === 1);
  }

  console.log("\n=== idempotency ===");
  check("the master key is the source hash, so a rerun resolves to it", exec.includes("masterKey(sha256(source)"));
  check("an existing master is reused rather than duplicated", exec.includes("masterWasDuplicate"));
  check("a 409 is treated as success", exec.includes("upload.status === 409"));
  check("a rerun of a migrated source finds nothing to move",
    exec.includes("compare-and-set matched"), "CAS on the OLD url matches 0 rows once repointed");

  console.log("\n=== the ledger records what would be reclaimed, not what was ===");
  check("bytes added now is recorded", exec.includes("bytesAddedNow"));
  check("reclaimable-after-C3 is recorded separately", exec.includes("bytesReclaimableAfterC3"));
  check("rollback data is kept for every migrated source", exec.includes("rollbackData: rollbackFor(applied)"));
  check("the operator is told storage goes UP", exec.includes("storage goes UP"));
  check("and told not to run batch 2", exec.includes("Do not run batch 2"));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
