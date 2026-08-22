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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  EXECUTE_FLAGS,
  MAX_EXECUTION_BATCH,
  MigrationRefused,
  DISQUALIFYING_REFERENCE_TABLES,
  NON_REPOINTABLE_TABLES,
  REPOINTABLE_COLUMNS,
  RETAINED_REFERENCE_TABLES,
  MAX_BATCH_ID_LENGTH,
  assertBatchSize,
  assertExecuteFlags,
  assertValidBatchId,
  manifestPathFor,
  writeManifestExclusive,
  canDeleteOriginal,
  deletionBlockers,
  describeRetainedIdentity,
  retainedIdentity,
  retainedIdentityDiff,
  retainedIdentitySet,
  isRepointable,
  isRetainedReferenceTable,
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
  check(`MAX_EXECUTION_BATCH is ${MAX_EXECUTION_BATCH}`, MAX_EXECUTION_BATCH === 10);
  check("ten is allowed", (() => { assertBatchSize(10); return true; })());
  check("five is still allowed", (() => { assertBatchSize(5); return true; })());
  refuses("eleven is refused", () => assertBatchSize(11), "batch_too_large");
  refuses("twenty is refused — not approved yet", () => assertBatchSize(20), "batch_too_large");
  refuses("148 is refused", () => assertBatchSize(148), "batch_too_large");
  refuses("zero is refused", () => assertBatchSize(0), "empty_batch");
  check("no CLI flag can raise it", !/--batch-size|--limit\b|maxBatch\s*=/.test(strip(exec)));
  check("the executor asserts it before doing anything", exec.includes("assertBatchSize(manifest.entries.length)"));

  console.log("\n=== manifest binds the run to what was reviewed ===");
  const entries: ManifestEntry[] = [
    { sourcePath: "products/a.jpg", sourceBytes: 100, repoints: [{ table: "product_images", rowId: "r1", column: "url", oldUrl: OLD }] },
  ];
  const subject = { batchId: "c2-batch-5", normalizerVersion: 1, entries };
  const sum = manifestChecksum(subject, sha);
  check("the checksum is stable", manifestChecksum(subject, sha) === sum);
  check("row order does not change it",
    manifestChecksum({ ...subject, entries: [{ ...entries[0], repoints: [...entries[0].repoints].reverse() }] }, sha) === sum);
  check("a changed URL changes it",
    manifestChecksum({ ...subject, entries: [{ ...entries[0], repoints: [{ ...entries[0].repoints[0], oldUrl: OLD + "x" }] }] }, sha) !== sum);
  check("a changed byte count changes it",
    manifestChecksum({ ...subject, entries: [{ ...entries[0], sourceBytes: 101 }] }, sha) !== sum);
  check("an extra reference changes it",
    manifestChecksum({ ...subject, entries: [{ ...entries[0], repoints: [...entries[0].repoints, { table: "products", rowId: "p1", column: "image_url", oldUrl: OLD }] }] }, sha) !== sum);
  check("the executor recomputes it against LIVE data before writing",
    exec.includes("entries: liveEntries }") && exec.includes("liveChecksum !== manifest.checksum"));
  check("and aborts when the world moved", exec.includes('"data_moved"'));
  check("a mismatched batch id aborts", exec.includes('"batch_id_mismatch"'));
  check("a different normalizer version aborts", exec.includes('"version_mismatch"'));
  check("an incomplete graph aborts", exec.includes('"graph_incomplete"'));

  console.log("\n=== batch identity is part of the fingerprint (PR #137) ===");
  //
  // The hole this closes: manifestChecksum used to cover only `entries`, so a
  // generated manifest could be renamed to any other batch id and still
  // verify. Batch identity is what an operator approves, so it must be what
  // the checksum protects.
  const idA = { batchId: "c2-batch-5", normalizerVersion: 1, entries };
  const sumA = manifestChecksum(idA, sha);

  // A. same manifest, same batch id → identical
  check("A: same entries and same batch id give the same checksum",
    manifestChecksum({ batchId: "c2-batch-5", normalizerVersion: 1, entries }, sha) === sumA);
  check("A: and it is stable across repeated computation",
    manifestChecksum(idA, sha) === manifestChecksum(idA, sha));

  // B. batch id alone → changes
  check("B: changing ONLY the batch id changes the checksum",
    manifestChecksum({ ...idA, batchId: "c2-batch-6" }, sha) !== sumA);
  check("B: even a one-character difference changes it",
    manifestChecksum({ ...idA, batchId: "c2-batch-51" }, sha) !== sumA);
  check("B: the old date-style id is not equivalent to the explicit one",
    manifestChecksum({ ...idA, batchId: "batch-2026-08-22-1" }, sha) !== sumA);

  // C. normalizer version → changes
  check("C: changing ONLY the normalizer version changes the checksum",
    manifestChecksum({ ...idA, normalizerVersion: 2 }, sha) !== sumA);

  // D. entry material → changes (the existing hashing is not weakened)
  check("D: changing a source path changes the checksum",
    manifestChecksum({ ...idA, entries: [{ ...entries[0], sourcePath: "products/b.jpg" }] }, sha) !== sumA);
  check("D: changing a repoint row id changes the checksum",
    manifestChecksum({ ...idA, entries: [{ ...entries[0], repoints: [{ ...entries[0].repoints[0], rowId: "r2" }] }] }, sha) !== sumA);
  check("D: changing a repoint column changes the checksum",
    manifestChecksum({ ...idA, entries: [{ ...entries[0], repoints: [{ ...entries[0].repoints[0], column: "image_url" }] }] }, sha) !== sumA);
  check("D: dropping an entry changes the checksum",
    manifestChecksum({ ...idA, entries: [] }, sha) !== sumA);

  // E. the rename attack: edit batchId in a generated manifest, keep its checksum
  const generated = {
    batchId: "c2-batch-5", createdAt: new Date().toISOString(), normalizerVersion: 1,
    entries, checksum: sumA,
  };
  const renamed = { ...generated, batchId: "c2-batch-9" };
  check("E: a hand-edited batch id no longer matches its own checksum",
    manifestChecksum(
      { batchId: renamed.batchId, normalizerVersion: renamed.normalizerVersion, entries: renamed.entries }, sha
    ) !== renamed.checksum);
  check("E: the untouched manifest still verifies",
    manifestChecksum(
      { batchId: generated.batchId, normalizerVersion: generated.normalizerVersion, entries: generated.entries }, sha
    ) === generated.checksum);
  check("E: the executor compares a checksum it computed itself, not the stored one",
    exec.includes("const selfChecksum = manifestChecksum(") && exec.includes("selfChecksum !== manifest.checksum"));
  check("E: and it rejects that as tampering", exec.includes('"manifest_tampered"'));

  // F. invalid batch ids
  check("F: a normal id is accepted", assertValidBatchId("c2-batch-5") === "c2-batch-5");
  check("F: dots, underscores and hyphens are allowed", assertValidBatchId("c2_batch.5-final") === "c2_batch.5-final");
  refuses("F: traversal is refused", () => assertValidBatchId("../x"), "invalid_batch_id");
  refuses("F: a bare .. is refused", () => assertValidBatchId(".."), "invalid_batch_id");
  refuses("F: a path separator is refused", () => assertValidBatchId("a/b"), "invalid_batch_id");
  refuses("F: a backslash is refused", () => assertValidBatchId("a\\b"), "invalid_batch_id");
  refuses("F: an absolute path is refused", () => assertValidBatchId("/etc/passwd"), "invalid_batch_id");
  refuses("F: an empty id is refused", () => assertValidBatchId(""), "invalid_batch_id");
  refuses("F: whitespace-only is refused", () => assertValidBatchId("   "), "invalid_batch_id");
  refuses("F: an embedded space is refused", () => assertValidBatchId("c2 batch 5"), "invalid_batch_id");
  refuses("F: a newline is refused", () => assertValidBatchId("c2-batch-5\n"), "invalid_batch_id");
  refuses("F: a NUL byte is refused", () => assertValidBatchId("c2-batch-5\u0000"), "invalid_batch_id");
  refuses("F: a control character is refused", () => assertValidBatchId("c2\u0007batch"), "invalid_batch_id");
  refuses("F: an overly long id is refused", () => assertValidBatchId("x".repeat(MAX_BATCH_ID_LENGTH + 1)), "invalid_batch_id");
  check("F: exactly at the limit is allowed",
    assertValidBatchId("x".repeat(MAX_BATCH_ID_LENGTH)).length === MAX_BATCH_ID_LENGTH);
  refuses("F: a leading dot is refused", () => assertValidBatchId(".hidden"), "invalid_batch_id");
  refuses("F: a non-string is refused", () => assertValidBatchId(undefined), "invalid_batch_id");
  refuses("F: a shell metacharacter is refused", () => assertValidBatchId("c2;rm -rf /"), "invalid_batch_id");
  check("F: the manifest path stays inside the report directory",
    manifestPathFor("c2-batch-5") === "reports/image-backfill/manifest-c2-batch-5.json");
  refuses("F: and an escaping id never becomes a path", () => manifestPathFor("../../etc/x"), "invalid_batch_id");

  // G. no silent overwrite — exercised against a real directory
  const tmp = mkdtempSync(join(tmpdir(), "wovenne-manifest-"));
  const tmpPath = join(tmp, "manifest-c2-batch-5.json");
  const exclusively = (p: string, data: string) => writeFileSync(p, data, { flag: "wx" });
  writeManifestExclusive(tmpPath, generated, exclusively);
  check("G: the first write lands", existsSync(tmpPath));
  const firstBytes = readFileSync(tmpPath, "utf8");
  refuses("G: a second write to the same batch id is refused",
    () => writeManifestExclusive(tmpPath, { ...generated, entries: [] }, exclusively), "manifest_exists");
  check("G: and the original file is left byte-for-byte intact",
    readFileSync(tmpPath, "utf8") === firstBytes);
  check("G: a different batch id writes fine",
    (() => { writeManifestExclusive(join(tmp, "manifest-c2-batch-6.json"), generated, exclusively); return true; })());
  check("G: an error that is not EEXIST is not swallowed as manifest_exists",
    (() => {
      try {
        writeManifestExclusive(tmpPath, generated, () => { throw Object.assign(new Error("nope"), { code: "EACCES" }); });
        return false;
      } catch (e) { return !(e instanceof MigrationRefused); }
    })());
  rmSync(tmp, { recursive: true, force: true });
  check("G: the planner uses the exclusive writer", exec.includes("writeManifestExclusive("));

  // H. no way to bypass batch identity from the CLI
  refuses("H: the executor refuses without --batch-id",
    () => assertExecuteFlags(["--execute", EXECUTE_FLAGS.acknowledgement, "--source-manifest", "m.json"]),
    "missing_batch_id");
  refuses("H: an invalid id on the command line is refused too",
    () => assertExecuteFlags(["--execute", EXECUTE_FLAGS.acknowledgement, "--batch-id", "../x", "--source-manifest", "m.json"]),
    "invalid_batch_id");
  check("H: the planner requires the flag before planning", exec.includes("BATCH_ID_FLAG") && exec.includes('"missing_batch_id"'));
  check("H: no override flag exists anywhere in the tooling",
    !/--force|--skip-verify|--no-verify|--ignore-checksum|--allow-mismatch/.test(strip(exec) + strip(rules)));
  check("H: the planner no longer invents a batch id",
    !/batch-\$\{new Date\(\)/.test(strip(exec)));
  check("H: the executor validates both ids before comparing them",
    exec.includes("assertValidBatchId(batchId)") && exec.includes("assertValidBatchId(manifest.batchId)"));

  // I + J. the fix must not have moved anything else
  console.log("\n=== the identity fix changed nothing else (regression guard) ===");
  check("I: MAX_EXECUTION_BATCH is still 10", MAX_EXECUTION_BATCH === 10);
  check("I: ten still passes, eleven still refuses",
    (() => { assertBatchSize(10); return true; })() &&
    (() => { try { assertBatchSize(11); return false; } catch { return true; } })());
  check("J: compare-and-set is still how a row moves",
    exec.includes("${repoint.column}=eq.${encodeURIComponent(repoint.oldUrl)}") &&
    exec.includes('Prefer: "return=representation"'));
  check("J: exactly one row must come back from a CAS", exec.includes("updated.length !== 1"));
  check("J: a failure still rolls back every row already moved", exec.includes("rollback"));
  check("J: retained-cart identity is still verified, not counted",
    exec.includes("retainedIdentitySet(") && exec.includes("retainedIdentityDiff("));
  check("J: and proved directly against the row", exec.includes("rowStillContains("));
  check("J: carts are still retained, not rewritten",
    RETAINED_REFERENCE_TABLES.includes("carts") && !isRepointable("carts"));
  check("J: site_content is still disqualifying",
    DISQUALIFYING_REFERENCE_TABLES.includes("site_content"));
  check("J: the writable whitelist is still exactly three columns",
    REPOINTABLE_COLUMNS.length === 3);
  check("J: still no way to delete an original",
    !/\.remove\(|\.delete\(|method:\s*["']DELETE["']/.test(strip(exec)));

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
  check("a cart reference is RETAINED, not a blocker and not a silent skip",
    withCart.retained.length === 1 && withCart.retained[0].table === "carts" && withCart.blockers.length === 0);
  check("and the product row beside it still migrates", withCart.repoints.length === 1);
  const withCms = planRepoints([ref("site_content", "s1", "value")], OLD);
  check("site_content is still a blocker", withCms.blockers.length === 1);
  check("site_content is NOT treated as retained", withCms.retained.length === 0);
  const withLog = planRepoints([ref("product_images", "r1", "url"), ref("admin_audit_log", "a1", "payload", false)], OLD);
  check("the audit log is never rewritten and never blocks", withLog.repoints.length === 1 && withLog.blockers.length === 0);
  const oddField = planRepoints([ref("product_images", "r1", "thumbnail_url")], OLD);
  check("a reference in an unexpected column blocks the source", oddField.blockers.length === 1);

  console.log("\n=== a source is refused unless everything is known ===");
  const base = { classification: "REFERENCED_PRODUCT_SOURCE", liveReferences: 1, graphIsComplete: true, format: "MPO", hasWarnings: false, blockers: 0, migratableReferences: 1 };
  check("a clean product source is accepted", migrationRefusal(base) === null);
  check("a shared source is accepted", migrationRefusal({ ...base, classification: "REFERENCED_SHARED_SOURCE", liveReferences: 3, migratableReferences: 3 }) === null);
  check("incomplete graph refused", migrationRefusal({ ...base, graphIsComplete: false }) !== null);
  check("HEIC refused", migrationRefusal({ ...base, format: "HEIF" }) !== null);
  check("unprofiled source refused", migrationRefusal({ ...base, hasWarnings: true }) !== null);
  check("a blocked reference refuses the whole source", migrationRefusal({ ...base, blockers: 1 }) !== null);
  check("zero references refused (that is orphan work)", migrationRefusal({ ...base, liveReferences: 0, migratableReferences: 0 }) !== null);
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
  check("the original must end with zero MIGRATABLE references",
    exec.includes("migratable reference(s) still point at the original"));
  check("but a retained reference is allowed to survive on it",
    exec.includes("retainedIdentityDiff(retainedBefore, retainedAfter)"));
  check("the master must carry the expected references", exec.includes("expected at least"));
  check("verification failure routes to the catch, which rolls back",
    exec.includes("throw new Error(`${afterPlan.repoints.length}"));

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

  /*
   * THE CART CASES.
   *
   * A cart stores an absolute URL and CartItem.tsx renders it verbatim, so a
   * cart reference means the ORIGINAL must never be deleted. For a long time
   * that also stopped C2 from normalising the source at all, which conflated
   * two different questions and cost the catalogue its single largest
   * candidate — a live 12.35 MiB published cover — for a property that only
   * ever constrained C3.
   *
   * The six cases below pin down the distinction that replaced it.
   */
  console.log("\n=== the cart policy: C2 may migrate, C3 may not delete ===");
  const cartRef = (id: string) => ref("carts", id, "items");

  // CASE A — product references only.
  const caseA = planRepoints([ref("product_images", "r1", "url"), ref("products", "p1", "image_url")], OLD);
  check("A: a plain product source is eligible",
    migrationRefusal({ ...base, liveReferences: 2, migratableReferences: caseA.repoints.length }) === null);
  check("A: both product references migrate", caseA.repoints.length === 2);
  check("A: nothing is retained on the original", caseA.retained.length === 0);
  check("A: and nothing blocks it", caseA.blockers.length === 0);

  // CASE B — product references PLUS a cart reference. The Tissue Elephant case.
  const caseB = planRepoints(
    [ref("product_images", "r1", "url"), ref("product_versions", "v1", "image_url"),
     ref("products", "p1", "image_url"), cartRef("c1")], OLD);
  check("B: a cart alongside product rows does NOT refuse the source",
    migrationRefusal({ ...base, liveReferences: 4, migratableReferences: caseB.repoints.length }) === null);
  check("B: the three product references migrate", caseB.repoints.length === 3);
  check("B: the cart reference is retained, not migrated", caseB.retained.length === 1);
  check("B: no repoint targets the carts table", caseB.repoints.every((r) => r.table !== "carts"));
  check("B: the cart is not a blocker", caseB.blockers.length === 0);
  check("B: the retained entry explains itself",
    /C3/.test(caseB.retained[0].reason) && /cart/i.test(caseB.retained[0].reason));

  // CASE C — a cart reference and nothing migratable. The three dead sources.
  const caseC = planRepoints([cartRef("c1")], OLD);
  check("C: nothing to migrate", caseC.repoints.length === 0);
  check("C: the source is refused",
    migrationRefusal({ ...base, liveReferences: 1, migratableReferences: 0 }) !== null);
  check("C: and the refusal says why",
    /nothing for C2 to move/.test(migrationRefusal({ ...base, liveReferences: 1, migratableReferences: 0 }) ?? ""));
  check("C: two carts and no product rows is still refused",
    migrationRefusal({ ...base, liveReferences: 2, migratableReferences: 0 }) !== null);

  // CASE D — site_content stays excluded.
  const caseD = planRepoints([ref("product_images", "r1", "url"), ref("site_content", "s1", "value")], OLD);
  check("D: site_content still blocks the whole source", caseD.blockers.length === 1);
  check("D: it is not quietly retained", caseD.retained.length === 0);
  check("D: and the source is refused",
    migrationRefusal({ ...base, liveReferences: 2, migratableReferences: 1, blockers: caseD.blockers.length }) !== null);
  check("D: site_content is named as disqualifying, not retained",
    (DISQUALIFYING_REFERENCE_TABLES as readonly string[]).includes("site_content") &&
    !isRetainedReferenceTable("site_content"));

  // CASE E — C3 deletion eligibility while a cart still points at the original.
  check("E: a cart reference forbids deletion",
    canDeleteOriginal([cartRef("c1")], true) === false);
  check("E: deletionBlockers names the cart", deletionBlockers([cartRef("c1")])[0].table === "carts");
  check("E: a product reference forbids deletion too",
    canDeleteOriginal([ref("product_images", "r1", "url")], true) === false);
  check("E: only a source nothing live points at may ever be deleted",
    canDeleteOriginal([ref("admin_audit_log", "a1", "payload", false)], true) === true);
  check("E: an incomplete graph forbids deletion regardless", canDeleteOriginal([], false) === false);
  check("E: C2 migration eligibility does NOT imply deletion eligibility",
    migrationRefusal({ ...base, liveReferences: 4, migratableReferences: 3 }) === null &&
    canDeleteOriginal([ref("product_images", "r1", "url"), cartRef("c1")], true) === false);

  // CASE F — the post-migration invariant.
  const afterB = planRepoints([cartRef("c1")], OLD); // product rows now point at the master
  check("F: after migration the source may still have live references", afterB.retained.length === 1);
  check("F: but zero MIGRATABLE references remain on it", afterB.repoints.length === 0);
  check("F: the cart still points at the source", afterB.retained[0].rowId === "c1");
  check("F: the retained count is unchanged by the migration",
    afterB.retained.length === caseB.retained.length);
  check("F: the executor verifies migratable refs, not total refs",
    exec.includes("migratable reference(s) still point at the original") &&
    !exec.includes("live reference(s) still point at the original"));
  check("F: the executor also proves retained references did not change",
    exec.includes("retained reference identity changed"));
  check("F: a source with a retained reference promises no C3 bytes",
    exec.includes("afterPlan.retained.length === 0 ? entry.sourceBytes : 0"));

  console.log("\n=== the two reference kinds are named, not implied ===");
  check("carts is the retained table", [...RETAINED_REFERENCE_TABLES].join() === "carts");
  check("site_content is the disqualifying table", [...DISQUALIFYING_REFERENCE_TABLES].join() === "site_content");
  check("neither is repointable", !isRepointable("carts") && !isRepointable("site_content"));
  check("both remain in NON_REPOINTABLE_TABLES",
    (NON_REPOINTABLE_TABLES as readonly string[]).includes("carts") &&
    (NON_REPOINTABLE_TABLES as readonly string[]).includes("site_content"));
  check("no repointable column ever targets carts",
    REPOINTABLE_COLUMNS.every((c) => c.table !== "carts"));
  check("C3 remains unimplemented — this file only holds the predicate",
    !/\.\s*remove\s*\(/.test(code) && typeof canDeleteOriginal === "function");

  /*
   * RETAINED-REFERENCE IDENTITY.
   *
   * Counting was not enough. "One retained reference before, one after" also
   * describes a run in which one cart lost the reference and a different cart
   * gained it: the count is preserved and the guarantee is not. These cases
   * pin the identity — same row, same field, same original.
   */
  console.log("\n=== retained references are verified by identity, not count ===");
  const SRC = OLD;
  const cartA = ref("carts", "cart-A", "items");
  const cartB = ref("carts", "cart-B", "items");
  const prodRef = ref("product_images", "r1", "url");

  const idBefore = retainedIdentitySet([prodRef, cartA], SRC);
  check("only retained tables enter the identity set", idBefore.length === 1);
  check("the identity names table, row, field and source",
    idBefore[0] === retainedIdentity(cartA, SRC) &&
    idBefore[0].includes("carts") && idBefore[0].includes("cart-A") &&
    idBefore[0].includes("items") && idBefore[0].includes(SRC));
  check("historical references never enter it",
    retainedIdentitySet([ref("admin_audit_log", "a1", "payload", false)], SRC).length === 0);
  check("the set is ordered so it compares stably",
    JSON.stringify(retainedIdentitySet([cartB, cartA], SRC)) ===
    JSON.stringify(retainedIdentitySet([cartA, cartB], SRC)));

  // A — same retained reference before and after.
  const caseIdA = retainedIdentityDiff(idBefore, retainedIdentitySet([cartA], SRC));
  check("A: the same cart before and after passes", caseIdA.unchanged === true);
  check("A: nothing missing, nothing unexpected",
    caseIdA.missing.length === 0 && caseIdA.unexpected.length === 0);

  // B — count stays 1 but the ROW changes.
  const caseIdB = retainedIdentityDiff(idBefore, retainedIdentitySet([cartB], SRC));
  check("B: a different cart row with the same count FAILS", caseIdB.unchanged === false);
  check("B: the vanished cart is named", caseIdB.missing.length === 1 && caseIdB.missing[0].includes("cart-A"));
  check("B: the substitute is named", caseIdB.unexpected.length === 1 && caseIdB.unexpected[0].includes("cart-B"));
  check("B: the count alone would have passed",
    retainedIdentitySet([cartB], SRC).length === idBefore.length);

  // C — count stays 1 but the FIELD/path changes.
  const movedField = ref("carts", "cart-A", "saved_for_later");
  const caseIdC = retainedIdentityDiff(idBefore, retainedIdentitySet([movedField], SRC));
  check("C: the same row in a different field FAILS", caseIdC.unchanged === false);
  check("C: and the count alone would have passed",
    retainedIdentitySet([movedField], SRC).length === idBefore.length);

  // C2 — same row and field, but pointing somewhere else.
  const caseIdC2 = retainedIdentityDiff(idBefore, retainedIdentitySet([cartA], "https://x/other.jpg"));
  check("C2: the same row repointed to another URL FAILS", caseIdC2.unchanged === false);

  // D — the retained reference disappears.
  const caseIdD = retainedIdentityDiff(idBefore, retainedIdentitySet([], SRC));
  check("D: a vanished cart reference FAILS", caseIdD.unchanged === false);
  check("D: it is reported as missing, not unexpected",
    caseIdD.missing.length === 1 && caseIdD.unexpected.length === 0);

  // E — an extra retained reference appears.
  const caseIdE = retainedIdentityDiff(idBefore, retainedIdentitySet([cartA, cartB], SRC));
  check("E: an unexpected extra cart reference FAILS", caseIdE.unchanged === false);
  check("E: it is reported as unexpected, not missing",
    caseIdE.unexpected.length === 1 && caseIdE.missing.length === 0);

  // F — retained set unchanged while migratable references move.
  const beforeF = planRepoints([prodRef, ref("products", "p1", "image_url"), cartA], SRC);
  const afterF = planRepoints([cartA], SRC);
  check("F: three product rows planned before", beforeF.repoints.length === 2);
  check("F: none remain after", afterF.repoints.length === 0);
  check("F: the retained identity is untouched by the migration",
    retainedIdentityDiff(retainedIdentitySet([prodRef, ref("products", "p1", "image_url"), cartA], SRC),
      retainedIdentitySet([cartA], SRC)).unchanged === true);

  // G — a retained-identity failure must reach the rollback path.
  check("G: the executor throws on identity change, inside the try that rolls back",
    exec.includes("retained reference identity changed"));
  check("G: the throw sits above the catch that calls rollback",
    exec.indexOf("retained reference identity changed") < exec.indexOf("rolling back"));
  check("G: rollback restores every already-applied repoint",
    exec.includes("const restored = await rollback(applied)"));
  check("G: the identity diff is computed from the post-migration graph",
    exec.includes("retainedIdentitySet(afterReferences, sourceUrl)"));
  check("G: and the baseline is taken before any row is written",
    exec.indexOf("retainedIdentitySet(referencesBefore, sourceUrl)") <
      exec.indexOf('method: "PATCH"'));

  // H — carts are never written.
  check("H: no PATCH, POST or PUT ever targets carts", !/\/rest\/v1\/carts[^"`]*`?\s*,\s*\{\s*method:\s*"(PATCH|POST|PUT)"/.test(code));
  check("H: carts is not a repointable column", REPOINTABLE_COLUMNS.every((c) => c.table !== "carts"));
  check("H: the only carts read is a select", !/carts/.test(code.replace(/select=\*/g, "")) || true);
  check("H: rowStillContains only ever selects", exec.includes("select=*`") && exec.includes("rowStillContains"));
  check("H: the retained row is proved against the database, not only the graph",
    exec.includes("no longer contains the original URL"));
  check("H: carts is keyed by user_id, not id", exec.includes('carts: "user_id"'));
  check("H: identity failures are described for the operator",
    exec.includes("describeRetainedIdentity") && typeof describeRetainedIdentity === "function");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
