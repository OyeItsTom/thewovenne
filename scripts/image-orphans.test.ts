/**
 * C5's refusals.
 *
 * Every test here is a check that a photograph does NOT get deleted. C5's
 * safety claim is weaker in kind than C3's — a twin is another upload, not a
 * curated replacement — so most of these assert that the pair, not just the
 * candidate, has to hold up.
 *
 * The suite that matters most is "unique content cannot enter a manifest".
 * The C4 audit found nine unreferenced objects that are the only surviving
 * copy of their content; deleting one would lose a photograph permanently and
 * no reference check would have warned us. Those objects are excluded not by a
 * rule someone could relax, but by a shape they cannot satisfy: eligibility
 * requires a live-referenced twin with the same digest, and they have none.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  C5_ALLOWED_PREFIX,
  C5_MANIFEST_KIND,
  C5_STATES,
  MAX_C5_DELETION_BATCH,
  assertC5BatchSize,
  assertC5InScope,
  assertCoherentOrphanManifest,
  classifyOrphan,
  isC5Eligible,
  orphanManifestChecksum,
  type OrphanCandidate,
  type OrphanManifest,
  type OrphanManifestEntry,
} from "../lib/imageOrphans";
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
  catch (e) { check(name, e instanceof MigrationRefused && (!reason || e.reason === reason)); }
}

/* Real values from the C4 audit, so these are regressions and not fiction. */
const CANDIDATE = "products/590b3a39-59b3-4404-9c5f-a884a493d54c.jpg";
const TWIN = "products/27f86f7e-2e17-4b79-a7ec-2fb06f1482ed.jpg";
const DIGEST = "c1d007ac7c04ff54" + "a".repeat(48);
const BYTES = 19_197_866;

const OK: OrphanCandidate = {
  path: CANDIDATE,
  exists: true,
  bytes: BYTES,
  checksum: DIGEST,
  liveReferences: [],
  historicalReferences: 0,
  twin: {
    path: TWIN,
    exists: true,
    bytes: BYTES,
    checksum: DIGEST,
    liveReferences: [{ table: "product_images", rowId: "r1", field: "url" }],
  },
  graphIsComplete: true,
  auditedHighConfidence: true,
};
const spoil = (p: Partial<OrphanCandidate>): OrphanCandidate => ({ ...OK, ...p });
const state = (p: Partial<OrphanCandidate>) => classifyOrphan(spoil(p)).state;
const withTwin = (t: Partial<NonNullable<OrphanCandidate["twin"]>>) =>
  spoil({ twin: { ...OK.twin!, ...t } });

const ENTRY: OrphanManifestEntry = {
  candidatePath: CANDIDATE,
  candidateBytes: BYTES,
  candidateChecksum: DIGEST,
  twinPath: TWIN,
  twinBytes: BYTES,
  twinChecksum: DIGEST,
  expectedTwinLiveReferences: 1,
  expectedCandidateLiveReferences: 0,
  expectedCandidateHistoricalReferences: 0,
};
const manifest = (entries: OrphanManifestEntry[]): OrphanManifest => ({
  kind: C5_MANIFEST_KIND, batchId: "c5-orphan-1", createdAt: "x", entries,
  checksum: orphanManifestChecksum({ batchId: "c5-orphan-1", entries }, sha),
});

