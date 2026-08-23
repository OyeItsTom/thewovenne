/**
 * C7 — reclaiming the originals C6 migrated.
 *
 * C6 made a smaller master, moved every reference to it, and KEPT the original.
 * That retention is what made C6 reversible, and it is also why the bucket grew
 * instead of shrinking. C7 is the other half: it removes originals whose
 * migration has been proven and reviewed, and nothing else.
 *
 * WHY NOT C3. C3 reclaims C2's originals and reads C2's ledgers to decide. Its
 * evidence rules are written against C2 records — a different ledger shape, a
 * different manifest kind, a different acknowledgement. Pointing it at C6 would
 * mean loosening those rules until they matched both, which is how a deletion
 * tool learns to accept evidence it should refuse. So the *judgement* is new
 * and narrow, while the *primitives that stand between a path and a delete* are
 * C3's, unchanged and shared: assertSafeToDeletePath, looksLikeMaster, the
 * batch ceiling, the three-status ledger sequence.
 *
 * EVERYTHING HERE IS A REASON TO SAY NO. The question is never "does this look
 * like it was migrated" but "can this exact object's migration be proven right
 * now, against live data, and has a person approved that batch". Anything that
 * cannot be proven is not eligible, and an original that is missing for a
 * reason this cannot explain is a surprise for a human, not a completed job.
 */
import { MigrationRefused, assertValidBatchId } from "./imageBackfill";
import { assertSafeToDeletePath, looksLikeMaster, type LiveReferenceIdentity } from "./imageDeletion";
import { NORMALIZER_VERSION } from "./imageNormalize";

/* ──────────────────────────── classification ───────────────────────────── */

export const C7_STATES = [
  "C7_RECLAIM_ELIGIBLE",
  "C7_BLOCKED_NO_MIGRATION_EVIDENCE",
  "C7_BLOCKED_BATCH_NOT_APPROVED",
  "C7_BLOCKED_SOURCE_ABSENT",
  "C7_BLOCKED_SOURCE_CHANGED",
  "C7_BLOCKED_LIVE_REFERENCE",
  "C7_BLOCKED_CART",
  "C7_BLOCKED_SITE_CONTENT",
  "C7_BLOCKED_UNKNOWN_REFERENCE",
  "C7_BLOCKED_GRAPH_INCOMPLETE",
  "C7_BLOCKED_MASTER_MISSING",
  "C7_BLOCKED_MASTER_UNREADABLE",
  "C7_BLOCKED_MASTER_CHANGED",
  "C7_BLOCKED_MASTER_UNREFERENCED",
  "C7_BLOCKED_VERSION_MISMATCH",
  "C7_BLOCKED_OUT_OF_SCOPE",
  "C7_MANUAL_REVIEW",
] as const;

export type C7State = (typeof C7_STATES)[number];

export function isC7Eligible(state: C7State): boolean {
  return state === "C7_RECLAIM_ELIGIBLE";
}

/**
 * What one C6 ledger line has to say before it counts as proof of migration.
 *
 * This is deliberately the MIGRATED record's own fields rather than a summary:
 * the executor re-derives bytes and digest from live storage and compares them
 * to these, so a ledger that disagrees with the object stops the run.
 */
export interface C6MigrationEvidence {
  sourcePath: string;
  sourceBytes: number;
  sourceChecksum: string;
  sourceDimensions: string | null;
  masterPath: string;
  masterBytes: number;
  masterDimensions: string | null;
  normalizerVersion: number;
  batchId: string;
  /** Basename of the append-only C6 ledger this came from. */
  ledgerFile: string;
}

export interface C7Candidate {
  /** Storage key of the ORIGINAL being considered for reclaim. */
  sourcePath: string;
  sourceUrl: string;
  /** Live bytes, read now — not what the ledger remembers. */
  sourceBytes: number;
  sourceChecksum: string | null;
  sourceExists: boolean;

  /** The C6 MIGRATED record, or null when none could be proven. */
  evidence: C6MigrationEvidence | null;
  /** Has a person signed off the batch this original was migrated in? */
  batchApproved: boolean;

  masterExists: boolean;
  masterReadable: boolean;
  /** Live master bytes and display dimensions, read now. */
  masterBytes: number | null;
  masterDimensions: string | null;
  /** Live references pointing AT THE MASTER. At least one, or the move is undone. */
  masterLiveReferences: LiveReferenceIdentity[];

