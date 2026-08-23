/**
 * C5's execution refusals.
 *
 * Deletion has no rollback, so every test here checks that a photograph does
 * NOT get removed, or that if one does, exactly one does and the evidence
 * survives. The source-reading assertions at the end matter as much as the
 * behavioural ones: they are what keeps this from quietly becoming a general
 * orphan-cleaner later.
 *
 * The case worth reading twice is "a master is never a twin". Two objects
 * reached the C4 audit's HIGH_CONFIDENCE_ORPHAN class on a "duplicate of
 * master" match that was an artefact of master filenames embedding the hash of
 * their SOURCE. Both were the last full-resolution copy of their photograph.
 * Nothing about reference counts would have caught it.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  C5_MANIFEST_KIND,
  MAX_C5_DELETION_BATCH,
  assertC5BatchSize,
  assertCoherentOrphanManifest,
  classifyOrphan,
  isC5Eligible,
  orphanManifestChecksum,
  type OrphanCandidate,
  type OrphanManifest,
  type OrphanManifestEntry,
} from "../lib/imageOrphans";
import { C5_FLAGS, assertC5Flags } from "./orphan-delete-execute";
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

/* Real values from the C5 plan, so these are regressions and not fiction. */
const CANDIDATE = "products/590b3a39-59b3-4404-9c5f-a884a493d54c.jpg";
const TWIN = "products/27f86f7e-2e17-4b79-a7ec-2fb06f1482ed.jpg";
const MASTER = "products/b1e8814536bfe830ecb10035732bedcb-v1.jpg";
const DIGEST = sha("the same photograph");
const BYTES = 19_197_866;

const OK: OrphanCandidate = {
  path: CANDIDATE, exists: true, bytes: BYTES, checksum: DIGEST,
  liveReferences: [], historicalReferences: 0,
  twin: { path: TWIN, exists: true, bytes: BYTES, checksum: DIGEST,
          liveReferences: [{ table: "product_images", rowId: "r1", field: "url" }] },
  graphIsComplete: true, auditedHighConfidence: true,
};
const spoil = (p: Partial<OrphanCandidate>): OrphanCandidate => ({ ...OK, ...p });
const state = (p: Partial<OrphanCandidate>) => classifyOrphan(spoil(p)).state;
const twin = (p: Partial<NonNullable<OrphanCandidate["twin"]>>) =>
  state({ twin: { ...OK.twin!, ...p } });

const ENTRY: OrphanManifestEntry = {
  candidatePath: CANDIDATE, candidateBytes: BYTES, candidateChecksum: DIGEST,
  twinPath: TWIN, twinBytes: BYTES, twinChecksum: DIGEST,
  expectedTwinLiveReferences: 1,
  expectedCandidateLiveReferences: 0, expectedCandidateHistoricalReferences: 0,
};
const manifest = (entries: OrphanManifestEntry[], batchId = "c5-orphan-1"): OrphanManifest => ({
  kind: C5_MANIFEST_KIND, batchId, createdAt: "x", entries,
  checksum: orphanManifestChecksum({ batchId, entries }, sha),
});
const flags = (over: Partial<Record<string, string>> = {}, omit: string[] = []) => {
  const a: string[] = [];
  if (!omit.includes("execute")) a.push(C5_FLAGS.execute);
  if (!omit.includes("ack")) a.push(over.ack ?? C5_FLAGS.acknowledgement);
  if (!omit.includes("batch")) a.push(C5_FLAGS.batchId, over.batch ?? "c5-orphan-1");
  if (!omit.includes("manifest")) a.push(C5_FLAGS.manifest, over.manifest ?? "m.json");
  return a;
};

