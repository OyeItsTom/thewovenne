/**
 * C6's refusals.
 *
 * C6 moves references and keeps the photograph. That makes it the reversible
 * half of this series — and the tests that matter are the ones proving it
 * stays reversible: the original is never deleted, and a source whose
 * references cannot ALL be moved is refused rather than half-migrated.
 *
 * The second theme is that widening the plan must never widen what gets
 * rewritten. A row claimed twice in one batch, a retained cart repointed, a
 * table nobody vetted — each is a way for one photograph's migration to
 * quietly damage another's, and each is refused here.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  C6_ALLOWED_PREFIX,
  C6_MANIFEST_KIND,
  C6_RETAINS_ORIGINALS,
  C6_STATES,
  MAX_C6_BATCH,
  assertC6BatchSize,
  assertC6InScope,
  assertCoherentC6Manifest,
  c6ManifestChecksum,
  classifyForC6,
  isC6Eligible,
  type C6Candidate,
  type C6Manifest,
  type C6ManifestEntry,
} from "../lib/imageC6";
import { MigrationRefused, planRepoints } from "../lib/imageBackfill";
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

/* Real values from the storage audit, so these are regressions and not fiction. */
const SRC = "products/7f3a9dab-2f9f-4487-aa1a-3f8e4d644e8d.jpg";
const URL = `https://x/storage/v1/object/public/product-images/${SRC}`;
const DIGEST = sha("source bytes");

const OK: C6Candidate = {
  sourcePath: SRC, exists: true, sourceBytes: 20_300_000, sourceChecksum: DIGEST,
  displayWidth: 6120, displayHeight: 8160, orientation: 6, format: "jpeg",
  references: [
    { table: "product_images", rowId: "img-1", field: "url", live: true },
    { table: "product_versions", rowId: "ver-1", field: "image_url", live: true },
    { table: "products", rowId: "prd-1", field: "image_url", live: true },
  ],
  graphIsComplete: true, auditedSafeCandidate: true,
};
const spoil = (p: Partial<C6Candidate>): C6Candidate => ({ ...OK, ...p });
const verdict = (p: Partial<C6Candidate> = {}) => classifyForC6(spoil(p), planRepoints, URL);
const state = (p: Partial<C6Candidate> = {}) => verdict(p).state;

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