  graphIsComplete: boolean;
  /** Fresh live references still pointing at the ORIGINAL. Any at all blocks. */
  liveReferencesOnSource: LiveReferenceIdentity[];
  cartReferencesOnSource: LiveReferenceIdentity[];
  siteContentReferencesOnSource: LiveReferenceIdentity[];
  /** References the graph could not classify. Any at all means stop. */
  unknownReferencesOnSource: number;
  /** Audit-log style references. Recorded, never blocking. */
  historicalReferencesOnSource: number;

  expectedNormalizerVersion: number;
}

export interface C7Verdict {
  state: C7State;
  reason: string;
  blockers: LiveReferenceIdentity[];
}

/**
 * The order of these checks is the order in which they are cheapest to explain,
 * not the order in which they are cheapest to run. Someone reading a refusal
 * should get the most fundamental reason, so scope and evidence come before
 * anything about references.
 */
export function classifyForC7(c: C7Candidate): C7Verdict {
  const no = (state: C7State, reason: string, blockers: LiveReferenceIdentity[] = []): C7Verdict =>
    ({ state, reason, blockers });

  // Scope, first and independently of everything else. A master, a HEIC, a
  // prefix or a path outside products/ is not a thing C7 may consider at all.
  try {
    assertSafeToDeletePath(c.sourcePath, c.evidence?.masterPath ?? "");
  } catch (error) {
    return no("C7_BLOCKED_OUT_OF_SCOPE",
      error instanceof MigrationRefused ? error.message : "out of scope");
  }

  if (!c.evidence) {
    return no("C7_BLOCKED_NO_MIGRATION_EVIDENCE",
      "no complete C6 MIGRATED record proves this original was migrated");
  }
  if (c.evidence.sourcePath !== c.sourcePath) {
    return no("C7_BLOCKED_NO_MIGRATION_EVIDENCE",
      `the evidence describes ${c.evidence.sourcePath}, not ${c.sourcePath}`);
  }
  if (looksLikeMaster(c.evidence.masterPath) === false) {
    // A C6 master is content-addressed and version-suffixed. Anything else in
    // that field means the pairing is not the one C6 records.
    return no("C7_BLOCKED_NO_MIGRATION_EVIDENCE",
      `${c.evidence.masterPath} is not a normalised master path`);
  }
  if (c.evidence.masterPath === c.sourcePath) {
    return no("C7_BLOCKED_OUT_OF_SCOPE",
      "the evidence pairs this original with itself");
  }
  if (!c.batchApproved) {
    return no("C7_BLOCKED_BATCH_NOT_APPROVED",
      `batch ${c.evidence.batchId} has not been recorded as owner-approved`);
  }

  if (!c.graphIsComplete) {
    return no("C7_BLOCKED_GRAPH_INCOMPLETE",
      "the reference graph is incomplete, so 'nothing points at this' cannot be claimed");
  }

  if (!c.sourceExists) {
    // Absent for an unexplained reason is a person's problem, not a success.
    return no("C7_BLOCKED_SOURCE_ABSENT",
      "the original is already gone; C7 did not remove it and cannot say what did");
  }
  if (c.sourceChecksum === null) {
    return no("C7_BLOCKED_SOURCE_CHANGED",
      "a live SHA-256 could not be computed, so these are not provably the migrated bytes");
  }
  if (c.sourceBytes !== c.evidence.sourceBytes) {
    return no("C7_BLOCKED_SOURCE_CHANGED",
      `the original is ${c.sourceBytes} bytes; the migration recorded ${c.evidence.sourceBytes}`);
  }
  if (c.sourceChecksum !== c.evidence.sourceChecksum) {
    return no("C7_BLOCKED_SOURCE_CHANGED",
      `live checksum ${c.sourceChecksum.slice(0, 16)}… does not match the migration record`);
  }

  // References on the ORIGINAL. Carts and site_content are named separately
  // because they mean different things to a person: a cart is somebody's
  // basket rendering that exact URL, site_content is the lookbook and campaign
  // CMS. Neither is a reference C6 was ever allowed to rewrite, so either one
  // still pointing here means the photograph is still in use.
  if (c.cartReferencesOnSource.length > 0) {
    return no("C7_BLOCKED_CART",
      `${c.cartReferencesOnSource.length} cart reference(s) still point at this original`,
      c.cartReferencesOnSource);
  }
  if (c.siteContentReferencesOnSource.length > 0) {
    return no("C7_BLOCKED_SITE_CONTENT",
      `${c.siteContentReferencesOnSource.length} site_content reference(s) still point at this original`,
      c.siteContentReferencesOnSource);
  }
  if (c.liveReferencesOnSource.length > 0) {
    return no("C7_BLOCKED_LIVE_REFERENCE",
      `${c.liveReferencesOnSource.length} live reference(s) still point at this original`,
      c.liveReferencesOnSource);
  }
  if (c.unknownReferencesOnSource > 0) {
    return no("C7_BLOCKED_UNKNOWN_REFERENCE",
      `${c.unknownReferencesOnSource} reference(s) could not be classified; C7 will not guess`);
  }

  // The master has to be there, readable, and the one the migration recorded —
  // otherwise deleting the original removes the only remaining copy.
  if (!c.masterExists) {
    return no("C7_BLOCKED_MASTER_MISSING",
      `${c.evidence.masterPath} is not in the bucket; the original is the only copy left`);
  }
  if (!c.masterReadable) {
    return no("C7_BLOCKED_MASTER_UNREADABLE",
      `${c.evidence.masterPath} could not be read back`);
  }
  if (c.masterBytes !== c.evidence.masterBytes) {
    return no("C7_BLOCKED_MASTER_CHANGED",
      `the master is ${c.masterBytes} bytes; the migration recorded ${c.evidence.masterBytes}`);
  }
  if (c.evidence.masterDimensions !== null && c.masterDimensions !== c.evidence.masterDimensions) {
    return no("C7_BLOCKED_MASTER_CHANGED",
      `the master is ${c.masterDimensions}; the migration recorded ${c.evidence.masterDimensions}`);
  }
  if (c.evidence.normalizerVersion !== c.expectedNormalizerVersion) {
    return no("C7_BLOCKED_VERSION_MISMATCH",
      `the master was made by normalizer v${c.evidence.normalizerVersion}, this build expects v${c.expectedNormalizerVersion}`);
  }
  if (c.masterLiveReferences.length === 0) {
    // Nothing points at the replacement. Deleting the original here would
    // leave the photograph reachable from nowhere.
    return no("C7_BLOCKED_MASTER_UNREFERENCED",
      "no live reference points at the master, so the migration is not actually in effect");
  }

  return {
    state: "C7_RECLAIM_ELIGIBLE",
    reason: `migrated in ${c.evidence.batchId}, approved, ${c.masterLiveReferences.length} live reference(s) on the master`,
    blockers: [],
  };
}

