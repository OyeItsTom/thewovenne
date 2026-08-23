/**
 * C3's refusals.
 *
 * Every test here is a check that a photograph does NOT get deleted. C3 is the
 * first irreversible step in this series — C2 could be undone by pointing rows
 * back, but a deleted original is gone — so what is worth asserting is where it
 * stops, and that in this PR it cannot start at all.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  MAX_DELETION_BATCH,
  assertDeletionBatchSize,
  classifyForDeletion,
  deletionManifestChecksum,
  isEligible,
  looksLikeMaster,
  HISTORICAL_REFERENCES_DECISION,
  type DeletionCandidate,
  type DeletionManifestEntry,
} from "../lib/imageDeletion";
import {
  MigrationRefused,
  assertValidBatchId,
  manifestPathFor,
  writeManifestExclusive,
} from "../lib/imageBackfill";

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
    const ok = e instanceof MigrationRefused && (!reason || e.reason === reason);
    check(name, ok);
  }
}

/** A candidate that passes everything. Each test spoils exactly one thing. */
const OK: DeletionCandidate = {
  sourcePath: "products/original.jpg",
  sourceUrl: "https://x/storage/v1/object/public/product-images/products/original.jpg",
  sourceBytes: 20_000_000,
  sourceExists: true,
  sourceFormat: "jpeg",
  masterPath: "products/abcdef0123456789abcdef0123456789-v1.jpg",
  masterUrl: "https://x/storage/v1/object/public/product-images/products/abcdef0123456789abcdef0123456789-v1.jpg",
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

function main() {
  const src = readFileSync("scripts/backfill-delete-plan.ts", "utf8");
  const rules = readFileSync("lib/imageDeletion.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  console.log("\n=== the happy path, so the refusals mean something ===");
  check("a fully verified, unreferenced original is eligible", state({}) === "C3_DELETE_ELIGIBLE");
  check("isEligible agrees", isEligible(classifyForDeletion(OK).state));

  console.log("\n=== a live reference always wins ===");
  check("one cart reference blocks",
    state({ liveReferencesOnSource: [{ table: "carts", rowId: "c1", field: "items" }] }) === "C3_BLOCKED_CART");
  check("one product_images reference blocks",
    state({ liveReferencesOnSource: [{ table: "product_images", rowId: "i1", field: "url" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("one products reference blocks",
    state({ liveReferencesOnSource: [{ table: "products", rowId: "p1", field: "image_url" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("one product_versions reference blocks",
    state({ liveReferencesOnSource: [{ table: "product_versions", rowId: "v1", field: "image_url" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("one site_content reference blocks",
    state({ liveReferencesOnSource: [{ table: "site_content", rowId: "s1", field: "body" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("an unknown table blocks",
    state({ liveReferencesOnSource: [{ table: "some_future_table", rowId: "z1", field: "img" }] }) === "C3_BLOCKED_LIVE_REFERENCE");
  check("an unclassifiable reference goes to manual review",
    state({ unknownReferencesOnSource: 1 }) === "C3_MANUAL_REVIEW");
  check("the cart blocker is named, not just counted",
    classifyForDeletion(spoil({ liveReferencesOnSource: [{ table: "carts", rowId: "cart-7", field: "items" }] }))
      .blockers[0].rowId === "cart-7");
  check("a shared original — someone else's row still points here — blocks",
    state({ liveReferencesOnSource: [{ table: "product_images", rowId: "other-product-row", field: "url" }] })
      === "C3_BLOCKED_LIVE_REFERENCE");

  console.log("\n=== the master must be a real replacement ===");
  check("a missing master blocks", state({ masterExists: false }) === "C3_BLOCKED_MASTER_MISSING");
  check("a null master path blocks", state({ masterPath: null }) === "C3_BLOCKED_MASTER_MISSING");
  check("an unreadable master blocks", state({ masterReadable: false }) === "C3_BLOCKED_MASTER_UNREADABLE");
  check("a wrong normalizer version blocks",
    state({ masterNormalizerVersion: 2 }) === "C3_BLOCKED_VERSION_MISMATCH");
  check("a null normalizer version blocks",
    state({ masterNormalizerVersion: null }) === "C3_BLOCKED_VERSION_MISMATCH");
  check("a master nothing points at blocks",
    state({ masterLiveReferences: 0 }) === "C3_BLOCKED_MASTER_UNREFERENCED");

  console.log("\n=== structural doubt beats everything ===");
  check("an incomplete graph blocks even a perfect candidate",
    state({ graphIsComplete: false }) === "C3_BLOCKED_GRAPH_INCOMPLETE");
  check("and it outranks a cart reference",
    state({ graphIsComplete: false, liveReferencesOnSource: [{ table: "carts", rowId: "c1", field: "items" }] })
      === "C3_BLOCKED_GRAPH_INCOMPLETE");

  console.log("\n=== only proven C2 originals are in scope ===");
  check("no C2 ledger row -> manual review, never eligible",
    state({ ledgerVerified: false }) === "C3_MANUAL_REVIEW");
  check("HEIC is out of scope", state({ sourceFormat: "HEIF" }) === "C3_MANUAL_REVIEW");
  check("an original already gone -> manual review", state({ sourceExists: false }) === "C3_MANUAL_REVIEW");
  check("a master is never a deletion candidate",
    state({ sourcePath: "products/abcdef0123456789abcdef0123456789-v1.jpg" }) === "C3_BLOCKED_IS_MASTER");
  check("looksLikeMaster recognises the -v1 convention",
    looksLikeMaster("products/abc-v1.jpg") && looksLikeMaster("products/abc-v2.webp"));
  check("and does not mistake an original for one",
    !looksLikeMaster("products/7809e100-4045-4f4a-84c3-4f620a031fb5.jpg"));

  console.log("\n=== historical (audit-log) references ===");
  check("a historical mention does NOT block", state({ historicalReferencesOnSource: 4 }) === "C3_DELETE_ELIGIBLE");
  check("but it is recorded in the reason",
    classifyForDeletion(spoil({ historicalReferencesOnSource: 4 })).reason.includes("historical"));
  check("the decision is documented, not implicit",
    HISTORICAL_REFERENCES_DECISION === "recorded, not blocking" && rules.includes("AuditLog.tsx"));
  check("a historical mention alongside a live one still blocks",
    state({ historicalReferencesOnSource: 4, liveReferencesOnSource: [{ table: "carts", rowId: "c1", field: "items" }] })
      === "C3_BLOCKED_CART");

  console.log("\n=== nothing uncertain is ever collapsed into eligible ===");
  const spoilers: Array<Partial<DeletionCandidate>> = [
    { graphIsComplete: false }, { ledgerVerified: false }, { sourceExists: false },
    { sourceFormat: "HEIF" }, { masterExists: false }, { masterReadable: false },
    { masterNormalizerVersion: 9 }, { masterLiveReferences: 0 }, { unknownReferencesOnSource: 1 },
    { liveReferencesOnSource: [{ table: "carts", rowId: "c", field: "items" }] },
    { sourcePath: "products/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v1.jpg" },
  ];
  check(`none of the ${spoilers.length} spoiled candidates is eligible`,
    spoilers.every((s) => !isEligible(state(s))));

  console.log("\n=== the deletion manifest checksum ===");
  const entries: DeletionManifestEntry[] = [
    { sourcePath: "products/a.jpg", sourceBytes: 100, sourceChecksum: "a".repeat(64),
      masterPath: "products/aa-v1.jpg",
      expectedLiveReferencesOnSource: 0, expectedLiveReferencesOnMaster: 2, historicalReferencesOnSource: 0 },
  ];
  const subject = { batchId: "c3-delete-1", normalizerVersion: 1, entries };
  const sum = deletionManifestChecksum(subject, sha);
  check("stable across repeated computation", deletionManifestChecksum(subject, sha) === sum);
  check("order does not matter", deletionManifestChecksum({ ...subject, entries: [...entries].reverse() }, sha) === sum);
  check("changing the batch id changes it",
    deletionManifestChecksum({ ...subject, batchId: "c3-delete-2" }, sha) !== sum);
  check("changing the normalizer version changes it",
    deletionManifestChecksum({ ...subject, normalizerVersion: 2 }, sha) !== sum);
  check("changing the source changes it",
    deletionManifestChecksum({ ...subject, entries: [{ ...entries[0], sourcePath: "products/b.jpg" }] }, sha) !== sum);
  check("changing the master changes it",
    deletionManifestChecksum({ ...subject, entries: [{ ...entries[0], masterPath: "products/bb-v1.jpg" }] }, sha) !== sum);
  check("changing the source checksum changes it",
    deletionManifestChecksum({ ...subject, entries: [{ ...entries[0], sourceChecksum: "b".repeat(64) }] }, sha) !== sum);
  check("changing the byte size changes it",
    deletionManifestChecksum({ ...subject, entries: [{ ...entries[0], sourceBytes: 101 }] }, sha) !== sum);
  check("changing the expected source reference state changes it",
    deletionManifestChecksum({ ...subject, entries: [{ ...entries[0], expectedLiveReferencesOnSource: 1 }] }, sha) !== sum);
  check("changing the expected master reference state changes it",
    deletionManifestChecksum({ ...subject, entries: [{ ...entries[0], expectedLiveReferencesOnMaster: 3 }] }, sha) !== sum);
  check("changing the historical count changes it",
    deletionManifestChecksum({ ...subject, entries: [{ ...entries[0], historicalReferencesOnSource: 1 }] }, sha) !== sum);
  check("a C3 checksum is not a C2 checksum over the same entries",
    deletionManifestChecksum(subject, sha) !== sha(JSON.stringify(entries)));

  console.log("\n=== batch identity and no-clobber, on the C2 model ===");
  check("a valid id passes", assertValidBatchId("c3-delete-1") === "c3-delete-1");
  refuses("traversal refused", () => assertValidBatchId("../x"), "invalid_batch_id");
  refuses("separator refused", () => assertValidBatchId("c3/delete"), "invalid_batch_id");
  refuses("whitespace refused", () => assertValidBatchId("c3 delete 1"), "invalid_batch_id");
  refuses("empty refused", () => assertValidBatchId(""), "invalid_batch_id");
  refuses("control character refused", () => assertValidBatchId("c3\u0007delete"), "invalid_batch_id");
  refuses("NUL refused", () => assertValidBatchId("c3\u0000delete"), "invalid_batch_id");
  refuses("overly long refused", () => assertValidBatchId("c".repeat(200)), "invalid_batch_id");
  check("the manifest path stays in the report directory",
    manifestPathFor("c3-delete-1") === "reports/image-backfill/manifest-c3-delete-1.json");

  const tmp = mkdtempSync(join(tmpdir(), "wovenne-c3-"));
  const p = join(tmp, "manifest-c3-delete-1.json");
  const w = (path: string, data: string) => writeFileSync(path, data, { flag: "wx" });
  const doc = { batchId: "c3-delete-1", createdAt: "x", normalizerVersion: 1, entries, checksum: sum };
  writeManifestExclusive(p, doc as never, w);
  check("the first write lands", existsSync(p));
  refuses("a second write to the same id is refused",
    () => writeManifestExclusive(p, doc as never, w), "manifest_exists");
  rmSync(tmp, { recursive: true, force: true });

  console.log("\n=== the batch ceiling is smaller than C2's, on purpose ===");
  check(`MAX_DELETION_BATCH is ${MAX_DELETION_BATCH}`, MAX_DELETION_BATCH === 5);
  check("it is smaller than the C2 ceiling of 10", MAX_DELETION_BATCH < 10);
  check("five is allowed", (() => { assertDeletionBatchSize(5); return true; })());
  refuses("six is refused", () => assertDeletionBatchSize(6), "batch_too_large");
  refuses("zero is refused", () => assertDeletionBatchSize(0), "empty_batch");

  console.log("\n=== THERE IS NO DELETION PATH IN THIS PR ===");
  //
  // The whole point of the step. These assertions read the shipped source.
  check("the planner contains no .remove(", !strip(src).includes(".remove("));
  check("the planner contains no .delete(", !strip(src).includes(".delete("));
  check("the planner issues no HTTP DELETE", !/method:\s*["'`]DELETE["'`]/i.test(strip(src)));
  check("the planner constructs no supabase-js client", !strip(src).includes("createClient"));
  check("the rules module contains no .remove(", !strip(rules).includes(".remove("));
  check("the rules module contains no .delete(", !strip(rules).includes(".delete("));
  check("no --execute flag of any kind", !/--execute/.test(strip(src)));
  check("no destructive override flag",
    !/--force|--skip-verif|--ignore-checksum|--allow-|--yes-i-understand-delete/.test(strip(src)));
  check("the only HTTP methods are read methods",
    (strip(src).match(/method:\s*["'`](\w+)["'`]/gi) ?? []).every((m) => /POST|HEAD|GET/i.test(m)));
  // The planner used to write `executable: false` into every manifest, and this
  // suite used to assert it. The claim was about the PR, not the batch, and it
  // outlived the PR: the executor shipped and never read the field, so a
  // manifest saying "not executable" sat in front of a tool that would execute
  // it. The field is gone; what replaces it is a refusal in the executor.
  check("the planner writes no executable field",
    !/executable\s*:/.test(strip(src)));
  check("nor any other self-declared permission flag",
    !/\b(authorized|authorised|approved|permitted|allowDelete|canDelete)\s*:/i.test(strip(src)));
  check("and claims nothing about the repository's deletion path",
    !/no C3 deletion path in this PR|NOT EXECUTABLE/.test(src));
  check("while still saying it deleted nothing itself",
    /deleted nothing/i.test(src));
  check("the only write is the manifest, through the exclusive writer",
    (strip(src).match(/writeFileSync\(/g) ?? []).length === 1 && strip(src).includes("writeManifestExclusive("));
  check("the planner writes only under reports/", strip(src).includes('LEDGER_DIR = "reports/image-backfill"'));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
