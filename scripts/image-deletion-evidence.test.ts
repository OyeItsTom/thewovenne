/**
 * Telling "we deleted this on purpose" apart from "this is missing".
 *
 * After the first C3 batch the planner reported the five originals it had just
 * deleted as removed by "something outside this tooling" — technically a
 * fail-closed classification, but a false statement that would send somebody
 * looking for an intruder that was us. C3_DELETED fixes the report.
 *
 * The risk in adding it is the opposite mistake: treating an unexplained
 * absence as finished business. So almost every test here is a check that
 * evidence is NOT accepted — a partial sequence, a contradictory one, one that
 * disagrees with what C2 recorded, or one that is simply unparseable.
 */
import { readFileSync } from "node:fs";
import {
  classifyForDeletion,
  isDeletionLedgerName,
  isEligible,
  validateDeletionEvidence,
  type DeletionCandidate,
  type ExpectedDeletionSubject,
  type RawLedgerRecord,
} from "../lib/imageDeletion";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}

/* The real batch-1 shape, so this mirrors production evidence. */
const SRC = "products/66cc913b-7cb1-4a06-aa69-b5236c21213c.jpg";
const MASTER = "products/1bace78e883cf0a657cb4d733df6b661-v1.jpg";
const DIGEST = "1bace78e883cf0a657cb4d733df6b6618b8cbe317ffbc38cb2752847a5dea5f8";
const BYTES = 29667768;
const BATCH = "c3-delete-1";
const MSUM = "dc4e480198d57527e79c34d2c3cc57c4408ad71072e6b39eaf16997382d6e2f2";
const FILE = "deleted-c3-delete-1-2026-08-22T11-54-59-522Z.ndjson";

const EXPECTED: ExpectedDeletionSubject = {
  sourcePath: SRC, sourceBytes: BYTES, sourceChecksum: DIGEST,
  masterPath: MASTER, normalizerVersion: 1,
};

const evidenceBlock = (over: Record<string, unknown> = {}) => ({
  timestamp: "2026-08-22T11:55:04.303Z", batchId: BATCH, manifestChecksum: MSUM,
  sourcePath: SRC, sourceBytes: BYTES, sourceChecksum: DIGEST,
  sourceDimensions: "8160x6120", masterPath: MASTER, masterBytes: 5383405,
  masterDimensions: "2400x3200", normalizerVersion: 1, liveReferencesOnSource: 0,
  liveReferenceIdentitiesOnMaster: [{ table: "product_images", rowId: "r1", field: "url" }],
  liveReferencesOnMaster: 1, historicalReferencesOnSource: 0, ...over,
});

const seq = (over: { evidence?: Record<string, unknown>; drop?: string[]; extra?: RawLedgerRecord[] } = {}): RawLedgerRecord[] => {
  const base = (status: string): RawLedgerRecord => ({
    timestamp: "2026-08-22T11:55:0" + (status === "DELETE_CONFIRMED" ? "9" : "4") + ".000Z",
    batchId: BATCH, manifestChecksum: MSUM, sourcePath: SRC, status,
  });
  const rows: RawLedgerRecord[] = [
    { ...base("PREDELETE_VERIFIED"), evidence: evidenceBlock(over.evidence ?? {}) },
    base("DELETE_REQUESTED"),
    base("DELETE_CONFIRMED"),
  ].filter((r) => !(over.drop ?? []).includes(r.status as string));
  return [...rows, ...(over.extra ?? [])];
};

const ABSENT: DeletionCandidate = {
  sourcePath: SRC, sourceUrl: "https://x/" + SRC, sourceBytes: BYTES,
  sourceExists: false, sourceFormat: "jpeg",
  masterPath: MASTER, masterUrl: "https://x/" + MASTER,
  masterExists: true, masterReadable: true, masterNormalizerVersion: 1,
  expectedNormalizerVersion: 1, masterLiveReferences: 1,
  ledgerVerified: true, graphIsComplete: true,
  liveReferencesOnSource: [], historicalReferencesOnSource: 0, unknownReferencesOnSource: 0,
};