/* ───────────────────────────── the manifest ─────────────────────────────── */

export const C7_MANIFEST_KIND = "c7-reclaim" as const;
export const MAX_C7_DELETE_BATCH = 5;

export function assertC7BatchSize(count: number): void {
  if (!Number.isInteger(count) || count <= 0) {
    throw new MigrationRefused("A reclaim batch needs at least one original.", "empty_batch");
  }
  if (count > MAX_C7_DELETE_BATCH) {
    throw new MigrationRefused(
      `C7 reclaims at most ${MAX_C7_DELETE_BATCH} originals per batch; got ${count}.`,
      "batch_too_large"
    );
  }
}

export interface C7ManifestEntry {
  sourcePath: string;
  sourceBytes: number;
  sourceChecksum: string;
  masterPath: string;
  masterBytes: number;
  masterDimensions: string | null;
  normalizerVersion: number;
  /** The C6 batch this original was migrated in, and its ledger. */
  migratedInBatch: string;
  evidenceLedger: string;
  /** Exactly which live references must be on the master at execution time. */
  expectedMasterReferences: LiveReferenceIdentity[];
}

export interface C7Manifest {
  kind: typeof C7_MANIFEST_KIND;
  batchId: string;
  createdAt: string;
  normalizerVersion: number;
  entries: C7ManifestEntry[];
  checksum: string;
}

/**
 * The checksum covers what a reviewer actually approved: which objects, at
 * which bytes, paired with which masters. A field outside this subject can be
 * edited without invalidating the manifest, so nothing that decides a deletion
 * may live outside it.
 */
export interface C7ChecksumSubject {
  batchId: string;
  normalizerVersion: number;
  entries: C7ManifestEntry[];
}