function main() {
  const exec = readFileSync("scripts/orphan-delete-execute.ts", "utf8");
  const rules = readFileSync("lib/imageOrphans.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bare = strip(exec);

  console.log("\n=== the destructive command line ===");
  const ok = assertC5Flags(flags());
  check("all four flags together are accepted",
    ok.batchId === "c5-orphan-1" && ok.manifestPath === "m.json");
  refuses("without --execute", () => assertC5Flags(flags({}, ["execute"])), "not_execute");
  refuses("without the acknowledgement", () => assertC5Flags(flags({}, ["ack"])), "missing_acknowledgement");
  refuses("without --batch-id", () => assertC5Flags(flags({}, ["batch"])), "missing_batch_id");
  refuses("without --source-manifest", () => assertC5Flags(flags({}, ["manifest"])), "missing_manifest");
  refuses("C3's acknowledgement does not work here",
    () => assertC5Flags(flags({ ack: "--yes-i-understand-original-deletion-is-permanent" })), "missing_acknowledgement");
  refuses("nor C2's",
    () => assertC5Flags(flags({ ack: "--yes-i-understand-originals-are-retained" })), "missing_acknowledgement");
  refuses("and offering C3's alongside the right one is still an error",
    () => assertC5Flags([...flags(), "--yes-i-understand-original-deletion-is-permanent"]), "wrong_acknowledgement");
  refuses("a traversal batch id is refused", () => assertC5Flags(flags({ batch: "../x" })), "invalid_batch_id");
  check("the three acknowledgements share no suffix",
    new Set(["--yes-i-understand-originals-are-retained",
             "--yes-i-understand-original-deletion-is-permanent",
             C5_FLAGS.acknowledgement]).size === 3);

  console.log("\n=== a valid duplicate pair, so the refusals mean something ===");
  check("a proven pair is eligible", state({}) === "C5_DELETE_ELIGIBLE");
  check("only one state is ever eligible",
    isC5Eligible("C5_DELETE_ELIGIBLE") && !isC5Eligible("C5_MANUAL_REVIEW"));

  console.log("\n=== the candidate must still be an orphan at execution time ===");
  check("candidate gains a product reference",
    state({ liveReferences: [{ table: "product_images", rowId: "i", field: "url" }] }) === "C5_BLOCKED_LIVE_REFERENCE");
  check("candidate gains a CART reference",
    state({ liveReferences: [{ table: "carts", rowId: "c", field: "items" }] }) === "C5_BLOCKED_LIVE_REFERENCE");
  check("candidate gains a site_content reference",
    state({ liveReferences: [{ table: "site_content", rowId: "s", field: "value" }] }) === "C5_BLOCKED_LIVE_REFERENCE");
  check("candidate gains an AUDIT reference",
    state({ historicalReferences: 1 }) === "C5_BLOCKED_AUDIT_REFERENCE");
  check("candidate absent", state({ exists: false }) === "C5_BLOCKED_CANDIDATE_ABSENT");

  console.log("\n=== the twin must still be a survivor ===");
  check("twin missing", twin({ exists: false }) === "C5_BLOCKED_TWIN_ABSENT");
  check("twin loses its last live reference", twin({ liveReferences: [] }) === "C5_BLOCKED_TWIN_UNREFERENCED");
  check("SHA mismatch", twin({ checksum: sha("different") }) === "C5_BLOCKED_CHECKSUM_MISMATCH");
  check("byte mismatch", twin({ bytes: BYTES - 1 }) === "C5_BLOCKED_BYTES_MISMATCH");
  check("no twin at all", state({ twin: null }) === "C5_BLOCKED_NO_TWIN");

  console.log("\n=== A MASTER IS NEVER A TWIN ===");
  //
  // The C4 audit's mistake, locked out on shape as well as on bytes.
  check("a master cited as the survivor is refused",
    twin({ path: MASTER }) === "C5_BLOCKED_TWIN_IS_MASTER");
  check("even when every other fact looks perfect",
    twin({ path: MASTER, exists: true, bytes: BYTES, checksum: DIGEST,
           liveReferences: [{ table: "product_images", rowId: "r", field: "url" }] }) === "C5_BLOCKED_TWIN_IS_MASTER");
  refuses("and a manifest naming a master as twin is refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, twinPath: MASTER }])), "twin_is_master");
  check("the rule is documented where it is enforced",
    rules.includes("A NORMALISED MASTER IS NEVER A TWIN"));

  console.log("\n=== candidate == twin, and twin-also-candidate ===");
  refuses("candidate == twin is refused by the manifest",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, twinPath: CANDIDATE }])), "c5_out_of_scope");
  refuses("a survivor queued for deletion in the same batch is refused",
    () => assertCoherentOrphanManifest(manifest([
      ENTRY, { ...ENTRY, candidatePath: TWIN, twinPath: "products/third.jpg" }])), "twin_also_candidate");
  check("the executor re-checks that at run time, not only in the manifest",
    bare.includes("candidatePaths.has(entry.twinPath)"));

  console.log("\n=== unique content and manual-review objects cannot enter ===");
  check("unique content has no twin, so it cannot be eligible",
    state({ twin: null }) !== "C5_DELETE_ELIGIBLE");
  check("an object the audit did not approve is manual review",
    state({ auditedHighConfidence: false }) === "C5_MANUAL_REVIEW");
  check("master-derivative-only cases resolve to a blocked state, never eligible",
    !isC5Eligible(twin({ path: MASTER }) as never));

  console.log("\n=== out-of-scope media cannot enter ===");
  for (const [what, path] of [["lookbook", "lookbook/a.jpg"], ["campaigns", "campaigns/a.png"],
                              ["HEIC", "products/a.heic"], ["HEIF", "products/a.heif"]] as const) {
    check(`${what} is refused by classification`, state({ path }) === "C5_BLOCKED_OUT_OF_SCOPE");
    refuses(`${what} is refused by the manifest`,
      () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, candidatePath: path }])), "c5_out_of_scope");
  }
  refuses("a folder path is refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, candidatePath: "products/" }])), "c5_out_of_scope");
  refuses("a wildcard is refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, candidatePath: "products/*" }])), "c5_out_of_scope");
  refuses("traversal is refused",
    () => assertCoherentOrphanManifest(manifest([{ ...ENTRY, candidatePath: "products/../a.jpg" }])), "c5_out_of_scope");

  console.log("\n=== structure outranks everything ===");
  check("an incomplete graph blocks", state({ graphIsComplete: false }) === "C5_BLOCKED_GRAPH_INCOMPLETE");
  check("the executor stops on an incomplete graph rather than continuing",
    bare.includes("reference graph incomplete"));
  check("the graph is rebuilt for EVERY object, not once per batch",
    bare.includes("for (const entry of manifest.entries)") &&
    bare.indexOf("await freshGraph()") > bare.indexOf("for (const entry of manifest.entries)"));

  console.log("\n=== manifest integrity ===");
  const subject = { batchId: "c5-orphan-1", entries: [ENTRY] };
  const sum = orphanManifestChecksum(subject, sha);
  check("the executor recomputes rather than trusting the file",
    bare.includes("const selfChecksum = orphanManifestChecksum(") && bare.includes("selfChecksum !== manifest.checksum"));
  check("and refuses a tampered manifest", bare.includes('"manifest_tampered"'));
  check("kind is checked", bare.includes("manifest.kind !== C5_MANIFEST_KIND"));
  check("a C3 manifest cannot be passed to C5", bare.includes('"wrong_kind"'));
  check("batch id mismatch refused", bare.includes('"batch_id_mismatch"'));
  check("the executor runs full pair coherence", bare.includes("assertCoherentOrphanManifest(manifest)"));
  check("twin path is inside the checksum",
    orphanManifestChecksum({ ...subject, entries: [{ ...ENTRY, twinPath: "products/z.jpg" }] }, sha) !== sum);
  check("expected twin reference count is inside the checksum",
    orphanManifestChecksum({ ...subject, entries: [{ ...ENTRY, expectedTwinLiveReferences: 4 }] }, sha) !== sum);
  refuses("batch of six refused", () => assertC5BatchSize(6), "batch_too_large");
  check(`ceiling is ${MAX_C5_DELETION_BATCH}`, MAX_C5_DELETION_BATCH === 5);
  check("the executor enforces the ceiling", bare.includes("assertC5BatchSize(manifest.entries.length)"));

  console.log("\n=== the executor re-proves the plan against live data ===");
  for (const [what, needle] of [
    ["candidate digest vs manifest", "candidateDigest !== entry.candidateChecksum"],
    ["twin digest vs manifest", "twinDigest !== entry.twinChecksum"],
    ["candidate bytes vs manifest", "candidateBuffer.byteLength !== entry.candidateBytes"],
    ["twin bytes vs manifest", "twinBuffer.byteLength !== entry.twinBytes"],
    ["twin reference count vs manifest", "twinLive.length !== entry.expectedTwinLiveReferences"],
  ] as const) check(`re-checks ${what}`, bare.includes(needle));
  check("BOTH objects are downloaded, not just the candidate",
    (bare.match(/await objectBytes\(/g) ?? []).length === 2);
  check("both digests are computed from live bytes",
    (bare.match(/sha256Bytes\(/g) ?? []).length === 2);
  check("the classifier runs again at execution time", bare.includes("classifyOrphan(candidate)"));
  check("the path guard runs twice, including last before the call",
    (bare.match(/assertC5InScope\(/g) ?? []).length >= 2);

  console.log("\n=== evidence is written before the object is destroyed ===");
  check("PREDELETE_VERIFIED is appended before DELETE_REQUESTED",
    bare.indexOf('record("PREDELETE_VERIFIED")') < bare.indexOf('record("DELETE_REQUESTED"'));
  check("and DELETE_REQUESTED before the fetch",
    bare.indexOf('record("DELETE_REQUESTED"') < bare.indexOf('method: "DELETE"'));
  check("a ledger write failure is NOT swallowed, so it prevents the delete",
    !/try\s*{[^}]*appendFileSync/.test(bare) && bare.includes("appendFileSync"));
  check("the ledger is append-only", bare.includes('flag: "a"'));
  check("the ledger lives under reports/", bare.includes('LEDGER_DIR = "reports/c5-orphan-delete"'));
  check("evidence records BOTH halves of the pair",
    bare.includes("twinChecksum: twinDigest") && bare.includes("candidateChecksum: candidateDigest"));

  console.log("\n=== the outcome is proved, both halves ===");
  check("candidate absence is verified after the delete",
    bare.includes("delete reported success but the candidate still exists"));
  check("twin readability is verified after the delete",
    bare.includes("TWIN UNREADABLE AFTER DELETE"));
  check("twin reference survival is verified after the delete",
    bare.includes("TWIN LOST ITS LAST LIVE REFERENCE"));
  check("DELETE_CONFIRMED records the twin's state afterwards",
    bare.includes("twinLiveReferencesAfter"));
  check("a failed DELETE stops the batch", bare.includes("storage delete failed"));

  console.log("\n=== first failure stops everything ===");
  check("the loop exits the process rather than continuing", bare.includes("process.exit(1)"));
  // Scoped to the DELETION loop's own catch block. A `continue` inside the
  // table-reading loop is fine and unrelated; what must never exist is a path
  // that swallows a failed object and moves on to the next one.
  const deletionCatch = bare.slice(bare.indexOf("} catch (error) {"));
  check("the deletion loop's catch exits instead of continuing",
    deletionCatch.includes("process.exit(1)") && !/\bcontinue\b/.test(deletionCatch.slice(0, 400)));
  check("and no retry loop", !/for\s*\(let\s+attempt/.test(bare) && !bare.includes("retries"));
  check("an already-absent entry resolves without deleting anything",
    bare.includes('record("ALREADY_ABSENT"') && bare.includes("nothing was deleted"));
  check("an ambiguous absence stops instead of guessing",
    bare.includes("missing from the listing but still readable"));

  console.log("\n=== exactly one object, never a prefix, never a database row ===");
  check("exactly one HTTP DELETE in the whole file",
    (bare.match(/method:\s*["'`]DELETE["'`]/g) ?? []).length === 1);
  check("it targets an exact single object path",
    bare.includes("/storage/v1/object/${BUCKET}/${entry.candidatePath}"));
  check("no bulk/prefix delete API is used",
    !bare.includes("object/list") || !/method:\s*["'`]DELETE["'`][\s\S]{0,200}prefix/.test(bare));
  check("no supabase-js client is constructed", !bare.includes("createClient"));
  check("no PATCH, POST or PUT to any table",
    !/rest\/v1\/[^`"']*`[^)]*method:\s*["'`](PATCH|POST|PUT)/.test(bare));
  check("no write method other than the one DELETE",
    (bare.match(/method:\s*["'`](\w+)["'`]/gi) ?? [])
      .every((m) => /GET|HEAD|POST|DELETE/i.test(m)));
  check("the only POST is the storage listing",
    (bare.match(/method:\s*["'`]POST["'`]/gi) ?? []).length <= 1);
  check("carts are never written", !/carts[\s\S]{0,120}method:\s*["'`](PATCH|POST|PUT|DELETE)/.test(bare));

  console.log("\n=== no bypass, and no generic cleaner mode ===");
  check("no force/skip/ignore/continue flag",
    !/--force|--skip-verif|--ignore-checksum|--allow-|--continue|--no-verify|--dry-run-delete/.test(bare));
  check("there is no flag naming a path directly",
    !/--path|--key|--object|--prefix/.test(bare));
  check("there is no bucket-wide sweep to iterate",
    !bare.includes("for (const key of objects.keys())"));
  check("candidates come only from the manifest",
    bare.includes("for (const entry of manifest.entries)"));

  console.log("\n=== C2, C3 and the planner are untouched ===");
  check("C5 does not import the C3 executor", !bare.includes("backfill-delete-execute"));
  const c3 = readFileSync("scripts/backfill-delete-execute.ts", "utf8");
  check("C3 still has exactly one DELETE of its own",
    (strip(c3).match(/method:\s*["'`]DELETE["'`]/g) ?? []).length === 1);
  check("C3 still refuses legacy executable manifests", c3.includes("assertNoLegacyExecutableField"));
  const planner = readFileSync("scripts/orphan-delete-plan.ts", "utf8");
  check("the C5 planner still has no deletion path",
    !/method:\s*["'`]DELETE["'`]/.test(strip(planner)) && !strip(planner).includes(".remove("));
  check("deletion lives in exactly one C5 file",
    ["lib/imageOrphans.ts", "lib/storagePrefixes.ts", "scripts/orphan-delete-plan.ts"]
      .every((f) => !/method:\s*["'`]DELETE["'`]/.test(strip(readFileSync(f, "utf8")))));
  check("no second C5 executor appeared",
    !existsSync("scripts/orphan-cleanup.ts") && !existsSync("scripts/orphan-delete-all.ts"));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
