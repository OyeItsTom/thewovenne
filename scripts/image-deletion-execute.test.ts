/**
 * C3's execution refusals.
 *
 * Deletion has no rollback, so every test here is a check that a photograph
 * does NOT get removed, or that if one does, exactly one does and the evidence
 * survives. The source-reading assertions at the end matter as much as the
 * behavioural ones: they are what keeps this from quietly becoming a general
 * storage-deletion utility later.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DELETE_FLAGS,
  MANIFEST_KIND,
  MAX_DELETION_BATCH,
  assertDeleteFlags,
  assertDeletionBatchSize,
  assertNoLegacyExecutableField,
  assertSafeToDeletePath,
  classifyForDeletion,
  deletionManifestChecksum,
  isEligible,
  type DeletionCandidate,
  type DeletionManifestEntry,
  type DeletionStatus,
} from "../lib/imageDeletion";
import { MigrationRefused } from "../lib/imageBackfill";

let passed = 0;
let failed = 0;
const sha = (i: string) => createHash("sha256").update(i).digest("hex");

function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}
function refuses(name: string, fn: () => unknown, reason?: string) {
  try { fn(); check(name, false); }
  catch (e) {
    check(name, e instanceof MigrationRefused && (!reason || e.reason === reason));
  }
}

/* The real production values, so these are regressions and not fiction. */
const TISSUE_SOURCE = "products/473194b1-2af1-4d12-bc1e-54ac73334b39.jpg";
const TISSUE_CART_ROW = "ef0e4800-31cf-4c91-81c5-2c12b63674f3";

const OK: DeletionCandidate = {
  sourcePath: "products/7809e100-4045-4f4a-84c3-4f620a031fb5.jpg",
  sourceUrl: "https://x/products/7809e100.jpg",
  sourceBytes: 21_118_653,
  sourceExists: true,
  sourceFormat: "jpeg",
  masterPath: "products/5aad4c5964c94eb96a6fce7d1a91d515-v1.jpg",
  masterUrl: "https://x/products/5aad4c59-v1.jpg",
  masterExists: true,
  masterReadable: true,
  masterNormalizerVersion: 1,
  expectedNormalizerVersion: 1,
  masterLiveReferences: 3,
  ledgerVerified: true,
  graphIsComplete: true,
  liveReferencesOnSource: [],
  historicalReferencesOnSource: 0,
  unknownReferencesOnSource: 0,
};
const spoil = (p: Partial<DeletionCandidate>): DeletionCandidate => ({ ...OK, ...p });
const state = (p: Partial<DeletionCandidate>) => classifyForDeletion(spoil(p)).state;

const MASTER = "products/5aad4c5964c94eb96a6fce7d1a91d515-v1.jpg";
const ENTRY: DeletionManifestEntry = {
  sourcePath: OK.sourcePath,
  sourceBytes: OK.sourceBytes,
  sourceChecksum: "d".repeat(64),
  masterPath: MASTER,
  expectedLiveReferencesOnSource: 0,
  expectedLiveReferencesOnMaster: 3,
  historicalReferencesOnSource: 0,
};
const flags = (over: Partial<Record<string, string>> = {}, omit: string[] = []) => {
  const a: string[] = [];
  if (!omit.includes("execute")) a.push(DELETE_FLAGS.execute);
  if (!omit.includes("ack")) a.push(over.ack ?? DELETE_FLAGS.acknowledgement);
  if (!omit.includes("batch")) a.push(DELETE_FLAGS.batchId, over.batch ?? "c3-delete-1");
  if (!omit.includes("manifest")) a.push(DELETE_FLAGS.manifest, over.manifest ?? "m.json");
  return a;
};