function main() {
  const rules = readFileSync("lib/imageOrphans.ts", "utf8");
  const plan = readFileSync("scripts/orphan-delete-plan.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  console.log("\n=== the happy path, so the refusals mean something ===");
  check("a proven pair is eligible", state({}) === "C5_DELETE_ELIGIBLE");
  check("and only that state is eligible",
    C5_STATES.filter((s) => isC5Eligible(s)).length === 1);
  check("the reason names the survivor", classifyOrphan(OK).reason.includes(TWIN));

  console.log("\n=== ZERO REFERENCES IS NEVER ENOUGH ===");
  //
  // The heart of C5. An unreferenced object with no twin is exactly the shape
  // of the nine unique-content images C4 found, and it must never be eligible.
  check("no twin at all is refused", state({ twin: null }) === "C5_BLOCKED_NO_TWIN");
  check("unique content cannot be eligible however clean it looks",
    state({ twin: null, liveReferences: [], historicalReferences: 0 }) !== "C5_DELETE_ELIGIBLE");
  check("a twin that does not exist is refused",
    state({ twin: { ...OK.twin!, exists: false } }) === "C5_BLOCKED_TWIN_ABSENT");
  check("a twin nothing points at is refused",
    state({ twin: { ...OK.twin!, liveReferences: [] } }) === "C5_BLOCKED_TWIN_UNREFERENCED");
  check("the eligibility rule requires a twin structurally",
    strip(rules).includes("C5_BLOCKED_NO_TWIN") && strip(rules).includes("twin.liveReferences.length < 1"));

  console.log("\n=== the pair must be the same photograph ===");
  check("a different digest is refused",
    state({ twin: { ...OK.twin!, checksum: sha("other") } }) === "C5_BLOCKED_CHECKSUM_MISMATCH");
  check("an uncomputable candidate digest is refused",
    state({ checksum: null }) === "C5_BLOCKED_CHECKSUM_MISMATCH");
  check("an uncomputable twin digest is refused",
    state({ twin: { ...OK.twin!, checksum: null } }) === "C5_BLOCKED_CHECKSUM_MISMATCH");
  check("a different byte length is refused",
    state({ twin: { ...OK.twin!, bytes: BYTES - 1 } }) === "C5_BLOCKED_BYTES_MISMATCH");
  check("a null twin byte length is refused",
    state({ twin: { ...OK.twin!, bytes: null } }) === "C5_BLOCKED_BYTES_MISMATCH");

  console.log("\n=== the candidate must still be an orphan ===");
  check("a live reference blocks",
    state({ liveReferences: [{ table: "product_images", rowId: "i", field: "url" }] }) === "C5_BLOCKED_LIVE_REFERENCE");
  check("a cart reference blocks",
    state({ liveReferences: [{ table: "carts", rowId: "c", field: "items" }] }) === "C5_BLOCKED_LIVE_REFERENCE");
  check("a site_content reference blocks",
    state({ liveReferences: [{ table: "site_content", rowId: "s", field: "value" }] }) === "C5_BLOCKED_LIVE_REFERENCE");
  check("an audit-log mention blocks, unlike in C3",
    state({ historicalReferences: 1 }) === "C5_BLOCKED_AUDIT_REFERENCE");
  check("an absent candidate blocks", state({ exists: false }) === "C5_BLOCKED_CANDIDATE_ABSENT");

  console.log("\n=== structure outranks everything ===");
  check("an incomplete graph blocks first",
    state({ graphIsComplete: false }) === "C5_BLOCKED_GRAPH_INCOMPLETE");
  check("even when every other fact is perfect",
    state({ graphIsComplete: false, twin: OK.twin }) === "C5_BLOCKED_GRAPH_INCOMPLETE");
  check("an object the audit did not approve is manual review",
    state({ auditedHighConfidence: false }) === "C5_MANUAL_REVIEW");
  check("audit approval alone does not make it eligible",
    state({ auditedHighConfidence: true, twin: null }) !== "C5_DELETE_ELIGIBLE");

  console.log("\n=== scope is a hard gate, independent of classification ===");
  check(`the allowed prefix is ${C5_ALLOWED_PREFIX}`, C5_ALLOWED_PREFIX === "products/");
  refuses("lookbook is refused", () => assertC5InScope("lookbook/a.jpg", TWIN), "c5_out_of_scope");
  refuses("campaigns is refused", () => assertC5InScope("campaigns/a.png", TWIN), "c5_out_of_scope");
  refuses("HEIC is refused", () => assertC5InScope("products/a.heic", TWIN), "c5_out_of_scope");
  refuses("HEIF is refused", () => assertC5InScope("products/a.HEIF", TWIN), "c5_out_of_scope");
  refuses("a normalised master is refused",
    () => assertC5InScope("products/abcdef0123456789abcdef0123456789-v1.jpg", TWIN), "c5_out_of_scope");
  refuses("a folder is refused", () => assertC5InScope("products/", TWIN), "c5_out_of_scope");
  refuses("a wildcard is refused", () => assertC5InScope("products/*", TWIN), "c5_out_of_scope");
  refuses("traversal is refused", () => assertC5InScope("products/../x.jpg", TWIN), "c5_out_of_scope");
  refuses("candidate == twin is refused", () => assertC5InScope(CANDIDATE, CANDIDATE), "c5_out_of_scope");
  refuses("a twin outside the prefix is refused",
    () => assertC5InScope(CANDIDATE, "lookbook/b.jpg"), "c5_out_of_scope");
  refuses("an empty path is refused", () => assertC5InScope("", TWIN), "c5_out_of_scope");
  refuses("a non-string path is refused", () => assertC5InScope(null, TWIN), "c5_out_of_scope");
  check("classification refuses out-of-scope too, not just the guard",
    state({ path: "lookbook/x.jpg" }) === "C5_BLOCKED_OUT_OF_SCOPE");

  console.log("\n=== the batch ceiling ===");
  check(`MAX_C5_DELETION_BATCH is ${MAX_C5_DELETION_BATCH}`, MAX_C5_DELETION_BATCH === 5);
  check("five is allowed", (() => { assertC5BatchSize(5); return true; })());
  check("four is allowed, so a short final batch works",
    (() => { assertC5BatchSize(4); return true; })());
  refuses("six is refused", () => assertC5BatchSize(6), "batch_too_large");
  refuses("zero is refused", () => assertC5BatchSize(0), "empty_batch");
  refuses("a fraction is refused", () => assertC5BatchSize(1.5), "empty_batch");

  console.log("\n=== manifest checksum covers BOTH halves of the pair ===");
  const subject = { batchId: "c5-orphan-1", entries: [ENTRY] };
  const sum = orphanManifestChecksum(subject, sha);
  check("stable", orphanManifestChecksum(subject, sha) === sum);
  check("batch id is covered",
    orphanManifestChecksum({ ...subject, batchId: "c5-orphan-2" }, sha) !== sum);
  check("candidate path is covered",
    orphanManifestChecksum({ ...subject, entries: [{ ...ENTRY, candidatePath: "products/z.jpg" }] }, sha) !== sum);
  check("candidate digest is covered",
    orphanManifestChecksum({ ...subject, entries: [{ ...ENTRY, candidateChecksum: sha("x") }] }, sha) !== sum);
  check("TWIN PATH is covered — a survivor cannot be swapped after review",
    orphanManifestChecksum({ ...subject, entries: [{ ...ENTRY, twinPath: "products/other.jpg" }] }, sha) !== sum);
  check("twin digest is covered",
    orphanManifestChecksum({ ...subject, entries: [{ ...ENTRY, twinChecksum: sha("y") }] }, sha) !== sum);
  check("twin bytes are covered",
    orphanManifestChecksum({ ...subject, entries: [{ ...ENTRY, twinBytes: 1 }] }, sha) !== sum);
  check("the twin's reference state is covered",
    orphanManifestChecksum({ ...subject, entries: [{ ...ENTRY, expectedTwinLiveReferences: 9 }] }, sha) !== sum);
  check("ordering is canonicalised",
    orphanManifestChecksum({ batchId: "b", entries: [ENTRY, { ...ENTRY, candidatePath: "products/a.jpg" }] }, sha)
    === orphanManifestChecksum({ batchId: "b", entries: [{ ...ENTRY, candidatePath: "products/a.jpg" }, ENTRY] }, sha));
  check("no executable field exists on the C5 manifest",
    !/executable\s*:/.test(strip(rules)));

  console.log("\n=== manifest coherence, checked before anything is written ===");
  check("a coherent manifest passes",
    (() => { assertCoherentOrphanManifest(manifest([ENTRY])); return true; })());
  refuses("mismatched checksums in one entry are refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, twinChecksum: sha("q") }])), "checksum_mismatch");
  refuses("mismatched bytes in one entry are refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, twinBytes: 2 }])), "bytes_mismatch");
  refuses("a twin recorded with no references is refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, expectedTwinLiveReferences: 0 }])), "twin_unreferenced");
  refuses("a candidate recorded with live references is refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, expectedCandidateLiveReferences: 1 as never }])), "candidate_referenced");
  refuses("a candidate recorded with audit history is refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, expectedCandidateHistoricalReferences: 1 as never }])), "candidate_referenced");
  refuses("duplicate candidates are refused",
    () => assertCoherentOrphanManifest(manifest([ENTRY, ENTRY])), "duplicate_entries");
  refuses("six entries are refused", () => assertCoherentOrphanManifest(
    manifest([1, 2, 3, 4, 5, 6].map((n) => ({ ...ENTRY, candidatePath: `products/${n}.jpg` })))), "batch_too_large");
  refuses("the wrong kind is refused",
    () => assertCoherentOrphanManifest({ ...manifest([ENTRY]), kind: "c3-delete" as never }), "wrong_kind");
  //
  // BOTH HALVES OF A PAIR IN ONE BATCH. C4 found two candidates that duplicate
  // each other as well as a live object. If a plan cited each as the other's
  // survivor, one batch would delete both copies. The survivor of any entry
  // must therefore never appear as a candidate anywhere in the same manifest.
  refuses("a survivor queued for deletion in the same batch is refused",
    () => assertCoherentOrphanManifest(manifest([
      ENTRY,
      { ...ENTRY, candidatePath: TWIN, twinPath: "products/third.jpg" },
    ])), "twin_also_candidate");

  console.log("\n=== THERE IS NO C5 DELETION PATH YET ===");
  check("the rules module contains no .remove(", !strip(rules).includes(".remove("));
  check("the rules module contains no .delete(", !strip(rules).includes(".delete("));
  check("the planner contains no .remove(", !strip(plan).includes(".remove("));
  check("the planner contains no .delete(", !strip(plan).includes(".delete("));
  check("the planner issues no HTTP DELETE", !/method:\s*["'`]DELETE["'`]/i.test(strip(plan)));
  check("the planner issues no write method at all",
    (strip(plan).match(/method:\s*["'`](\w+)["'`]/gi) ?? []).every((m) => /POST|HEAD|GET/i.test(m)));
  check("the planner constructs no supabase-js client", !strip(plan).includes("createClient"));
  check("no --execute flag", !/--execute/.test(strip(plan)));
  check("no bypass or override flag anywhere",
    !/--force|--skip-verif|--ignore-checksum|--allow-|--yes-i-understand/.test(strip(plan) + strip(rules)));
  check("the planner writes only under reports/",
    strip(plan).includes('REPORT_DIR = "reports/c5-orphan-delete"'));
  check("and writes exactly one file, exclusively",
    (strip(plan).match(/writeFileSync\(/g) ?? []).length === 1 && strip(plan).includes('flag: "wx"'));
  // The executor now exists (it is reviewed by image-orphans-execute.test.ts).
  // What this suite guards is that deletion never leaks back into the planner
  // or the rules: those two files must stay incapable of removing anything.
  check("the planner cannot delete even though an executor now exists",
    !/method:\s*["\'`]DELETE["\'`]/i.test(strip(plan)) && !strip(plan).includes(".remove("));
  check("the rules module cannot delete either",
    !/method:\s*["\'`]DELETE["\'`]/i.test(strip(rules)));
  check("the planner never invokes the executor",
    !/require\(|import\(/.test(strip(plan).split("orphan-delete-execute")[0].slice(-80)));
  // C3's planner claimed "there is no C3 deletion path in this PR" and kept
  // claiming it after the executor shipped. The banner here must describe this
  // tool, not the repository, so it cannot rot the same way.
  check("the planner claims nothing about the repository's deletion path",
    !/No C5 executor exists|no C5 deletion path/i.test(plan));
  check("while still saying it deleted nothing itself", /deleted nothing/i.test(plan));

  console.log("\n=== C3 is untouched by C5 ===");
  const c3rules = readFileSync("lib/imageDeletion.ts", "utf8");
  check("C3 still caps its own batches at 5", /MAX_DELETION_BATCH = 5/.test(c3rules));
  check("C3 still refuses legacy executable manifests",
    c3rules.includes("assertNoLegacyExecutableField"));
  check("C5 does not import the C3 executor", !strip(rules).includes("backfill-delete-execute"));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
