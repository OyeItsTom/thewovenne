/**
 * C7's refusals, and the things it must never be able to do.
 *
 * C7 is the first tool in this series that removes bytes C6 promised to keep,
 * so the assertions worth reading twice are the negative ones: no database
 * write anywhere in C7, no prefix or wildcard delete, no acknowledgement
 * borrowed from a tool with different evidence rules, and no path to deleting
 * a master.
 *
 * The rules are executed — every eligibility decision is a pure function and is
 * called here with real inputs. The tool contracts are source checks, because
 * the planner and executor cannot be driven from here without a bucket, and
 * what needs guarding is the line an edit would move.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MigrationRefused } from "../lib/imageBackfill";
import {
  C7_EXPECTED_NORMALIZER_VERSION,
  C7_FLAGS,
  C7_MANIFEST_KIND,
  C7_STATES,
  MAX_C7_DELETE_BATCH,
  assertC7BatchSize,
  assertC7Flags,
  assertCoherentC7Manifest,
  c7ManifestChecksum,
  classifyForC7,
  isC7Eligible,
  isRevertedWithoutReapply,
  readC6MigrationEvidence,
  type C6MigrationEvidence,
  type C7Candidate,
  type C7Manifest,
  type C7ManifestEntry,
} from "../lib/imageC7";
import { MAX_DELETION_BATCH } from "../lib/imageDeletion";

let passed = 0;
let failed = 0;
const sha = (i: string) => createHash("sha256").update(i).digest("hex");

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}
function refuses(name: string, fn: () => unknown, reason?: string) {
  try { fn(); check(name, false, "did not throw"); }
  catch (e) { check(name, e instanceof MigrationRefused && (!reason || e.reason === reason),
    e instanceof MigrationRefused ? `reason=${e.reason}` : String(e)); }
}

const SRC = "products/be3b9a6c-60cf-4a63-84bc-0f3c93baee3c.jpg";
const MASTER = "products/6cf18d078a325a141356401e9527f6aa-v1.jpg";
const DIGEST = sha("the migrated bytes");

const EVIDENCE: C6MigrationEvidence = {
  sourcePath: SRC, sourceBytes: 16_359_290, sourceChecksum: DIGEST,
  sourceDimensions: "6120x8160", masterPath: MASTER, masterBytes: 3_110_618,
  masterDimensions: "2400x3200", normalizerVersion: C7_EXPECTED_NORMALIZER_VERSION,
  batchId: "c6-6", ledgerFile: "c6-migrated-c6-6.ndjson",
};

const OK: C7Candidate = {
  sourcePath: SRC, sourceUrl: `https://x/${SRC}`, sourceBytes: 16_359_290,
  sourceChecksum: DIGEST, sourceExists: true,
  evidence: EVIDENCE, batchApproved: true,
  masterExists: true, masterReadable: true, masterBytes: 3_110_618,
  masterDimensions: "2400x3200",
  masterLiveReferences: [{ table: "product_images", rowId: "img-1", field: "url" }],
  graphIsComplete: true,
  liveReferencesOnSource: [], cartReferencesOnSource: [], siteContentReferencesOnSource: [],
  unknownReferencesOnSource: 0, historicalReferencesOnSource: 3,
  expectedNormalizerVersion: C7_EXPECTED_NORMALIZER_VERSION,
};
const spoil = (p: Partial<C7Candidate>): C7Candidate => ({ ...OK, ...p });
const state = (p: Partial<C7Candidate> = {}) => classifyForC7(spoil(p)).state;

const ENTRY: C7ManifestEntry = {
  sourcePath: SRC, sourceBytes: 16_359_290, sourceChecksum: DIGEST,
  masterPath: MASTER, masterBytes: 3_110_618, masterDimensions: "2400x3200",
  normalizerVersion: C7_EXPECTED_NORMALIZER_VERSION,
  migratedInBatch: "c6-6", evidenceLedger: "c6-migrated-c6-6.ndjson",
  expectedMasterReferences: [{ table: "product_images", rowId: "img-1", field: "url" }],
};
const manifestOf = (entries: C7ManifestEntry[], batchId = "c7-1"): C7Manifest => ({
  kind: C7_MANIFEST_KIND, batchId, createdAt: new Date().toISOString(),
  normalizerVersion: C7_EXPECTED_NORMALIZER_VERSION, entries,
  checksum: c7ManifestChecksum({ batchId, normalizerVersion: C7_EXPECTED_NORMALIZER_VERSION, entries }, sha),
});

function main() {
  console.log("\n=== a clean candidate is eligible ===");
  check("the proven case is eligible", state() === "C7_RECLAIM_ELIGIBLE", state());
  check("isC7Eligible is exact", isC7Eligible("C7_RECLAIM_ELIGIBLE")
    && C7_STATES.filter((s) => s !== "C7_RECLAIM_ELIGIBLE").every((s) => !isC7Eligible(s)));

  console.log("\n=== evidence must exist and be about this object ===");
  check("no evidence blocks", state({ evidence: null }) === "C7_BLOCKED_NO_MIGRATION_EVIDENCE");
  check("evidence about another object blocks",
    state({ evidence: { ...EVIDENCE, sourcePath: "products/other.jpg" } }) === "C7_BLOCKED_NO_MIGRATION_EVIDENCE");
  check("evidence naming a non-master as the master blocks",
    state({ evidence: { ...EVIDENCE, masterPath: "products/plain.jpg" } }) === "C7_BLOCKED_NO_MIGRATION_EVIDENCE");
  check("evidence pairing the source with itself blocks",
    state({ evidence: { ...EVIDENCE, masterPath: SRC } }) === "C7_BLOCKED_OUT_OF_SCOPE");

  console.log("\n=== a person must have approved the batch ===");
  check("an unapproved batch blocks", state({ batchApproved: false }) === "C7_BLOCKED_BATCH_NOT_APPROVED");

  console.log("\n=== the original must still be the migrated bytes ===");
  check("an already-absent original blocks", state({ sourceExists: false }) === "C7_BLOCKED_SOURCE_ABSENT");
  check("an unreadable digest blocks", state({ sourceChecksum: null }) === "C7_BLOCKED_SOURCE_CHANGED");
  check("different bytes block", state({ sourceBytes: 16_359_291 }) === "C7_BLOCKED_SOURCE_CHANGED");
  check("a different digest blocks", state({ sourceChecksum: sha("other") }) === "C7_BLOCKED_SOURCE_CHANGED");

  console.log("\n=== anything still pointing at the original blocks ===");
  check("a live product reference blocks",
    state({ liveReferencesOnSource: [{ table: "product_images", rowId: "r", field: "url" }] })
      === "C7_BLOCKED_LIVE_REFERENCE");
  check("a cart reference blocks",
    state({ cartReferencesOnSource: [{ table: "carts", rowId: "c", field: "items" }] })
      === "C7_BLOCKED_CART");
  check("a site_content reference blocks",
    state({ siteContentReferencesOnSource: [{ table: "site_content", rowId: "s", field: "body" }] })
      === "C7_BLOCKED_SITE_CONTENT");
  check("an unclassified reference blocks",
    state({ unknownReferencesOnSource: 1 }) === "C7_BLOCKED_UNKNOWN_REFERENCE");
  check("historical references alone do NOT block",
    state({ historicalReferencesOnSource: 99 }) === "C7_RECLAIM_ELIGIBLE");
  check("an incomplete graph blocks", state({ graphIsComplete: false }) === "C7_BLOCKED_GRAPH_INCOMPLETE");
  check("a cart blocks even when it is the only reference",
    state({ liveReferencesOnSource: [], cartReferencesOnSource: [{ table: "carts", rowId: "c", field: "items" }] })
      === "C7_BLOCKED_CART");

  console.log("\n=== the master must be there, unchanged, and in use ===");
  check("a missing master blocks", state({ masterExists: false }) === "C7_BLOCKED_MASTER_MISSING");
  check("an unreadable master blocks", state({ masterReadable: false }) === "C7_BLOCKED_MASTER_UNREADABLE");
  check("a resized master blocks", state({ masterBytes: 999 }) === "C7_BLOCKED_MASTER_CHANGED");
  check("different master dimensions block",
    state({ masterDimensions: "1200x1600" }) === "C7_BLOCKED_MASTER_CHANGED");
  check("a foreign normalizer version blocks",
    state({ evidence: { ...EVIDENCE, normalizerVersion: 99 } }) === "C7_BLOCKED_VERSION_MISMATCH");
  check("an unreferenced master blocks",
    state({ masterLiveReferences: [] }) === "C7_BLOCKED_MASTER_UNREFERENCED");

  console.log("\n=== scope: what C7 may never consider ===");
  check("a master as the source blocks",
    state({ sourcePath: "products/abc123-v1.jpg" }) === "C7_BLOCKED_OUT_OF_SCOPE");
  check("HEIC blocks", state({ sourcePath: "products/x.heic" }) === "C7_BLOCKED_OUT_OF_SCOPE");
  check("HEIF blocks", state({ sourcePath: "products/x.HEIF" }) === "C7_BLOCKED_OUT_OF_SCOPE");
  check("a path outside products/ blocks",
    state({ sourcePath: "lookbook/x.jpg" }) === "C7_BLOCKED_OUT_OF_SCOPE");
  check("a folder blocks", state({ sourcePath: "products/" }) === "C7_BLOCKED_OUT_OF_SCOPE");
  check("a wildcard blocks", state({ sourcePath: "products/*" }) === "C7_BLOCKED_OUT_OF_SCOPE");
  check("traversal blocks", state({ sourcePath: "products/../x.jpg" }) === "C7_BLOCKED_OUT_OF_SCOPE");
  check("an empty path blocks", state({ sourcePath: "" }) === "C7_BLOCKED_OUT_OF_SCOPE");

  console.log("\n=== a reverted original is not reclaimable ===");
  const reverts = [
    { action: "C6_REVERT", sourcePath: SRC, timestamp: "2026-08-23T20:59:57.173Z" },
    { action: "C6_REAPPLY", sourcePath: SRC, timestamp: "2026-08-23T21:09:52.174Z" },
  ];
  check("revert then re-apply is NOT treated as reverted", !isRevertedWithoutReapply(reverts, SRC));
  check("a revert with no re-apply IS treated as reverted",
    isRevertedWithoutReapply([reverts[0]], SRC));
  check("ordering is by timestamp, not file order",
    isRevertedWithoutReapply([reverts[1], { ...reverts[0], timestamp: "2026-08-23T22:00:00.000Z" }], SRC));
  check("another object's reverts are ignored", !isRevertedWithoutReapply(reverts, "products/other.jpg"));
  check("no revert history means not reverted", !isRevertedWithoutReapply([], SRC));

  console.log("\n=== C6 evidence is read strictly ===");
  const good = {
    status: "MIGRATED", sourcePath: SRC, masterPath: MASTER, batchId: "c6-6",
    sourceBytes: 16_359_290, sourceChecksum: DIGEST, masterBytes: 3_110_618,
    masterDimensions: "2400x3200", sourceDimensions: "6120x8160",
    normalizerVersion: C7_EXPECTED_NORMALIZER_VERSION, originalRetained: true,
  };
  check("a complete MIGRATED record is evidence",
    readC6MigrationEvidence([good], SRC, "l.ndjson")?.masterPath === MASTER);
  check("no record is not evidence", readC6MigrationEvidence([], SRC, "l.ndjson") === null);
  check("a FAILED record anywhere disqualifies",
    readC6MigrationEvidence([good, { status: "FAILED", sourcePath: SRC }], SRC, "l.ndjson") === null);
  check("a ROLLED_BACK record anywhere disqualifies",
    readC6MigrationEvidence([good, { status: "ROLLED_BACK", sourcePath: SRC }], SRC, "l.ndjson") === null);
  check("a REFUSED record anywhere disqualifies",
    readC6MigrationEvidence([good, { status: "REFUSED", sourcePath: SRC }], SRC, "l.ndjson") === null);
  check("two MIGRATED records are ambiguous, not doubly proven",
    readC6MigrationEvidence([good, good], SRC, "l.ndjson") === null);
  check("originalRetained must be true",
    readC6MigrationEvidence([{ ...good, originalRetained: false }], SRC, "l.ndjson") === null);
  check("a bad checksum is not evidence",
    readC6MigrationEvidence([{ ...good, sourceChecksum: "nope" }], SRC, "l.ndjson") === null);
  check("a master path that is not a master is not evidence",
    readC6MigrationEvidence([{ ...good, masterPath: "products/plain.jpg" }], SRC, "l.ndjson") === null);
  check("self-pairing is not evidence",
    readC6MigrationEvidence([{ ...good, masterPath: SRC }], SRC, "l.ndjson") === null);
  check("malformed lines never throw",
    readC6MigrationEvidence([null as never, 7 as never, "x" as never, good], SRC, "l.ndjson") !== null);
  check("MASTER_REUSED also counts",
    readC6MigrationEvidence([{ ...good, status: "MASTER_REUSED" }], SRC, "l.ndjson") !== null);

  console.log("\n=== batch ceiling ===");
  check("C7 caps at 5", MAX_C7_DELETE_BATCH === 5);
  check("and matches C3's proven ceiling", MAX_C7_DELETE_BATCH === MAX_DELETION_BATCH);
  refuses("six is refused", () => assertC7BatchSize(6), "batch_too_large");
  refuses("zero is refused", () => assertC7BatchSize(0), "empty_batch");
  refuses("a fraction is refused", () => assertC7BatchSize(1.5), "empty_batch");

  console.log("\n=== the manifest must be coherent ===");
  check("a clean manifest passes", (() => {
    try { assertCoherentC7Manifest(manifestOf([ENTRY])); return true; } catch { return false; }
  })());
  refuses("a duplicate source is refused",
    () => assertCoherentC7Manifest(manifestOf([ENTRY, { ...ENTRY }])), "incoherent_manifest");
  refuses("an entry with no master reference is refused",
    () => assertCoherentC7Manifest(manifestOf([{ ...ENTRY, expectedMasterReferences: [] }])),
    "incoherent_manifest");
  refuses("a non-master master path is refused",
    () => assertCoherentC7Manifest(manifestOf([{ ...ENTRY, masterPath: "products/plain.jpg" }])),
    "incoherent_manifest");
  refuses("a master queued as an original is refused", () => assertCoherentC7Manifest(manifestOf([
    ENTRY,
    { ...ENTRY, sourcePath: MASTER, masterPath: "products/deadbeefdeadbeefdeadbeefdeadbeef-v1.jpg" },
  ])), "unsafe_delete_path");
  refuses("a mismatched normalizer version is refused",
    () => assertCoherentC7Manifest(manifestOf([{ ...ENTRY, normalizerVersion: 2 }])), "incoherent_manifest");
  refuses("the wrong kind is refused",
    () => assertCoherentC7Manifest({ ...manifestOf([ENTRY]), kind: "c3-delete" as never }),
    "incoherent_manifest");

  console.log("\n=== the checksum covers what a reviewer approved ===");
  const base = c7ManifestChecksum({ batchId: "c7-1", normalizerVersion: 1, entries: [ENTRY] }, sha);
  const differs = (e: Partial<C7ManifestEntry>) =>
    c7ManifestChecksum({ batchId: "c7-1", normalizerVersion: 1, entries: [{ ...ENTRY, ...e }] }, sha) !== base;
  check("changing the source path changes it", differs({ sourcePath: "products/z.jpg" }));
  check("changing the bytes changes it", differs({ sourceBytes: 1 }));
  check("changing the digest changes it", differs({ sourceChecksum: sha("x") }));
  check("changing the master changes it", differs({ masterPath: "products/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v1.jpg" }));
  check("changing the expected references changes it",
    differs({ expectedMasterReferences: [{ table: "products", rowId: "p", field: "image_url" }] }));
  check("changing the batch id changes it",
    c7ManifestChecksum({ batchId: "c7-2", normalizerVersion: 1, entries: [ENTRY] }, sha) !== base);
  check("reference order does not change it",
    c7ManifestChecksum({ batchId: "c7-1", normalizerVersion: 1, entries: [{ ...ENTRY,
      expectedMasterReferences: [
        { table: "b", rowId: "2", field: "url" }, { table: "a", rowId: "1", field: "url" }] }] }, sha)
    === c7ManifestChecksum({ batchId: "c7-1", normalizerVersion: 1, entries: [{ ...ENTRY,
      expectedMasterReferences: [
        { table: "a", rowId: "1", field: "url" }, { table: "b", rowId: "2", field: "url" }] }] }, sha));

  console.log("\n=== the command line cannot be borrowed from another tool ===");
  const full = [C7_FLAGS.execute, C7_FLAGS.batchId, "c7-1",
    C7_FLAGS.manifest, "m.json", C7_FLAGS.acknowledgement];
  check("the full command line is accepted", assertC7Flags(full).batchId === "c7-1");
  refuses("without --execute", () => assertC7Flags(full.filter((f) => f !== C7_FLAGS.execute)), "not_execute");
  refuses("without the acknowledgement",
    () => assertC7Flags(full.filter((f) => f !== C7_FLAGS.acknowledgement)), "missing_acknowledgement");
  for (const foreign of [
    "--yes-i-understand-originals-are-retained",
    "--yes-i-understand-original-deletion-is-permanent",
    "--yes-i-understand-the-duplicate-is-the-only-other-copy",
  ]) {
    refuses(`${foreign} is refused even alongside the right one`,
      () => assertC7Flags([...full, foreign]), "wrong_acknowledgement");
  }
  check("C7's acknowledgement is not any other tool's",
    ![
      "--yes-i-understand-originals-are-retained",
      "--yes-i-understand-original-deletion-is-permanent",
      "--yes-i-understand-the-duplicate-is-the-only-other-copy",
    ].includes(C7_FLAGS.acknowledgement));

  console.log("\n=== C7's tools: what the source may not contain ===");
  const planner = readFileSync("scripts/c7-reclaim-plan.ts", "utf8");
  const executor = readFileSync("scripts/c7-reclaim-execute.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bareP = strip(planner);
  const bareE = strip(executor);

  check("the PLANNER cannot delete", !/method:\s*"DELETE"/.test(bareP) && !bareP.includes(".remove("));
  check("the PLANNER cannot write to the database",
    !/method:\s*"PATCH"/.test(bareP) && !/method:\s*"PUT"/.test(bareP));
  check("the PLANNER's only POST is the storage listing",
    (bareP.match(/method:\s*"POST"/g) ?? []).length === 1 && bareP.includes("/storage/v1/object/list/"));
  check("the PLANNER cannot upload", !bareP.includes("/storage/v1/object/product-images"));

  check("the EXECUTOR sends no PATCH", !/method:\s*"PATCH"/.test(bareE));
  check("the EXECUTOR sends no PUT", !/method:\s*"PUT"/.test(bareE));
  check("the EXECUTOR's only POST is the storage listing",
    (bareE.match(/method:\s*"POST"/g) ?? []).length === 1 && bareE.includes("/storage/v1/object/list/"));
  check("the EXECUTOR deletes exactly one path expression",
    (bareE.match(/method:\s*"DELETE"/g) ?? []).length === 1);
  check("and that delete names the entry's own source path",
    /object\/\$\{BUCKET\}\/\$\{entry\.sourcePath\}`,\s*\n?\s*\{\s*method:\s*"DELETE"/.test(bareE)
    || bareE.includes("${BUCKET}/${entry.sourcePath}"));
  // Matched at the CALL SITE, not on the identifier: the import line names
  // assertSafeToDeletePath too, and an import always precedes the delete — so
  // an assertion that only found the import would survive deleting the call.
  const guardCall = bareE.indexOf("assertSafeToDeletePath(entry.");
  check("the path guard is actually CALLED on the entry being deleted", guardCall > 0);
  check("and it runs before the delete", guardCall > 0 && guardCall < bareE.indexOf('method: "DELETE"'));
  // Likewise anchored to the ledger write, not to the status string: every
  // status also appears in the C7Status union near the top of the file.
  const evidenceWrite = bareE.indexOf('record("PREDELETE_VERIFIED")');
  check("PREDELETE_VERIFIED evidence is actually written", evidenceWrite > 0);
  check("and it is written before the delete",
    evidenceWrite > 0 && evidenceWrite < bareE.indexOf('method: "DELETE"'));
  const confirmWrite = bareE.indexOf('record("DELETE_CONFIRMED"');
  check("DELETE_CONFIRMED is written only after the delete",
    confirmWrite > 0 && confirmWrite > bareE.indexOf('method: "DELETE"'));
  // lastIndexOf, because the status strings also appear in the C7Status union
  // near the top of the file; what matters is where they are WRITTEN.

  check("no wildcard or prefix reaches a delete",
    !bareE.includes('.remove([') && !/DELETE[\s\S]{0,200}\*/.test(bareE));
  // Scoped to the DELETION loop's catch, not every catch in the file: reading
  // the schema legitimately skips an unreadable table and carries on, and a
  // blanket "no continue anywhere" would fail on that while proving nothing.
  const stopBlock = bareE.slice(bareE.indexOf("STOPPED at"));
  check("the first failure exits rather than continuing",
    stopBlock.includes("process.exit(1)") && !/\bcontinue\b/.test(stopBlock));
  check("the deletion loop has no retry",
    !/for\s*\(let\s+attempt/.test(bareE) && !bareE.includes("retries"));
  check("a ledger write failure is not swallowed",
    !/try\s*{[^}]*appendFileSync/.test(bareE) && bareE.includes("appendFileSync"));
  check("the ledger is append-only", bareE.includes('flag: "a"'));
  check("and lives under reports/", bareE.includes('LEDGER_DIR = "reports/c7-reclaim"'));
  check("approval is read from a file, not assumed",
    bareE.includes("APPROVALS") && bareE.includes("approved.has("));

  console.log("\n=== it is thin: decisions are imported, not rewritten ===");
  for (const helper of ["classifyForC7", "readC6MigrationEvidence", "assertSafeToDeletePath",
                        "assertCoherentC7Manifest", "c7ManifestChecksum", "isRevertedWithoutReapply"]) {
    check(`${helper} is imported, not redefined`,
      bareE.includes(helper) && !new RegExp(`function\\s+${helper}\\s*\\(`).test(bareE));
  }
  check("the path guard is C3's, not a copy",
    executor.includes('from "../lib/imageDeletion"'));

  console.log("\n=== C6 cannot delete, and older scopes are unchanged ===");
  const c6 = readFileSync("scripts/c6-normalize-execute.ts", "utf8");
  check("C6's executor still sends no DELETE", !/method:\s*"DELETE"/.test(c6) && !c6.includes(".remove("));
  check("C6 still promises retention", c6.includes("originalRetained: true"));
  check("C6 does not import C7", !c6.includes("imageC7") && !c6.includes("c7-reclaim"));
  check("C2's ceiling is unchanged",
    /MAX_EXECUTION_BATCH = 10/.test(readFileSync("lib/imageBackfill.ts", "utf8")));
  check("C3 still caps at 5", /MAX_DELETION_BATCH = 5/.test(readFileSync("lib/imageDeletion.ts", "utf8")));
  check("C5 still refuses a master as a twin",
    readFileSync("lib/imageOrphans.ts", "utf8").includes("C5_BLOCKED_TWIN_IS_MASTER"));
  check("no second C7 executor appeared",
    !existsSync("scripts/c7-execute.ts") && !existsSync("scripts/c7-delete.ts"));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