function main() {
  const rules = readFileSync("lib/imageDeletion.ts", "utf8");
  const plan = readFileSync("scripts/backfill-delete-plan.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  console.log("\n=== A. a complete, consistent sequence proves deletion ===");
  const good = validateDeletionEvidence(seq(), EXPECTED, FILE);
  check("A: valid evidence validates", good !== null);
  check("A: it names the batch", good?.batchId === BATCH);
  check("A: it names the ledger that proves it", good?.ledgerFile === FILE);
  check("A: it carries the confirmation time", !!good?.confirmedAt);
  check("A: an absent original with it classifies C3_DELETED",
    classifyForDeletion({ ...ABSENT, deletionEvidence: good }).state === "C3_DELETED");
  check("A: and the reason says so, without blaming an outsider", (() => {
    const r = classifyForDeletion({ ...ABSENT, deletionEvidence: good }).reason;
    return r.includes("deleted by C3") && !r.includes("outside this tooling");
  })());

  console.log("\n=== B-E. an incomplete or foreign sequence proves nothing ===");
  check("B: no ledger at all -> MANUAL_REVIEW",
    classifyForDeletion({ ...ABSENT, deletionEvidence: null }).state === "C3_MANUAL_REVIEW");
  check("B: and undefined behaves the same as null",
    classifyForDeletion(ABSENT).state === "C3_MANUAL_REVIEW");
  check("B: the reason still warns about an outside actor",
    classifyForDeletion(ABSENT).reason.includes("outside this tooling"));
  check("B: an empty record list is not evidence",
    validateDeletionEvidence([], EXPECTED, FILE) === null);
  check("C: PREDELETE_VERIFIED alone is not evidence",
    validateDeletionEvidence(seq({ drop: ["DELETE_REQUESTED", "DELETE_CONFIRMED"] }), EXPECTED, FILE) === null);
  check("D: verified + requested, never confirmed, is not evidence",
    validateDeletionEvidence(seq({ drop: ["DELETE_CONFIRMED"] }), EXPECTED, FILE) === null);
  check("D: confirmed without the verification is not evidence",
    validateDeletionEvidence(seq({ drop: ["PREDELETE_VERIFIED"] }), EXPECTED, FILE) === null);
  check("E: a confirmation for a DIFFERENT source proves nothing about this one",
    validateDeletionEvidence(
      seq().map((r) => ({ ...r, sourcePath: "products/somebody-else.jpg" })), EXPECTED, FILE) === null);
  check("E: a confirmation for another source mixed in is ignored, not borrowed",
    validateDeletionEvidence(
      [...seq({ drop: ["DELETE_CONFIRMED"] }),
       { batchId: BATCH, manifestChecksum: MSUM, sourcePath: "products/other.jpg",
         status: "DELETE_CONFIRMED", timestamp: "t" }], EXPECTED, FILE) === null);

  console.log("\n=== F-I. evidence must agree with what C2 recorded ===");
  check("F: a checksum mismatch is refused",
    validateDeletionEvidence(seq({ evidence: { sourceChecksum: "f".repeat(64) } }), EXPECTED, FILE) === null);
  check("F: a non-sha256 checksum is refused",
    validateDeletionEvidence(seq({ evidence: { sourceChecksum: "not-a-digest" } }), EXPECTED, FILE) === null);
  check("G: a byte-size mismatch is refused",
    validateDeletionEvidence(seq({ evidence: { sourceBytes: BYTES + 1 } }), EXPECTED, FILE) === null);
  check("H: a master mismatch is refused",
    validateDeletionEvidence(seq({ evidence: { masterPath: "products/other-v1.jpg" } }), EXPECTED, FILE) === null);
  check("H: a normalizer-version mismatch is refused",
    validateDeletionEvidence(seq({ evidence: { normalizerVersion: 2 } }), EXPECTED, FILE) === null);
  check("I: a manifest-checksum disagreement across the sequence is refused",
    validateDeletionEvidence(
      seq().map((r, i) => (i === 2 ? { ...r, manifestChecksum: "0".repeat(64) } : r)), EXPECTED, FILE) === null);
  check("I: a batch-id disagreement across the sequence is refused",
    validateDeletionEvidence(
      seq().map((r, i) => (i === 2 ? { ...r, batchId: "c3-delete-9" } : r)), EXPECTED, FILE) === null);
  check("I: an evidence block naming another batch is refused",
    validateDeletionEvidence(seq({ evidence: { batchId: "c3-delete-9" } }), EXPECTED, FILE) === null);
  check("I: evidence claiming live references remained is refused",
    validateDeletionEvidence(seq({ evidence: { liveReferencesOnSource: 1 } }), EXPECTED, FILE) === null);

  console.log("\n=== J. malformed, contradictory and duplicated records fail closed ===");
  check("J: a missing evidence block is refused",
    validateDeletionEvidence(seq().map((r) => ({ ...r, evidence: undefined })), EXPECTED, FILE) === null);
  check("J: a non-object evidence block is refused",
    validateDeletionEvidence(seq({ }).map((r) => (r.status === "PREDELETE_VERIFIED" ? { ...r, evidence: "yes" } : r)), EXPECTED, FILE) === null);
  check("J: a null evidence block is refused",
    validateDeletionEvidence(seq({ }).map((r) => (r.status === "PREDELETE_VERIFIED" ? { ...r, evidence: null } : r)), EXPECTED, FILE) === null);
  check("J: a FAILED record alongside a confirmation is refused",
    validateDeletionEvidence([...seq(), { sourcePath: SRC, status: "FAILED", batchId: BATCH }], EXPECTED, FILE) === null);
  check("J: a REFUSED record alongside a confirmation is refused",
    validateDeletionEvidence([...seq(), { sourcePath: SRC, status: "REFUSED", batchId: BATCH }], EXPECTED, FILE) === null);
  check("J: a duplicated confirmation is an inconsistency, not reassurance",
    validateDeletionEvidence([...seq(), seq()[2]], EXPECTED, FILE) === null);
  check("J: a duplicated verification is refused",
    validateDeletionEvidence([...seq(), seq()[0]], EXPECTED, FILE) === null);
  check("J: a missing confirmation timestamp is refused",
    validateDeletionEvidence(
      seq().map((r) => (r.status === "DELETE_CONFIRMED" ? { ...r, timestamp: undefined } : r)), EXPECTED, FILE) === null);
  check("J: garbage in the record array is refused",
    validateDeletionEvidence([null as never, 42 as never, "x" as never], EXPECTED, FILE) === null);
  check("J: a blank ledger filename is refused",
    validateDeletionEvidence(seq(), EXPECTED, "") === null);
  check("J: it never throws on hostile input", (() => {
    for (const bad of [[{}], [{ status: "DELETE_CONFIRMED" }], [{ sourcePath: SRC }], seq({ evidence: { sourceBytes: "20" } })]) {
      try { validateDeletionEvidence(bad as RawLedgerRecord[], EXPECTED, FILE); } catch { return false; }
    }
    return true;
  })());

  console.log("\n=== ledger files are read by name, defensively ===");
  check("the real batch-1 ledger name is accepted", isDeletionLedgerName(FILE));
  check("a C2 execution ledger is NOT a deletion ledger",
    !isDeletionLedgerName("executed-c2-batch-5-2026-08-22T10-40-15-082Z.ndjson"));
  check("a manifest is not a ledger", !isDeletionLedgerName("manifest-c3-delete-1.json"));
  check("traversal is refused", !isDeletionLedgerName("../deleted-x.ndjson"));
  check("a separator is refused", !isDeletionLedgerName("sub/deleted-x.ndjson"));
  check("a backslash is refused", !isDeletionLedgerName("deleted-x\\y.ndjson"));
  check("a non-ndjson file is refused", !isDeletionLedgerName("deleted-x.json"));
  check("an empty name is refused", !isDeletionLedgerName(""));
  check("the planner only reads names that pass", strip(plan).includes("if (!isDeletionLedgerName(file)) continue;"));
  check("the planner parses every line in a try/catch", (strip(plan).match(/catch \{/g) ?? []).length >= 2);
  check("the planner never writes a ledger",
    !/appendFileSync|writeFileSync\([^)]*deleted-/.test(strip(plan)));

  console.log("\n=== K-M. C3_DELETED is terminal and worth nothing ===");
  const deleted = classifyForDeletion({ ...ABSENT, deletionEvidence: good });
  check("K: C3_DELETED is not eligible", !isEligible(deleted.state));
  check("K: only C3_DELETE_ELIGIBLE is ever eligible",
    isEligible("C3_DELETE_ELIGIBLE") && !isEligible("C3_DELETED") && !isEligible("C3_MANUAL_REVIEW"));
  check("K: the manifest is built from eligible only, so C3_DELETED cannot enter it",
    strip(plan).includes("const eligible = verdicts.filter((v) => isEligible(v.state))") &&
    strip(plan).includes("const chosen = eligible.slice(0, MAX_DELETION_BATCH)"));
  check("L: reclaimable bytes are summed over eligible, not over deleted",
    strip(plan).includes("const eligibleBytes = eligible.reduce((s, v) => s + v.pairing.sourceBytes, 0)"));
  check("L: already-reclaimed bytes are reported separately",
    strip(plan).includes("already reclaimed by C3"));
  check("M: a present, unreferenced original is still eligible",
    classifyForDeletion({ ...ABSENT, sourceExists: true, deletionEvidence: null }).state === "C3_DELETE_ELIGIBLE");
  check("M: evidence does not make a PRESENT original deleted",
    classifyForDeletion({ ...ABSENT, sourceExists: true, deletionEvidence: good }).state === "C3_DELETE_ELIGIBLE");

  console.log("\n=== N-P. nothing else moved ===");
  check("N: a cart still blocks, evidence or not",
    classifyForDeletion({ ...ABSENT, sourceExists: true, deletionEvidence: good,
      liveReferencesOnSource: [{ table: "carts", rowId: "ef0e4800-31cf-4c91-81c5-2c12b63674f3", field: "items" }] })
      .state === "C3_BLOCKED_CART");
  check("N: a live product reference still blocks",
    classifyForDeletion({ ...ABSENT, sourceExists: true, deletionEvidence: good,
      liveReferencesOnSource: [{ table: "product_images", rowId: "i", field: "url" }] })
      .state === "C3_BLOCKED_LIVE_REFERENCE");
  check("O: HEIC is still out of scope",
    classifyForDeletion({ ...ABSENT, sourceExists: true, sourceFormat: "HEIF" }).state === "C3_MANUAL_REVIEW");
  check("O: a non-C2 source is still out of scope",
    classifyForDeletion({ ...ABSENT, sourceExists: true, ledgerVerified: false }).state === "C3_MANUAL_REVIEW");
  check("O: an incomplete graph still outranks everything",
    classifyForDeletion({ ...ABSENT, graphIsComplete: false, deletionEvidence: good }).state === "C3_BLOCKED_GRAPH_INCOMPLETE");
  check("P: the planner still has no deletion path",
    !/\.remove\(|\.delete\(|method:\s*["'`]DELETE["'`]/.test(strip(plan)));
  check("P: the rules module still has no deletion path",
    !/\.remove\(|\.delete\(|method:\s*["'`]DELETE["'`]/.test(strip(rules)));
  check("P: no --execute reached the planner", !/--execute/.test(strip(plan)));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
