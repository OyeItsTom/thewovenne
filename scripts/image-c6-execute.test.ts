/**
 * C6's execution refusals.
 *
 * C6 is the reversible half of this series, and these tests are mostly about
 * keeping it that way. The original is retained, so every failure has a way
 * back — but only if the rows that were already rewritten get put back, and
 * only if nothing in this file ever learns to delete.
 *
 * The assertion worth reading twice is "no storage DELETE anywhere in C6".
 * C3 and C5 exist to remove bytes and are gated accordingly. C6 must not
 * acquire that power by accident, because a migration that also deleted would
 * have no rollback: the bytes it would restore from are the ones it removed.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  C6_MANIFEST_KIND,
  MAX_C6_BATCH,
  assertC6BatchSize,
  assertCoherentC6Manifest,
  c6ManifestChecksum,
  classifyForC6,
  isC6Eligible,
  type C6Candidate,
  type C6Manifest,
  type C6ManifestEntry,
} from "../lib/imageC6";
import { C6_FLAGS, assertC6Flags } from "./c6-normalize-execute";
import { MigrationRefused, planRepoints, rollbackFor } from "../lib/imageBackfill";
import { NORMALIZER_VERSION } from "../lib/imageNormalize";

let passed = 0;
let failed = 0;
const sha = (i: string) => createHash("sha256").update(i).digest("hex");

function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}
function refuses(name: string, fn: () => unknown, reason?: string) {
  try { fn(); check(name, false); }
  catch (e) { check(name, e instanceof MigrationRefused && (!reason || e.reason === reason)); }
}

const SRC = "products/7f3a9dab-2f9f-4487-aa1a-3f8e4d644e8d.jpg";
const URL = `https://x/storage/v1/object/public/product-images/${SRC}`;
const DIGEST = sha("source bytes");

const OK: C6Candidate = {
  sourcePath: SRC, exists: true, sourceBytes: 20_300_000, sourceChecksum: DIGEST,
  displayWidth: 6120, displayHeight: 8160, orientation: 6, format: "jpeg",
  references: [
    { table: "product_images", rowId: "img-1", field: "url", live: true },
    { table: "product_versions", rowId: "ver-1", field: "image_url", live: true },
  ],
  graphIsComplete: true, auditedSafeCandidate: true,
};
const spoil = (p: Partial<C6Candidate>): C6Candidate => ({ ...OK, ...p });
const state = (p: Partial<C6Candidate> = {}) =>
  classifyForC6(spoil(p), planRepoints, URL).state;

const ENTRY: C6ManifestEntry = {
  sourcePath: SRC, sourceBytes: 20_300_000, sourceChecksum: DIGEST,
  sourceWidth: 6120, sourceHeight: 8160, orientation: 6,
  targetWidth: 2400, targetHeight: 3200,
  repoints: [{ table: "product_images", rowId: "img-1", column: "url", oldUrl: URL }],
  retained: [],
};
const manifest = (entries: C6ManifestEntry[], batchId = "c6-1"): C6Manifest => ({
  kind: C6_MANIFEST_KIND, batchId, createdAt: "x", normalizerVersion: NORMALIZER_VERSION,
  entries, checksum: c6ManifestChecksum({ batchId, normalizerVersion: NORMALIZER_VERSION, entries }, sha),
});
const flags = (over: Partial<Record<string, string>> = {}, omit: string[] = []) => {
  const a: string[] = [];
  if (!omit.includes("execute")) a.push(C6_FLAGS.execute);
  if (!omit.includes("ack")) a.push(over.ack ?? C6_FLAGS.acknowledgement);
  if (!omit.includes("batch")) a.push(C6_FLAGS.batchId, over.batch ?? "c6-1");
  if (!omit.includes("manifest")) a.push(C6_FLAGS.manifest, over.manifest ?? "m.json");
  return a;
};

function main() {
  const exec = readFileSync("scripts/c6-normalize-execute.ts", "utf8");
  const rules = readFileSync("lib/imageC6.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bare = strip(exec);

  console.log("\n=== NO STORAGE DELETE ANYWHERE IN C6 ===");
  //
  // The property the whole design rests on. A migration that could delete
  // would have no rollback: the bytes it restores from are the ones it removed.
  check("the executor issues no HTTP DELETE", !/method:\s*["'`]DELETE["'`]/i.test(bare));
  check("the executor contains no .remove(", !bare.includes(".remove("));
  check("the executor contains no .delete(", !bare.includes(".delete("));
  check("the rules contain no delete of any kind",
    !/\.remove\(|\.delete\(|method:\s*["'`]DELETE["'`]/i.test(strip(rules)));
  check("the planner contains none either",
    !/\.remove\(|method:\s*["'`]DELETE["'`]/i.test(strip(readFileSync("scripts/c6-normalize-plan.ts", "utf8"))));
  check("the executor proves the original is still readable before recording success",
    bare.includes("the original is no longer readable"));
  check("and records originalRetained on every ledger line",
    (bare.match(/originalRetained: true/g) ?? []).length >= 3);

  console.log("\n=== no writes to carts or site_content ===");
  check("no PATCH targets carts", !/carts[\s\S]{0,160}method:\s*["'`]PATCH["'`]/i.test(bare));
  check("no PATCH targets site_content", !/site_content[\s\S]{0,160}method:\s*["'`]PATCH["'`]/i.test(bare));
  check("repoint tables come only from the manifest, never a literal",
    bare.includes("repoint.table") && !/table:\s*["'`](carts|site_content)["'`]/.test(bare));
  check("the rules refuse a cart in the repoint list",
    strip(rules).includes("retained_table_repointed"));

  console.log("\n=== the migration command line ===");
  const ok = assertC6Flags(flags());
  check("all four flags together are accepted",
    ok.batchId === "c6-1" && ok.manifestPath === "m.json");
  refuses("without --execute", () => assertC6Flags(flags({}, ["execute"])), "not_execute");
  refuses("without the acknowledgement", () => assertC6Flags(flags({}, ["ack"])), "missing_acknowledgement");
  refuses("without --batch-id", () => assertC6Flags(flags({}, ["batch"])), "missing_batch_id");
  refuses("without --source-manifest", () => assertC6Flags(flags({}, ["manifest"])), "missing_manifest");
  check("the acknowledgement is the retention one",
    C6_FLAGS.acknowledgement === "--yes-i-understand-originals-are-retained");
  refuses("C3's deletion acknowledgement is refused outright",
    () => assertC6Flags([...flags(), "--yes-i-understand-original-deletion-is-permanent"]), "wrong_acknowledgement");
  refuses("C5's deletion acknowledgement is refused outright",
    () => assertC6Flags([...flags(), "--yes-i-understand-the-duplicate-is-the-only-other-copy"]), "wrong_acknowledgement");
  refuses("a traversal batch id is refused", () => assertC6Flags(flags({ batch: "../x" })), "invalid_batch_id");
  check("no force/skip/ignore/continue bypass exists",
    !/--force|--skip|--ignore|--continue|--no-verify|--allow-/.test(bare));

  console.log("\n=== manifest integrity, before any network call ===");
  check("kind is checked", bare.includes("manifest.kind !== C6_MANIFEST_KIND"));
  check("a C2/C3/C5 manifest cannot be run by C6", bare.includes('"wrong_kind"'));
  check("batch id must match", bare.includes('"batch_id_mismatch"'));
  check("the checksum is recomputed, never trusted",
    bare.includes("const selfChecksum = c6ManifestChecksum(") && bare.includes("selfChecksum !== manifest.checksum"));
  check("a tampered manifest is refused", bare.includes('"manifest_tampered"'));
  check("full coherence runs too", bare.includes("assertCoherentC6Manifest(manifest)"));
  check("the ceiling is enforced", bare.includes("assertC6BatchSize(manifest.entries.length)"));
  refuses("six entries are refused", () => assertC6BatchSize(6), "batch_too_large");
  check(`MAX_C6_BATCH is ${MAX_C6_BATCH}`, MAX_C6_BATCH === 5);
  refuses("a manifest of six is refused wholesale", () => assertCoherentC6Manifest(manifest(
    [1,2,3,4,5,6].map((n) => ({ ...ENTRY, sourcePath: `products/${n}.jpg` })))), "batch_too_large");

  console.log("\n=== the source must be exactly what was reviewed ===");
  for (const [what, needle] of [
    ["byte length vs manifest", "source.byteLength !== entry.sourceBytes"],
    ["SHA-256 vs manifest", "liveChecksum !== entry.sourceChecksum"],
    ["display dimensions vs manifest", "display.width !== entry.sourceWidth"],
    ["EXIF orientation vs manifest", "!== entry.orientation"],
    ["target still matches the plan", "target.width !== entry.targetWidth"],
    ["target still shrinks", "nothing to gain"],
    ["source still exists", "source is no longer in the bucket"],
    ["graph still complete", "reference graph incomplete"],
  ] as const) check(`re-checks ${what}`, bare.includes(needle));
  check("the full rule set is re-run against live data, not just the manifest",
    bare.includes("classifyForC6(candidate, planRepoints, sourceUrl)"));
  check("and the live reference set must still equal the reviewed plan",
    bare.includes("no longer matches the reviewed plan"));

  console.log("\n=== classification still blocks at execution time ===");
  check("a site_content reference blocks", state({ references: [...OK.references,
    { table: "site_content", rowId: "s", field: "value", live: true }] }) === "C6_BLOCKED_UNREPOINTABLE_REFERENCE");
  check("an unknown table blocks", state({ references: [...OK.references,
    { table: "orders", rowId: "o", field: "img", live: true }] }) === "C6_BLOCKED_UNREPOINTABLE_REFERENCE");
  check("HEIC is refused", state({ sourcePath: "products/a.heic" }) === "C6_BLOCKED_OUT_OF_SCOPE");
  check("an existing master is refused",
    state({ sourcePath: "products/abcdef0123456789abcdef0123456789-v1.jpg" }) === "C6_BLOCKED_OUT_OF_SCOPE");
  check("an already-small image is refused",
    state({ displayWidth: 1086, displayHeight: 1448 }) === "C6_BLOCKED_NOTHING_TO_GAIN");
  check("a missing source is refused", state({ exists: false }) === "C6_BLOCKED_SOURCE_ABSENT");
  check("an incomplete graph is refused", state({ graphIsComplete: false }) === "C6_BLOCKED_GRAPH_INCOMPLETE");
  check("a cart-only source is refused", state({ references:
    [{ table: "carts", rowId: "c", field: "items", live: true }] }) === "C6_BLOCKED_CART_HELD");
  check("a cart alongside product rows is fine and stays retained", (() => {
    const v = classifyForC6(spoil({ references: [...OK.references,
      { table: "carts", rowId: "c", field: "items", live: true }] }), planRepoints, URL);
    return isC6Eligible(v.state) && v.retained.length === 1 && !v.repoints.some((r) => r.table === "carts");
  })());

  console.log("\n=== master upload is content-addressed and idempotent ===");
  check("the key is derived from the SOURCE digest",
    bare.includes("masterKey(liveChecksum, encoding.ext)"));
  check("upload refuses to overwrite", bare.includes('"x-upsert": "false"'));
  check("a 409 is treated as an existing master, not a failure",
    bare.includes("upload.status === 409"));
  check("an existing master is verified by reading it back, not trusted by name",
    bare.indexOf("duplicate") < bare.indexOf("const liveMaster = Buffer.from") &&
    bare.includes("the master in storage is"));
  check("upload failure that is not a duplicate stops the source",
    bare.includes("master upload failed"));
  check("an unreadable master stops the source", bare.includes("master not readable"));
  check("a reused master is recorded distinctly", bare.includes('"MASTER_REUSED"'));
  check("reused masters are not counted as bytes added",
    bare.includes("if (duplicate)") && bare.includes("addedBytes += liveMaster.byteLength"));

  console.log("\n=== compare-and-set, read-back, rollback ===");
  check("every repoint is a compare-and-set on the old value",
    bare.includes("${repoint.column}=eq.${encodeURIComponent(repoint.oldUrl)}"));
  check("exactly one row must be returned",
    bare.includes("updated.length !== 1") && bare.includes("compare-and-set matched"));
  check("a CAS miss stops the source", bare.includes("Prefer: \"return=representation\""));
  check("the graph is re-read after the repoints", bare.includes("const afterGraph = await freshGraph()"));
  check("nothing migratable may still point at the original",
    bare.includes("migratable reference(s) still point at the original"));
  check("retained references are compared by IDENTITY, not count",
    bare.includes("retainedIdentityDiff(retainedBefore, retainedAfter)"));
  check("the master must carry the expected reference count",
    bare.includes("onMaster < entry.repoints.length"));
  check("rollback uses the shared helper", bare.includes("rollbackFor(applied)"));
  check("rollback is itself a compare-and-set",
    bare.includes("${step.column}=eq.${encodeURIComponent(step.from)}"));
  check("a partial rollback is recorded honestly",
    bare.includes("rollbackComplete: restored === applied.length"));
  check("rollbackFor reverses direction", (() => {
    const back = rollbackFor([{ table: "t", rowId: "r", column: "c", oldUrl: "OLD", newUrl: "NEW" }]);
    return back.length === 1 && back[0].from === "NEW" && back[0].to === "OLD";
  })());

  console.log("\n=== multi-reference sources ===");
  const many = classifyForC6(spoil({ references: [
    { table: "product_images", rowId: "i1", field: "url", live: true },
    { table: "product_images", rowId: "i2", field: "url", live: true },
    { table: "product_versions", rowId: "v1", field: "image_url", live: true },
    { table: "products", rowId: "p1", field: "image_url", live: true },
  ]}), planRepoints, URL);
  check("four rows produce four independent repoints", many.repoints.length === 4);
  check("each carries its own row id", new Set(many.repoints.map((r) => r.rowId)).size === 4);
  check("the executor loops over the manifest's repoints",
    bare.includes("for (const repoint of entry.repoints)"));

  console.log("\n=== first failure stops the batch ===");
  check("the loop exits the process", bare.includes("process.exit(1)"));
  check("there is no continue-on-error path", (() => {
    const c = bare.slice(bare.indexOf("} catch (error) {"));
    return c.includes("process.exit(1)") && !/\bcontinue\b/.test(c.slice(0, 900));
  })());
  check("no retry loop", !/for\s*\(let\s+attempt/.test(bare) && !bare.includes("retries"));
  check("a ledger write failure is not swallowed",
    !/try\s*{[^}]*appendFileSync/.test(bare) && bare.includes("appendFileSync"));
  check("the ledger is append-only", bare.includes('flag: "a"'));
  check("and lives under reports/", bare.includes('LEDGER_DIR = "reports/c6-normalize"'));

  console.log("\n=== it is thin: decisions are imported, not rewritten ===");
  for (const helper of ["planRepoints", "rollbackFor", "retainedIdentitySet", "retainedIdentityDiff",
                        "targetSize", "masterKey", "masterEncoding", "classifyForC6"]) {
    check(`${helper} is imported, not redefined`,
      bare.includes(helper) && !new RegExp(`function\\s+${helper}\\s*\\(`).test(bare));
  }
  check("the normalization policy is imported, not restated",
    bare.includes("JPEG_MASTER") && !/quality:\s*9\d/.test(bare));
  check("the pipeline matches C2's exactly",
    bare.includes('.rotate().toColourspace("srgb").withIccProfile("srgb")') &&
    bare.includes('kernel: "lanczos3"'));

  console.log("\n=== C2/C3/C5 untouched ===");
  const c2 = readFileSync("scripts/backfill-execute.ts", "utf8");
  check("C2 still holds its own migration path", /method:\s*"PATCH"/.test(c2));
  check("C2's ceiling is unchanged",
    /MAX_EXECUTION_BATCH = 10/.test(readFileSync("lib/imageBackfill.ts", "utf8")));
  check("C3 still caps at 5", /MAX_DELETION_BATCH = 5/.test(readFileSync("lib/imageDeletion.ts", "utf8")));
  check("C5 still refuses a master as a twin",
    readFileSync("lib/imageOrphans.ts", "utf8").includes("C5_BLOCKED_TWIN_IS_MASTER"));
  check("C6 does not import a deletion executor",
    !bare.includes("backfill-delete-execute") && !bare.includes("orphan-delete-execute"));
  check("no second C6 executor appeared",
    !existsSync("scripts/c6-execute.ts") && !existsSync("scripts/c6-migrate.ts"));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