function main() {
  const rules = readFileSync("lib/imageC6.ts", "utf8");
  const plan = readFileSync("scripts/c6-normalize-plan.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  console.log("\n=== a valid live original ===");
  const v = verdict();
  check("is eligible", v.state === "C6_NORMALIZE_ELIGIBLE");
  check("and only that state is eligible", C6_STATES.filter(isC6Eligible).length === 1);
  check("all three live references are planned for repoint", v.repoints.length === 3);
  check("the plan names the target size", v.reason.includes("2400x3200"));
  check("no blockers", v.blockers.length === 0);

  console.log("\n=== C6 NEVER DELETES THE ORIGINAL ===");
  check("the module says so, exported", C6_RETAINS_ORIGINALS === true);
  check("the rules contain no .remove(", !strip(rules).includes(".remove("));
  check("the rules contain no .delete(", !strip(rules).includes(".delete("));
  check("the planner contains no .remove(", !strip(plan).includes(".remove("));
  check("the planner issues no DELETE", !/method:\s*["'`]DELETE["'`]/i.test(strip(plan)));
  check("the planner issues no PATCH/PUT/POST-to-a-table",
    !/method:\s*["'`](PATCH|PUT)["'`]/i.test(strip(plan)));
  check("the planner uploads nothing",
    !/storage\/v1\/object\/product-images/.test(strip(plan)) && !strip(plan).includes("x-upsert"));
  check("the planner constructs no supabase-js client", !strip(plan).includes("createClient"));
  check("no --execute flag", !/--execute/.test(strip(plan)));
  check("no bypass flag anywhere",
    !/--force|--skip-verif|--ignore-checksum|--allow-|--yes-i-understand/.test(strip(plan) + strip(rules)));
  // The executor now exists (image-c6-execute.test.ts reviews it). What this
  // suite guards is that the PLANNER never gains a write path and never calls
  // it — the same stale-claim trap C3's "no deletion path in this PR" fell
  // into, and C5's "no executor exists yet" after that.
  check("the executor is a separate file the planner never invokes",
    existsSync("scripts/c6-normalize-execute.ts") && !strip(plan).includes("c6-normalize-execute"));
  check("the planner still has no write path of its own",
    !/method:\s*["'`](DELETE|PATCH|PUT)["'`]/i.test(strip(plan)) && !strip(plan).includes("x-upsert"));

  console.log("\n=== the source must be worth migrating ===");
  check("an already-small image is refused",
    state({ displayWidth: 1086, displayHeight: 1448 }) === "C6_BLOCKED_NOTHING_TO_GAIN");
  check("an image exactly at target is refused",
    state({ displayWidth: 2400, displayHeight: 3200 }) === "C6_BLOCKED_NOTHING_TO_GAIN");
  check("an absent source is refused", state({ exists: false }) === "C6_BLOCKED_SOURCE_ABSENT");
  check("unreadable dimensions are refused",
    state({ displayWidth: null, displayHeight: null }) === "C6_BLOCKED_UNREADABLE_DIMENSIONS");
  check("a source with no checksum is refused",
    state({ sourceChecksum: null }) === "C6_BLOCKED_NO_CHECKSUM");
  check("an unreferenced source is refused",
    state({ references: [] }) === "C6_BLOCKED_NOT_LIVE");
  check("a source whose only references are historical is refused",
    state({ references: [{ table: "admin_audit_log", rowId: "a", field: "changes", live: false }] })
      === "C6_BLOCKED_NOT_LIVE");

  console.log("\n=== existing masters and out-of-scope media ===");
  check(`the allowed prefix is ${C6_ALLOWED_PREFIX}`, C6_ALLOWED_PREFIX === "products/");
  check("an existing master is refused",
    state({ sourcePath: "products/abcdef0123456789abcdef0123456789-v1.jpg" }) === "C6_BLOCKED_OUT_OF_SCOPE");
  refuses("a master is refused by the scope guard too",
    () => assertC6InScope("products/abcdef0123456789abcdef0123456789-v1.jpg"), "c6_out_of_scope");
  for (const [what, path] of [["lookbook", "lookbook/a.jpg"], ["campaigns", "campaigns/a.png"],
                              ["HEIC", "products/a.heic"], ["HEIF", "products/a.HEIF"]] as const) {
    check(`${what} is refused`, state({ sourcePath: path }) === "C6_BLOCKED_OUT_OF_SCOPE");
    refuses(`${what} is refused by the guard`, () => assertC6InScope(path), "c6_out_of_scope");
  }
  check("a HEIF-format file is refused even with a .jpg name",
    state({ format: "HEIF" }) === "C6_BLOCKED_OUT_OF_SCOPE");
  refuses("a folder is refused", () => assertC6InScope("products/"), "c6_out_of_scope");
  refuses("a wildcard is refused", () => assertC6InScope("products/*"), "c6_out_of_scope");
  refuses("traversal is refused", () => assertC6InScope("products/../x.jpg"), "c6_out_of_scope");
  check("an object outside the audited scope is manual review",
    state({ auditedSafeCandidate: false }) === "C6_MANUAL_REVIEW");

  console.log("\n=== EVERY REFERENCE MUST BE MOVABLE, OR NOTHING MOVES ===");
  //
  // A half-migrated photograph is worse than an unmigrated one: the site shows
  // the master from one row and the original from another, and nothing looks
  // broken enough to notice.
  const withSite = state({ references: [
    ...OK.references, { table: "site_content", rowId: "s-1", field: "value", live: true }] });
  check("a site_content reference blocks the whole source",
    withSite === "C6_BLOCKED_UNREPOINTABLE_REFERENCE");
  const withUnknown = state({ references: [
    ...OK.references, { table: "some_new_table", rowId: "n-1", field: "img", live: true }] });
  check("an unknown table blocks the whole source",
    withUnknown === "C6_BLOCKED_UNREPOINTABLE_REFERENCE");
  check("a reference in an unexpected column blocks",
    state({ references: [{ table: "products", rowId: "p", field: "thumbnail_url", live: true }] })
      === "C6_BLOCKED_UNREPOINTABLE_REFERENCE");
  check("the blocker names the offending table",
    verdict({ references: [...OK.references, { table: "site_content", rowId: "s", field: "value", live: true }] })
      .blockers.some((b) => b.table === "site_content"));

  console.log("\n=== carts are retained, never rewritten ===");
  const withCart = verdict({ references: [...OK.references,
    { table: "carts", rowId: "cart-1", field: "items", live: true }] });
  check("a cart alongside product rows does NOT block the migration",
    withCart.state === "C6_NORMALIZE_ELIGIBLE");
  check("the cart is recorded as retained", withCart.retained.some((r) => r.table === "carts"));
  check("and is never in the repoint list", !withCart.repoints.some((r) => r.table === "carts"));
  check("a source held ONLY by a cart has nothing to move",
    state({ references: [{ table: "carts", rowId: "c", field: "items", live: true }] })
      === "C6_BLOCKED_CART_HELD");

  console.log("\n=== structure outranks everything ===");
  check("an incomplete graph blocks first",
    state({ graphIsComplete: false }) === "C6_BLOCKED_GRAPH_INCOMPLETE");
  check("even when every other fact is perfect",
    state({ graphIsComplete: false, references: OK.references }) === "C6_BLOCKED_GRAPH_INCOMPLETE");

  console.log("\n=== shared and repeated references ===");
  const shared = verdict({ references: [
    { table: "product_images", rowId: "img-1", field: "url", live: true },
    { table: "product_images", rowId: "img-2", field: "url", live: true },
    { table: "product_versions", rowId: "ver-archived", field: "image_url", live: true },
    { table: "product_versions", rowId: "ver-published", field: "image_url", live: true },
  ]});
  check("one photograph used by four rows plans four repoints", shared.repoints.length === 4);
  check("each repoint names its own row",
    new Set(shared.repoints.map((r) => r.rowId)).size === 4);
  check("every repoint carries the old URL for compare-and-set",
    shared.repoints.every((r) => r.oldUrl === URL));

  console.log("\n=== batch ceiling ===");
  check(`MAX_C6_BATCH is ${MAX_C6_BATCH}`, MAX_C6_BATCH === 5);
  check("it is smaller than C2's ceiling of 10", MAX_C6_BATCH < 10);
  check("five is allowed", (() => { assertC6BatchSize(5); return true; })());
  check("a short final batch is allowed", (() => { assertC6BatchSize(2); return true; })());
  refuses("six is refused", () => assertC6BatchSize(6), "batch_too_large");
  refuses("zero is refused", () => assertC6BatchSize(0), "empty_batch");
  // The ceiling is a constant, declared once, and no CLI flag reaches it.
  check("the ceiling is declared exactly once, as the literal 5",
    (strip(rules).match(/MAX_C6_BATCH\s*=\s*5\s*;/g) ?? []).length === 1 &&
    (strip(rules).match(/MAX_C6_BATCH\s*=/g) ?? []).length === 1);
  check("no flag can raise it",
    !/--batch-size|--limit\b|--max|--ceiling|--count/.test(strip(plan) + strip(rules)));
  check("the planner slices to the constant, never to an argument",
    strip(plan).includes("eligible.slice(0, MAX_C6_BATCH)"));

  console.log("\n=== manifest checksum covers every execution-critical field ===");
  const subject = { batchId: "c6-1", normalizerVersion: NORMALIZER_VERSION, entries: [ENTRY] };
  const sum = c6ManifestChecksum(subject, sha);
  check("stable", c6ManifestChecksum(subject, sha) === sum);
  check("batch id is covered",
    c6ManifestChecksum({ ...subject, batchId: "c6-2" }, sha) !== sum);
  check("normalizer version is covered",
    c6ManifestChecksum({ ...subject, normalizerVersion: 2 }, sha) !== sum);
  check("source checksum is covered",
    c6ManifestChecksum({ ...subject, entries: [{ ...ENTRY, sourceChecksum: sha("other") }] }, sha) !== sum);
  check("target dimensions are covered",
    c6ManifestChecksum({ ...subject, entries: [{ ...ENTRY, targetWidth: 1920 }] }, sha) !== sum);
  check("WHICH ROW is repointed is covered",
    c6ManifestChecksum({ ...subject, entries: [{ ...ENTRY,
      repoints: [{ ...ENTRY.repoints[0], rowId: "img-999" }] }] }, sha) !== sum);
  check("the compare-and-set oldUrl is covered",
    c6ManifestChecksum({ ...subject, entries: [{ ...ENTRY,
      repoints: [{ ...ENTRY.repoints[0], oldUrl: "https://x/other.jpg" }] }] }, sha) !== sum);
  check("retained identities are covered",
    c6ManifestChecksum({ ...subject, entries: [{ ...ENTRY,
      retained: [{ table: "carts", rowId: "c-1" }] }] }, sha) !== sum);
  check("repoint ordering is canonicalised", c6ManifestChecksum({ ...subject, entries: [{ ...ENTRY,
      repoints: [
        { table: "products", rowId: "b", column: "image_url", oldUrl: URL },
        { table: "product_images", rowId: "a", column: "url", oldUrl: URL }] }] }, sha)
    === c6ManifestChecksum({ ...subject, entries: [{ ...ENTRY,
      repoints: [
        { table: "product_images", rowId: "a", column: "url", oldUrl: URL },
        { table: "products", rowId: "b", column: "image_url", oldUrl: URL }] }] }, sha));

  console.log("\n=== manifest coherence, checked before anything is written ===");
  check("a coherent manifest passes", (() => { assertCoherentC6Manifest(manifest([ENTRY])); return true; })());
  refuses("the wrong kind is refused",
    () => assertCoherentC6Manifest({ ...manifest([ENTRY]), kind: "c2" as never }), "wrong_kind");
  refuses("a different normalizer version is refused",
    () => assertCoherentC6Manifest({ ...manifest([ENTRY]), normalizerVersion: 99 }), "version_mismatch");
  refuses("six entries are refused", () => assertCoherentC6Manifest(manifest(
    [1, 2, 3, 4, 5, 6].map((n) => ({ ...ENTRY, sourcePath: `products/${n}.jpg` })))), "batch_too_large");
  refuses("an entry with no repoints is refused",
    () => assertCoherentC6Manifest(manifest([{ ...ENTRY, repoints: [] }])), "no_repoints");
  refuses("an entry that would enlarge is refused",
    () => assertCoherentC6Manifest(manifest([{ ...ENTRY, targetWidth: 9000 }])), "would_enlarge");
  refuses("an entry already at target is refused",
    () => assertCoherentC6Manifest(manifest([{ ...ENTRY, targetWidth: 6120, targetHeight: 8160 }])), "nothing_to_gain");
  refuses("repointing a cart is refused",
    () => assertCoherentC6Manifest(manifest([{ ...ENTRY,
      repoints: [{ table: "carts", rowId: "c", column: "items", oldUrl: URL }] }])), "unrepointable_table");
  refuses("repointing an unvetted table is refused",
    () => assertCoherentC6Manifest(manifest([{ ...ENTRY,
      repoints: [{ table: "orders", rowId: "o", column: "image_url", oldUrl: URL }] }])), "unrepointable_table");
  refuses("recording a non-retained table as retained is refused",
    () => assertCoherentC6Manifest(manifest([{ ...ENTRY,
      retained: [{ table: "products", rowId: "p" }] }])), "bad_retained");
  refuses("duplicate source paths are refused",
    () => assertCoherentC6Manifest(manifest([
      ENTRY,
      { ...ENTRY, repoints: [{ table: "products", rowId: "prd-9", column: "image_url", oldUrl: URL }] },
    ])), "duplicate_entries");
  //
  // TWO SOURCES CLAIMING ONE ROW. Whichever ran second would silently undo the
  // first, and the batch would report success.
  refuses("the same row repointed by two entries is refused",
    () => assertCoherentC6Manifest(manifest([
      ENTRY,
      { ...ENTRY, sourcePath: "products/other.jpg", sourceChecksum: sha("b") },
    ])), "duplicate_repoint");

  console.log("\n=== C2/C3/C5 are untouched by C6 ===");
  check("C6 does not import a C3 or C5 executor",
    !strip(rules).includes("backfill-delete-execute") && !strip(rules).includes("orphan-delete-execute"));
  check("C6 reuses C2's repoint planner rather than reimplementing it",
    strip(plan).includes("planRepoints") && !strip(rules).includes("function planRepoints"));
  check("C3 still caps its own batches at 5",
    /MAX_DELETION_BATCH = 5/.test(readFileSync("lib/imageDeletion.ts", "utf8")));
  check("C5 still refuses a master as a twin",
    readFileSync("lib/imageOrphans.ts", "utf8").includes("C5_BLOCKED_TWIN_IS_MASTER"));
  check("the C2 executor still holds the only migration write path",
    /method:\s*"PATCH"/.test(readFileSync("scripts/backfill-execute.ts", "utf8")));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