export function c7ManifestChecksum(
  subject: C7ChecksumSubject,
  sha256: (input: string) => string
): string {
  const canonical = JSON.stringify({
    batchId: subject.batchId,
    normalizerVersion: subject.normalizerVersion,
    entries: subject.entries.map((e) => ({
      sourcePath: e.sourcePath,
      sourceBytes: e.sourceBytes,
      sourceChecksum: e.sourceChecksum,
      masterPath: e.masterPath,
      masterBytes: e.masterBytes,
      masterDimensions: e.masterDimensions,
      normalizerVersion: e.normalizerVersion,
      migratedInBatch: e.migratedInBatch,
      evidenceLedger: e.evidenceLedger,
      expectedMasterReferences: e.expectedMasterReferences
        .map((r) => `${r.table}/${r.rowId}/${r.field}`)
        .sort(),
    })),
  });
  return sha256(canonical);
}

/**
 * Structural checks a manifest must pass before its checksum is even worth
 * computing. A plan that contradicts itself is not made trustworthy by being
 * faithfully hashed.
 */
export function assertCoherentC7Manifest(manifest: C7Manifest): void {
  const refuse = (message: string) => {
    throw new MigrationRefused(message, "incoherent_manifest");
  };
  if (manifest.kind !== C7_MANIFEST_KIND) {
    refuse(`manifest kind is "${manifest.kind}", not "${C7_MANIFEST_KIND}"`);
  }
  assertValidBatchId(manifest.batchId);
  assertC7BatchSize(manifest.entries.length);

  const seenSources = new Set<string>();
  for (const e of manifest.entries) {
    // The path guard again, here, so an entry can never reach the executor
    // holding something this rejects.
    assertSafeToDeletePath(e.sourcePath, e.masterPath);
    if (seenSources.has(e.sourcePath)) {
      refuse(`${e.sourcePath} appears twice; one object is deleted once`);
    }
    seenSources.add(e.sourcePath);
    if (!/^[0-9a-f]{64}$/.test(e.sourceChecksum)) {
      refuse(`${e.sourcePath} has no usable SHA-256`);
    }
    if (!Number.isInteger(e.sourceBytes) || e.sourceBytes <= 0) {
      refuse(`${e.sourcePath} has a nonsense byte count`);
    }
    if (!looksLikeMaster(e.masterPath)) {
      refuse(`${e.masterPath} is not a normalised master path`);
    }
    if (e.expectedMasterReferences.length === 0) {
      refuse(`${e.sourcePath} names no reference on its master; the migration would not be in effect`);
    }
    if (e.normalizerVersion !== manifest.normalizerVersion) {
      refuse(`${e.sourcePath} was normalized by v${e.normalizerVersion}, manifest says v${manifest.normalizerVersion}`);
    }
  }

  // A master that is also queued for deletion would be catastrophic: the
  // original goes, and then so does the thing that replaced it.
  const masters = new Set(manifest.entries.map((e) => e.masterPath));
  for (const source of seenSources) {
    if (masters.has(source)) {
      refuse(`${source} is both an original to delete and a master to keep`);
    }
  }
}

/* ─────────────────────── the reclaim command line ───────────────────────── */

/**
 * C7's own acknowledgement, sharing no wording with any other tool's.
 *
 * C6's says originals are retained, which is the opposite of what this does.
 * C3's and C5's belong to different scopes with different evidence rules. A
 * half-remembered command line from any of them must produce an error here,
 * never a deletion, so each one is refused by name.
 */
export const C7_FLAGS = {
  execute: "--execute",
  batchId: "--batch-id",
  manifest: "--source-manifest",
  acknowledgement: "--yes-i-understand-this-permanently-removes-migrated-originals",
} as const;

const FOREIGN_ACKNOWLEDGEMENTS = [
  "--yes-i-understand-originals-are-retained",          // C2 and C6: retain
  "--yes-i-understand-original-deletion-is-permanent",  // C3
  "--yes-i-understand-the-duplicate-is-the-only-other-copy", // C5
];