function main() {
  const exec = readFileSync("scripts/backfill-delete-execute.ts", "utf8");
  const rules = readFileSync("lib/imageDeletion.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bare = strip(exec);

  console.log("\n=== the destructive command line ===");
  const ok = assertDeleteFlags(flags());
  check("all four flags together are accepted", ok.batchId === "c3-delete-1" && ok.manifestPath === "m.json");
  refuses("without --execute", () => assertDeleteFlags(flags({}, ["execute"])), "not_execute");
  refuses("without the acknowledgement", () => assertDeleteFlags(flags({}, ["ack"])), "missing_acknowledgement");
  refuses("without --batch-id", () => assertDeleteFlags(flags({}, ["batch"])), "missing_batch_id");
  refuses("without --source-manifest", () => assertDeleteFlags(flags({}, ["manifest"])), "missing_manifest");
  refuses("an invalid batch id", () => assertDeleteFlags(flags({ batch: "../x" })), "invalid_batch_id");
  check("the acknowledgement names permanence",
    DELETE_FLAGS.acknowledgement.includes("permanent"));
  check("it is NOT the C2 acknowledgement",
    (DELETE_FLAGS.acknowledgement as string) !== "--yes-i-understand-originals-are-retained");
  refuses("offering C2's acknowledgement is an error, not a no-op",
    () => assertDeleteFlags([...flags(), "--yes-i-understand-originals-are-retained"]),
    "wrong_acknowledgement");
  check("no bypass flag exists in the executor",
    !/--force|--skip|--ignore|--continue-on-error|--delete-all|--no-verify|--yes-to-all/.test(bare));

  console.log("\n=== the ceiling is hard-coded and smaller than C2's ===");
  check(`MAX_DELETION_BATCH is ${MAX_DELETION_BATCH}`, MAX_DELETION_BATCH === 5);
  check("smaller than the C2 ceiling of 10", MAX_DELETION_BATCH < 10);
  check("five allowed", (() => { assertDeletionBatchSize(5); return true; })());
  refuses("six refused", () => assertDeletionBatchSize(6), "batch_too_large");
  refuses("fifty refused", () => assertDeletionBatchSize(50), "batch_too_large");
  refuses("zero refused", () => assertDeletionBatchSize(0), "empty_batch");
  check("no CLI flag can raise it", !/--batch-size|--limit\b|maxDelet|MAX_DELETION_BATCH\s*=/.test(bare));
  check("the executor asserts it before anything else",
    bare.includes("assertDeletionBatchSize(manifest.entries.length)"));

  console.log("\n=== manifest integrity ===");
  const subject = { batchId: "c3-delete-1", normalizerVersion: 1, entries: [ENTRY] };
  const sum = deletionManifestChecksum(subject, sha);
  check("stable", deletionManifestChecksum(subject, sha) === sum);
  check("batch id is covered", deletionManifestChecksum({ ...subject, batchId: "c3-delete-2" }, sha) !== sum);
  check("normalizer version is covered",
    deletionManifestChecksum({ ...subject, normalizerVersion: 2 }, sha) !== sum);
  check("source path is covered",
    deletionManifestChecksum({ ...subject, entries: [{ ...ENTRY, sourcePath: "products/other.jpg" }] }, sha) !== sum);
  check("source bytes are covered",
    deletionManifestChecksum({ ...subject, entries: [{ ...ENTRY, sourceBytes: 1 }] }, sha) !== sum);
  check("source checksum is covered",
    deletionManifestChecksum({ ...subject, entries: [{ ...ENTRY, sourceChecksum: "e".repeat(64) }] }, sha) !== sum);
  check("master path is covered",
    deletionManifestChecksum({ ...subject, entries: [{ ...ENTRY, masterPath: "products/zz-v1.jpg" }] }, sha) !== sum);
  check("expected source reference state is covered",
    deletionManifestChecksum({ ...subject, entries: [{ ...ENTRY, expectedLiveReferencesOnSource: 1 }] }, sha) !== sum);
  check("expected master reference state is covered",
    deletionManifestChecksum({ ...subject, entries: [{ ...ENTRY, expectedLiveReferencesOnMaster: 9 }] }, sha) !== sum);
  check("the executor recomputes rather than trusting the file",
    bare.includes("const selfChecksum = deletionManifestChecksum(") && bare.includes("selfChecksum !== manifest.checksum"));
  check("and refuses a tampered manifest", bare.includes('"manifest_tampered"'));
  check("kind is checked", bare.includes("manifest.kind !== MANIFEST_KIND") && MANIFEST_KIND === "c3-delete");
  check("a C2 manifest cannot be passed to C3", bare.includes('"wrong_kind"'));
  check("duplicate source paths are refused", bare.includes('"duplicate_entries"'));
  check("batch id mismatch refused", bare.includes('"batch_id_mismatch"'));
  check("normalizer mismatch refused", bare.includes('"version_mismatch"'));

  console.log("\n=== the retired executable flag can neither forbid nor authorise ===");
  //
  // THE BUG THIS LOCKS OUT. The planner wrote `executable: false` into every
  // manifest; the executor never read it. So manifest-c3-delete-2.json declared
  // itself non-executable while the executor stood ready to delete all five
  // originals it named. The field said one thing, the tool did another, and
  // nothing in the suite noticed because the only assertion about it checked
  // that the planner still WROTE the misleading value.
  //
  // The resolution is fail-closed on provenance rather than a corrected
  // boolean: a manifest carrying the key at all was written by tooling whose
  // semantics this executor cannot vouch for, so it is refused. Refusing
  // `true` as loudly as `false` is the point — it stops the field being
  // reintroduced later as a forgeable permission slip.
  const legacy = (v: unknown) => () => assertNoLegacyExecutableField({
    kind: MANIFEST_KIND, batchId: "c3-delete-2", createdAt: "x",
    normalizerVersion: 1, executable: v, entries: [ENTRY], checksum: "z",
  });
  refuses("executable:false is refused, not silently accepted", legacy(false), "legacy_executable_field");
  refuses("executable:true is refused just as hard", legacy(true), "legacy_executable_field");
  refuses("the string \"true\" does not slip through", legacy("true"), "legacy_executable_field");
  refuses("nor 1", legacy(1), "legacy_executable_field");
  refuses("nor null", legacy(null), "legacy_executable_field");
  refuses("nor undefined-as-an-own-key", legacy(undefined), "legacy_executable_field");
  check("a manifest without the key passes the guard", (() => {
    assertNoLegacyExecutableField({
      kind: MANIFEST_KIND, batchId: "c3-delete-2", createdAt: "x",
      normalizerVersion: 1, entries: [ENTRY], checksum: "z",
    });
    return true;
  })());
  check("a non-object is left to the checks that name it better", (() => {
    assertNoLegacyExecutableField(null);
    assertNoLegacyExecutableField("not a manifest");
    return true;
  })());
  check("an inherited 'executable' is not treated as the file's own", (() => {
    assertNoLegacyExecutableField(Object.create({ executable: false }));
    return true;
  })());

  check("the executor actually calls the guard", bare.includes("assertNoLegacyExecutableField("));
  check("and calls it before it trusts the parsed shape",
    bare.indexOf("assertNoLegacyExecutableField(") < bare.indexOf("manifest.kind !== MANIFEST_KIND"));
  check("the manifest type no longer declares the field",
    !/executable\s*:/.test(strip(rules).split("export interface DeletionManifest")[1]?.split("}")[0] ?? ""));
  check("the planner no longer writes it",
    !/executable\s*:/.test(strip(readFileSync("scripts/backfill-delete-plan.ts", "utf8"))));
  check("no flag can wave the guard away",
    !/--force|--skip-verif|--ignore-checksum|--allow-legacy|--ignore-executable/.test(bare));
  //
  // The guard is deliberately outside the checksum: the checksum fingerprints
  // what a person reviewed, and this key is not that. Asserting it here keeps
  // anyone from "fixing" the drift later by folding the field into the digest,
  // which would silently invalidate every manifest already on disk.
  check("the checksum still ignores the field entirely",
    deletionManifestChecksum({ ...subject, ...( { executable: false } as object) }, sha) === sum);
  check("the checksum subject is still batch id, normalizer version and entries",
    !/executable/.test(strip(rules).split("export function deletionManifestChecksum")[1]?.split("\n}")[0] ?? ""));

  console.log("\n=== every eligibility condition still blocks at execution time ===");
  check("a product_images reference blocks",
    state({ liveReferencesOnSource: [{ table: "product_images", rowId: "i", field: "url" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("a products reference blocks",
    state({ liveReferencesOnSource: [{ table: "products", rowId: "p", field: "image_url" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("a product_versions reference blocks",
    state({ liveReferencesOnSource: [{ table: "product_versions", rowId: "v", field: "image_url" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("a cart reference blocks",
    state({ liveReferencesOnSource: [{ table: "carts", rowId: "c", field: "items" }] }) === "C3_BLOCKED_CART");
  check("a site_content reference blocks",
    state({ liveReferencesOnSource: [{ table: "site_content", rowId: "s", field: "body" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("an unknown live reference blocks",
    state({ liveReferencesOnSource: [{ table: "future_table", rowId: "z", field: "img" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("an unclassified reference blocks", state({ unknownReferencesOnSource: 1 }) === "C3_MANUAL_REVIEW");
  check("an incomplete graph blocks", state({ graphIsComplete: false }) === "C3_BLOCKED_GRAPH_INCOMPLETE");
  check("a missing master blocks", state({ masterExists: false }) === "C3_BLOCKED_MASTER_MISSING");
  check("an unreadable master blocks", state({ masterReadable: false }) === "C3_BLOCKED_MASTER_UNREADABLE");
  check("an unreferenced master blocks", state({ masterLiveReferences: 0 }) === "C3_BLOCKED_MASTER_UNREFERENCED");
  check("a wrong normalizer version blocks", state({ masterNormalizerVersion: 2 }) === "C3_BLOCKED_VERSION_MISMATCH");
  check("HEIC blocks", state({ sourceFormat: "HEIF" }) === "C3_MANUAL_REVIEW");
  check("a non-C2 source blocks", state({ ledgerVerified: false }) === "C3_MANUAL_REVIEW");
  check("a master-shaped source blocks",
    state({ sourcePath: "products/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v1.jpg" }) === "C3_BLOCKED_IS_MASTER");
  check("the executor refuses anything not eligible", bare.includes("if (!isEligible(verdict.state))"));

  console.log("\n=== the cart-blocked source, as a live regression ===");
  const tissue = spoil({
    sourcePath: TISSUE_SOURCE,
    liveReferencesOnSource: [{ table: "carts", rowId: TISSUE_CART_ROW, field: "items" }],
  });
  const tv = classifyForDeletion(tissue);
  check("the real cart-held source is not eligible", !isEligible(tv.state));
  check("it is classified as cart-blocked", tv.state === "C3_BLOCKED_CART");
  check("the blocking cart row is named, not counted", tv.blockers[0].rowId === TISSUE_CART_ROW);
  check("the blocker names the table and field",
    tv.blockers[0].table === "carts" && tv.blockers[0].field === "items");
  check("it becomes eligible only once the basket lets go",
    isEligible(classifyForDeletion(spoil({ sourcePath: TISSUE_SOURCE })).state));

  console.log("\n=== exactly one object, never a master, never a prefix ===");
  check("a normal original passes the path guard",
    (() => { assertSafeToDeletePath(OK.sourcePath, MASTER); return true; })());
  refuses("a master-shaped path refused",
    () => assertSafeToDeletePath("products/abc-v1.jpg", "products/abc-v1.jpg"), "unsafe_delete_path");
  refuses("a .webp master refused",
    () => assertSafeToDeletePath("products/abc-v1.webp", "products/other-v1.jpg"), "unsafe_delete_path");
  refuses("sourcePath === masterPath refused",
    () => assertSafeToDeletePath("products/same.jpg", "products/same.jpg"), "unsafe_delete_path");
  refuses("a folder refused", () => assertSafeToDeletePath("products/", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("a wildcard refused", () => assertSafeToDeletePath("products/*", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("a traversal refused", () => assertSafeToDeletePath("products/../x", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("an empty path refused", () => assertSafeToDeletePath("", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("outside products/ refused",
    () => assertSafeToDeletePath("staging/x.jpg", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("a HEIC path refused",
    () => assertSafeToDeletePath("products/x.heic", "products/m-v1.jpg"), "unsafe_delete_path");
  check("the guard runs immediately before the delete call",
    bare.indexOf("assertSafeToDeletePath(") < bare.indexOf('method: "DELETE"') &&
    bare.indexOf("assertSafeToDeletePath(") > bare.indexOf("const digest = sha256Bytes"));
  check("the delete targets one interpolated path, not a prefix",
    bare.includes("/storage/v1/object/${BUCKET}/${entry.sourcePath}"));
  check("there is exactly one DELETE in the executor",
    (bare.match(/method:\s*"DELETE"/g) ?? []).length === 1);
  check("the delete uses the manifest path, never a derived one",
    !/sourcePath\.(replace|slice|split)|dirname\(|prefix/i.test(bare.split('method: "DELETE"')[0].slice(-800)));

  console.log("\n=== evidence is written before the object is destroyed ===");
  const predelete = bare.indexOf('record("PREDELETE_VERIFIED")');
  const requested = bare.indexOf('record("DELETE_REQUESTED"');
  const deleteCall = bare.indexOf('method: "DELETE"');
  check("PREDELETE_VERIFIED is appended before the request", predelete > 0 && predelete < deleteCall);
  check("DELETE_REQUESTED is appended before the request", requested > 0 && requested < deleteCall);
  check("the evidence carries the source checksum", bare.includes("sourceChecksum: digest"));
  check("and the manifest checksum", bare.includes("manifestChecksum: manifest.checksum"));
  check("and the master's reference identities",
    bare.includes("liveReferenceIdentitiesOnMaster"));
  check("a ledger write that throws prevents the delete — it is not caught",
    !/try\s*\{\s*appendLedger/.test(bare));
  check("the ledger is append-only", bare.includes('flag: "a"') && !bare.includes("writeFileSync"));
  check("the ledger is local and gitignored", bare.includes('LEDGER_DIR = "reports/image-backfill"'));
  const statuses: DeletionStatus[] = ["PREDELETE_VERIFIED", "DELETE_REQUESTED", "DELETE_CONFIRMED", "FAILED"];
  check("all four required statuses are recorded", statuses.every((s) => bare.includes(`"${s}"`)));

  console.log("\n=== post-delete verification ===");
  check("the source is re-checked after the delete", bare.includes("const stillThere = await objectExists("));
  check("a source that survives is a failure", bare.includes("delete reported success but the source still exists"));
  check("the master is re-checked after the delete", bare.includes("const masterAfter = await objectHead("));
  check("an unreadable master stops the batch", bare.includes("MASTER UNREADABLE AFTER DELETE"));
  check("the master's references are re-counted after the delete",
    bare.includes("const masterRefsAfter = graphAfter.liveReferenceCount("));
  check("only then is DELETE_CONFIRMED written",
    bare.indexOf('record("DELETE_CONFIRMED"') > bare.indexOf("const masterAfter = await objectHead("));

  console.log("\n=== idempotency ===");
  check("an already-absent source is its own status", bare.includes('record("ALREADY_ABSENT"'));
  check("it is skipped, not deleted again", bare.includes("no deletion attempted"));
  check("and it is not treated as a failure",
    bare.indexOf('record("ALREADY_ABSENT"') < bare.indexOf('record("REFUSED"'));
  check("nothing is deleted in its place — the loop just continues",
    /ALREADY_ABSENT[\s\S]{0,220}continue;/.test(bare));

  console.log("\n=== first failure stops the whole batch ===");
  check("the failure path exits the process", bare.includes("process.exit(1)"));
  check("it does not continue to the next object",
    /catch \(error\)[\s\S]{0,900}process\.exit\(1\)/.test(bare));
  check("no continue-on-error anywhere", !/continueOnError|skipFailed|catch[\s\S]{0,80}continue;/.test(bare));
  check("the message says how many were already deleted",
    bare.includes("original(s) deleted before this point"));
  check("there is no rollback attempt, because there is none to make",
    !/rollback/i.test(bare));

  console.log("\n=== C3 touches storage only — no database writes ===");
  check("no PATCH anywhere", !/method:\s*["'`]PATCH["'`]/i.test(bare));
  check("no PUT anywhere", !/method:\s*["'`]PUT["'`]/i.test(bare));
  check("no POST to a table", !/rest\/v1\/[\s\S]{0,200}method:\s*["'`]POST["'`]/i.test(bare));
  check("the only /rest/v1 calls are select=*",
    (bare.match(/rest\/v1\/\$\{[^}]+\}\?[^`]*/g) ?? []).every((u) => u.includes("select=*")));
  check("carts are never addressed directly", !bare.includes("rest/v1/carts"));
  check("site_content is never addressed directly", !bare.includes("rest/v1/site_content"));
  check("there is exactly one table fetch in the whole executor",
    (bare.match(/rest\/v1\//g) ?? []).length === 1);
  check("and it is the generic read loop, with no method and no body",
    /rest\/v1\/\$\{table\}\?select=\*`,\s*\{ headers: headers\(\) \}/.test(bare));
  check("no request to a table carries a body", !/rest\/v1[\s\S]{0,300}body:/i.test(bare));
  check("the only body-bearing call is none at all", !bare.includes("body: JSON.stringify"));
  check("no supabase-js client is constructed", !bare.includes("createClient"));

  console.log("\n=== orphans, HEIC and generic deletion stay out ===");
  check("candidates come only from C2 ledger pairings", bare.includes("const pairings = ledgerPairings()"));
  check("a path with no pairing stops the batch",
    bare.includes("no verified C2 ledger row — not a proven C2 original"));
  check("only migrated AND verified rows count",
    bare.includes('row.status !== "migrated" || row.verification !== "passed"'));
  check("the pairing must agree with the manifest's master",
    bare.includes("pairing.masterPath !== entry.masterPath"));
  check("the pairing must agree about bytes and checksum",
    bare.includes("pairing.sourceBytes !== entry.sourceBytes") &&
    bare.includes("pairing.sourceChecksum !== entry.sourceChecksum"));
  check("there is no flag to name a path directly",
    !/--path|--object|--key\b|--source\b(?!-manifest)/.test(bare));
  check("there is no bucket-wide listing to iterate",
    !bare.includes("object/list/"));
  check("HEIC is refused by the path guard too", rules.includes("heic|heif"));

  console.log("\n=== C2's guarantee is preserved, narrowly ===");
  const c2test = readFileSync("scripts/image-backfill-execute.test.ts", "utf8");
  check("the C2 suite still asserts C2 cannot delete",
    c2test.includes("the C2 executor still has no way to delete an original"));
  check("it names what it covers rather than claiming 'the tooling'",
    c2test.includes("J: nor do the C2 rules") && !c2test.includes("still no way to delete an original\","));
  const c2exec = readFileSync("scripts/backfill-execute.ts", "utf8");
  check("the C2 executor really contains no deletion",
    !/\.remove\(|\.delete\(|method:\s*["'`]DELETE["'`]/.test(strip(c2exec)));
  check("the C2 planner contains no deletion",
    !/\.remove\(|\.delete\(|method:\s*["'`]DELETE["'`]/.test(strip(readFileSync("scripts/backfill-delete-plan.ts", "utf8"))));
  check("deletion lives in exactly one file",
    ["scripts/backfill-execute.ts", "scripts/backfill-delete-plan.ts", "lib/imageDeletion.ts", "lib/imageBackfill.ts"]
      .every((f) => !/method:\s*["'`]DELETE["'`]/.test(strip(readFileSync(f, "utf8")))));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