export function assertC7Flags(argv: string[]): { batchId: string; manifestPath: string } {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (!has(C7_FLAGS.execute)) {
    throw new MigrationRefused("Not an execution run.", "not_execute");
  }
  if (!has(C7_FLAGS.acknowledgement)) {
    throw new MigrationRefused(
      `This reclaim needs ${C7_FLAGS.acknowledgement}.`, "missing_acknowledgement");
  }
  for (const foreign of FOREIGN_ACKNOWLEDGEMENTS) {
    if (has(foreign)) {
      throw new MigrationRefused(
        `${foreign} belongs to another tool with different evidence rules. C7 will not run alongside it.`,
        "wrong_acknowledgement");
    }
  }
  const batchId = valueOf(C7_FLAGS.batchId);
  const manifestPath = valueOf(C7_FLAGS.manifest);
  if (!batchId) throw new MigrationRefused(`${C7_FLAGS.batchId} is required.`, "missing_batch_id");
  if (!manifestPath) throw new MigrationRefused(`${C7_FLAGS.manifest} is required.`, "missing_manifest");
  return { batchId: assertValidBatchId(batchId), manifestPath };
}

/* ────────────────────────── C6 evidence reading ─────────────────────────── */

/** One line of a C6 ledger, before anything has been proven about it. */
export interface RawC6Record {
  status?: unknown;
  sourcePath?: unknown;
  masterPath?: unknown;
  batchId?: unknown;
  [k: string]: unknown;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/**
 * Decide whether C6's ledgers prove this exact original was migrated.
 *
 * Not "does the path appear" — a path appears the moment a run considers it —
 * but "did one complete, self-consistent run migrate this object and retain
 * it". A REFUSED, FAILED or ROLLED_BACK record anywhere for this source
 * disqualifies it outright: a rolled-back migration means the references went
 * back to the original, and deleting it would break them.
 *
 * Returns null when the evidence does not hold. Never throws on bad input,
 * because malformed records are simply not proof.
 */
export function readC6MigrationEvidence(
  records: RawC6Record[],
  sourcePath: string,
  ledgerFile: string
): C6MigrationEvidence | null {
  if (!Array.isArray(records) || records.length === 0) return null;
  if (!isStr(ledgerFile) || !isStr(sourcePath)) return null;

  const wellFormed = records.filter(
    (r): r is RawC6Record => typeof r === "object" && r !== null && !Array.isArray(r));
  const mine = wellFormed.filter((r) => r.sourcePath === sourcePath);
  if (mine.length === 0) return null;

  // Any negative outcome for this source, ever, is disqualifying.
  if (mine.some((r) => r.status === "REFUSED" || r.status === "FAILED" || r.status === "ROLLED_BACK")) {
    return null;
  }

  const migrated = mine.filter((r) => r.status === "MIGRATED" || r.status === "MASTER_REUSED");
  if (migrated.length !== 1) return null; // zero is no proof; more than one is ambiguous
  const r = migrated[0];

  if (r.originalRetained !== true) return null;
  if (!isStr(r.masterPath) || !isStr(r.batchId)) return null;
  if (!isSha(r.sourceChecksum)) return null;
  if (!isPosInt(r.sourceBytes) || !isPosInt(r.masterBytes)) return null;
  if (!Number.isInteger(r.normalizerVersion)) return null;
  if (r.masterPath === sourcePath) return null;
  if (!looksLikeMaster(r.masterPath as string)) return null;

  return {
    sourcePath,
    sourceBytes: r.sourceBytes as number,
    sourceChecksum: r.sourceChecksum as string,
    sourceDimensions: isStr(r.sourceDimensions) ? (r.sourceDimensions as string) : null,
    masterPath: r.masterPath as string,
    masterBytes: r.masterBytes as number,
    masterDimensions: isStr(r.masterDimensions) ? (r.masterDimensions as string) : null,
    normalizerVersion: r.normalizerVersion as number,
    batchId: r.batchId as string,
    ledgerFile,
  };
}

/**
 * A reference that was moved back to the original after migration cancels the
 * evidence for it.
 *
 * C6 kept an append-only revert log, so a source that was migrated, reverted
 * and never re-applied still has a MIGRATED line. Reading that line alone
 * would authorise deleting an original that production is serving right now.
 * The live reference check would also catch it — this is the second lock.
 */
export function isRevertedWithoutReapply(
  reverts: Array<{ action?: unknown; sourcePath?: unknown; timestamp?: unknown }>,
  sourcePath: string
): boolean {
  const mine = (Array.isArray(reverts) ? reverts : [])
    .filter((r) => r && typeof r === "object" && r.sourcePath === sourcePath
      && (r.action === "C6_REVERT" || r.action === "C6_REAPPLY"))
    .slice()
    .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  if (mine.length === 0) return false;
  return mine[mine.length - 1].action === "C6_REVERT";
}

export const C7_EXPECTED_NORMALIZER_VERSION = NORMALIZER_VERSION;
