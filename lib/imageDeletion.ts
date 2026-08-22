/**
 * C3 — deciding which retained originals may eventually be deleted.
 *
 * THIS FILE DELETES NOTHING, AND NEITHER DOES ANYTHING THAT IMPORTS IT.
 * There is no execution path in this PR: the planner that uses these rules
 * reads production and writes a local manifest, and that is all. Deletion is a
 * later, separately approved change. The point of landing the rules first is
 * that "may this be deleted" is the question worth getting wrong on paper
 * rather than against a bucket.
 *
 * C2 moved live references from an original to a normalised master and KEPT
 * the original. After 35 sources that retention is the whole storage story:
 * the bucket holds both copies of everything. C3 is how that ends — but only
 * for originals where every one of the conditions below is proven from fresh
 * live data. Every branch here is a refusal. There is no branch that says yes
 * to something uncertain, and the default for anything unrecognised is to keep
 * the file.
 *
 * The asymmetry is deliberate: keeping a file nobody needs costs storage, and
 * deleting a file somebody still renders costs a photograph that does not
 * exist anywhere else. Those are not comparable mistakes.
 */
import { MigrationRefused, assertValidBatchId, isRetainedReferenceTable } from "./imageBackfill";

/* ─────────────────────────────── classification ─────────────────────────── */

export const C3_STATES = [
  "C3_DELETE_ELIGIBLE",
  "C3_BLOCKED_CART",
  "C3_BLOCKED_LIVE_REFERENCE",
  "C3_BLOCKED_MASTER_MISSING",
  "C3_BLOCKED_MASTER_UNREADABLE",
  "C3_BLOCKED_MASTER_UNREFERENCED",
  "C3_BLOCKED_GRAPH_INCOMPLETE",
  "C3_BLOCKED_VERSION_MISMATCH",
  "C3_BLOCKED_IS_MASTER",
  "C3_MANUAL_REVIEW",
] as const;

export type C3State = (typeof C3_STATES)[number];

export function isEligible(state: C3State): boolean {
  return state === "C3_DELETE_ELIGIBLE";
}

/** A live reference, named precisely enough to be acted on by a person. */
export interface LiveReferenceIdentity {
  table: string;
  rowId: string;
  field: string;
}

export interface DeletionCandidate {
  /** Storage key of the ORIGINAL being considered for deletion. */
  sourcePath: string;
  sourceUrl: string;
  sourceBytes: number;
  /** Does the original still exist in the bucket? */
  sourceExists: boolean;
  /** Format as profiled at C2 time; "HEIF" is out of scope. */
  sourceFormat: string | null;

  /** The master C2 said it created. Null when the ledger has no pairing. */
  masterPath: string | null;
  masterUrl: string | null;
  masterExists: boolean;
  masterReadable: boolean;
  /** Normalizer version recorded for the master, and the one this build expects. */
  masterNormalizerVersion: number | null;
  expectedNormalizerVersion: number;
  /** Live references now pointing AT THE MASTER. Must be at least one. */
  masterLiveReferences: number;

  /**
   * Proof this original went through C2 successfully — a ledger row with
   * status "migrated" and verification "passed". Without it, this is not a
   * C2 original and C3 has no business touching it.
   */
  ledgerVerified: boolean;

  graphIsComplete: boolean;
  /** Fresh live references still pointing at the ORIGINAL. */
  liveReferencesOnSource: LiveReferenceIdentity[];
  /** Audit-log style references. Recorded, never counted as live. */
  historicalReferencesOnSource: number;
  /** References the graph could not classify. Any at all means stop. */
  unknownReferencesOnSource: number;
}

export interface C3Verdict {
  state: C3State;
  reason: string;
  /** The exact references standing in the way, when that is the reason. */
  blockers: LiveReferenceIdentity[];
}

/**
 * Whether a storage object looks like a normalised master rather than an
 * original.
 *
 * C3 deletes originals. A master is the thing references were moved TO, so
 * deleting one would undo the migration that justified the deletion. The
 * naming is content-addressed and version-suffixed by masterKey(), which makes
 * this cheap to recognise, and worth recognising even though nothing should
 * ever propose a master as a candidate.
 */
export function looksLikeMaster(path: string): boolean {
  return /-v\d+\.(jpg|webp|png)$/i.test(path);
}

/**
 * The whole decision, in one place, in refusal order.
 *
 * Ordering matters for the message more than the outcome: a cart-held original
 * is also "has a live reference", but saying CART names the thing an operator
 * has to reason about. Structural problems come first, because an incomplete
 * graph makes every later answer meaningless.
 */
export function classifyForDeletion(c: DeletionCandidate): C3Verdict {
  const no = (state: C3State, reason: string, blockers: LiveReferenceIdentity[] = []): C3Verdict =>
    ({ state, reason, blockers });

  // ── structural: can we trust any answer at all? ──
  if (!c.graphIsComplete) {
    return no("C3_BLOCKED_GRAPH_INCOMPLETE",
      "the reference graph is incomplete — cannot prove what still points here");
  }

  // ── identity: is this even a C2 original? ──
  if (looksLikeMaster(c.sourcePath)) {
    return no("C3_BLOCKED_IS_MASTER",
      "this object is a normalised master, not an original — C3 never deletes masters");
  }
  if (!c.ledgerVerified) {
    return no("C3_MANUAL_REVIEW",
      "no verified C2 ledger row pairs this original with a master — not a proven C2 source");
  }
  if (c.sourceFormat === "HEIF") {
    return no("C3_MANUAL_REVIEW", "HEIC/HEIF is out of scope for this tooling");
  }
  if (!c.sourceExists) {
    return no("C3_MANUAL_REVIEW",
      "the original is no longer in the bucket — something outside this tooling removed it");
  }

  // ── the replacement must be real, readable and current ──
  if (!c.masterPath || !c.masterUrl || !c.masterExists) {
    return no("C3_BLOCKED_MASTER_MISSING", "the normalised master is absent from the bucket");
  }
  if (!c.masterReadable) {
    return no("C3_BLOCKED_MASTER_UNREADABLE", "the normalised master could not be read back over HTTP");
  }
  if (c.masterNormalizerVersion !== c.expectedNormalizerVersion) {
    return no("C3_BLOCKED_VERSION_MISMATCH",
      `master was written by normalizer v${c.masterNormalizerVersion}, this build expects v${c.expectedNormalizerVersion}`);
  }
  if (c.masterLiveReferences < 1) {
    return no("C3_BLOCKED_MASTER_UNREFERENCED",
      "nothing live points at the master — deleting the original would strand the photograph");
  }

  // ── the original itself must be genuinely unused ──
  const carts = c.liveReferencesOnSource.filter((r) => isRetainedReferenceTable(r.table));
  if (carts.length > 0) {
    return no("C3_BLOCKED_CART",
      `${carts.length} cart reference(s) still point at the original; a basket renders this URL verbatim`,
      carts);
  }
  if (c.liveReferencesOnSource.length > 0) {
    return no("C3_BLOCKED_LIVE_REFERENCE",
      `${c.liveReferencesOnSource.length} live reference(s) still point at the original`,
      c.liveReferencesOnSource);
  }
  if (c.unknownReferencesOnSource > 0) {
    return no("C3_MANUAL_REVIEW",
      `${c.unknownReferencesOnSource} reference(s) could not be classified`);
  }

  // Historical (audit-log) references are recorded but do not block; see the
  // note on HISTORICAL_REFERENCES_DECISION below.
  return {
    state: "C3_DELETE_ELIGIBLE",
    reason: c.historicalReferencesOnSource > 0
      ? `no live references; ${c.historicalReferencesOnSource} historical audit mention(s), which render as text`
      : "no live references; master verified and referenced",
    blockers: [],
  };
}

/**
 * Why an admin_audit_log mention does not protect an original.
 *
 * The audit log stores `changes` as jsonb — for an update, `{col: {from, to}}`
 * — so when C2 repointed `products.image_url` the trigger recorded both the
 * old original URL and the new master URL as TEXT. components/admin/AuditLog.tsx
 * renders those values through format(), which returns a string truncated to
 * 120 characters and prints it in a <dd>. It never builds an <img>, never a
 * link, and never fetches the object. Deleting the storage object therefore
 * changes nothing an admin sees: the entry still reads the same.
 *
 * The decisive argument is self-reference. C2's own writes are audited, so
 * every original whose `products.image_url` or `product_versions.image_url` it
 * rewrote now appears in the audit log BECAUSE C2 migrated it — 6 of the 35
 * migrated sources, all of them covers, at the time of writing. If a
 * historical mention blocked deletion, C2 would permanently protect exactly
 * the originals it had just made redundant, and C3 could never reclaim a
 * cover. A rule that is disarmed by the migration it exists to follow is not a
 * safety rule.
 *
 * So: recorded in the manifest, surfaced in the report, never a blocker.
 */
export const HISTORICAL_REFERENCES_DECISION = "recorded, not blocking" as const;

/* ──────────────────────────── the deletion manifest ─────────────────────── */

export interface DeletionManifestEntry {
  sourcePath: string;
  sourceBytes: number;
  /**
   * SHA-256 of the original's bytes, as recorded by C2 at migration time.
   *
   * This is what makes deletion provably about the right photograph. Path and
   * byte length can coincide; the digest cannot. The executor re-downloads the
   * object and recomputes this immediately before deleting, so a source that
   * was replaced in place since the plan cannot be mistaken for the one that
   * was migrated and reviewed.
   */
  sourceChecksum: string;
  masterPath: string;
  /**
   * The reference state this plan was made against, so that a later execution
   * can prove the world has not moved. Sorted, so ordering is deterministic.
   */
  expectedLiveReferencesOnSource: number;
  expectedLiveReferencesOnMaster: number;
  historicalReferencesOnSource: number;
}

/**
 * Tags the fingerprint so a C3 manifest can never be mistaken for a C2 one.
 *
 * The two have different entry shapes and wildly different consequences; a
 * checksum collision across the kinds would be a bad way to find that out.
 */
export const MANIFEST_KIND = "c3-delete" as const;
export const MANIFEST_VERSION = 2;

export interface DeletionManifest {
  kind: typeof MANIFEST_KIND;
  batchId: string;
  createdAt: string;
  normalizerVersion: number;
  /** Present and always false in this PR. There is no execution path. */
  executable: false;
  entries: DeletionManifestEntry[];
  checksum: string;
}

export interface DeletionChecksumSubject {
  batchId: string;
  normalizerVersion: number;
  entries: DeletionManifestEntry[];
}

/**
 * A fingerprint of exactly what was reviewed, on the C2 model.
 *
 * Covers batch identity, normalizer version, and for every entry: the original,
 * its byte size, the master it is paired with, and the reference counts that
 * made it eligible. Changing any of those changes the checksum. Ordering is
 * canonicalised by sourcePath so two plans over the same facts agree.
 *
 * `createdAt` is excluded for the same reason as in C2: when the plan ran is
 * not an input to what the plan says.
 */
export function deletionManifestChecksum(
  subject: DeletionChecksumSubject,
  hash: (input: string) => string
): string {
  const entries = subject.entries
    .map((e) => ({
      sourcePath: e.sourcePath,
      sourceBytes: e.sourceBytes,
      sourceChecksum: e.sourceChecksum,
      masterPath: e.masterPath,
      expectedLiveReferencesOnSource: e.expectedLiveReferencesOnSource,
      expectedLiveReferencesOnMaster: e.expectedLiveReferencesOnMaster,
      historicalReferencesOnSource: e.historicalReferencesOnSource,
    }))
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return hash(JSON.stringify({ version: MANIFEST_VERSION, kind: MANIFEST_KIND, batchId: subject.batchId,
    normalizerVersion: subject.normalizerVersion, entries }));
}

/**
 * How many originals one C3 batch may ever propose.
 *
 * Smaller than the C2 ceiling on purpose. C2 is reversible by pointing rows
 * back; C3 is not reversible by anything, so the first batches should be
 * small enough that a mistake is a nuisance rather than an incident.
 */
export const MAX_DELETION_BATCH = 5;

export function assertDeletionBatchSize(count: number): void {
  if (!Number.isInteger(count) || count <= 0) {
    throw new MigrationRefused("A deletion batch needs at least one source.", "empty_batch");
  }
  if (count > MAX_DELETION_BATCH) {
    throw new MigrationRefused(
      `C3 proposes at most ${MAX_DELETION_BATCH} originals per batch; got ${count}.`,
      "batch_too_large"
    );
  }
}

/* ────────────────────────── executor-side guards ────────────────────────── */

/**
 * The flags a C3 run must carry. Absent any one of them, nothing happens.
 *
 * The acknowledgement is deliberately NOT C2's. C2's says originals are
 * retained, which is the opposite of what this does; reusing it would let a
 * command line that means "keep the photograph" delete it. Muscle memory from
 * five C2 batches is a real hazard, so the two strings share no prefix beyond
 * the flag convention itself.
 */
export const DELETE_FLAGS = {
  execute: "--execute",
  batchId: "--batch-id",
  manifest: "--source-manifest",
  acknowledgement: "--yes-i-understand-original-deletion-is-permanent",
} as const;

export function assertDeleteFlags(argv: string[]): { batchId: string; manifestPath: string } {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (!has(DELETE_FLAGS.execute)) {
    throw new MigrationRefused("Not an execution run.", "not_execute");
  }
  if (!has(DELETE_FLAGS.acknowledgement)) {
    throw new MigrationRefused(
      `Deletion also needs ${DELETE_FLAGS.acknowledgement}.`,
      "missing_acknowledgement"
    );
  }
  // C2's acknowledgement must not work here, even alongside the right one:
  // its presence means somebody is running a half-remembered C2 command.
  if (has("--yes-i-understand-originals-are-retained")) {
    throw new MigrationRefused(
      "That is the C2 acknowledgement, and C2 retains originals. C3 deletes them.",
      "wrong_acknowledgement"
    );
  }
  const batchId = valueOf(DELETE_FLAGS.batchId);
  const manifestPath = valueOf(DELETE_FLAGS.manifest);
  if (!batchId) throw new MigrationRefused(`${DELETE_FLAGS.batchId} is required.`, "missing_batch_id");
  if (!manifestPath) {
    throw new MigrationRefused(`${DELETE_FLAGS.manifest} is required.`, "missing_manifest");
  }
  return { batchId: assertValidBatchId(batchId), manifestPath };
}

/**
 * The last thing standing between a path and `.remove()`.
 *
 * Called immediately before the delete with the exact string that will be
 * sent. Everything it rejects is something that should already have been
 * caught upstream — which is the point: this is the check that does not depend
 * on any earlier check having run.
 */
export function assertSafeToDeletePath(sourcePath: string, masterPath: string): void {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new MigrationRefused("A deletion needs an exact source path.", "unsafe_delete_path");
  }
  if (looksLikeMaster(sourcePath)) {
    throw new MigrationRefused(
      `${sourcePath} is a normalised master. C3 deletes originals, never masters.`,
      "unsafe_delete_path"
    );
  }
  if (sourcePath === masterPath) {
    throw new MigrationRefused(
      "the source and its master are the same object — deleting it would delete the replacement",
      "unsafe_delete_path"
    );
  }
  // No prefix, no folder, no wildcard, no traversal. One object, named in full.
  if (sourcePath.endsWith("/") || sourcePath.includes("*") || sourcePath.includes("..")) {
    throw new MigrationRefused(
      `${sourcePath} is not an exact single object path.`, "unsafe_delete_path"
    );
  }
  if (!sourcePath.startsWith("products/")) {
    throw new MigrationRefused(
      `${sourcePath} is outside the products/ prefix C2 migrated from.`, "unsafe_delete_path"
    );
  }
  if (/\.(heic|heif)$/i.test(sourcePath)) {
    throw new MigrationRefused(`${sourcePath} is HEIC/HEIF, which is out of scope.`, "unsafe_delete_path");
  }
}

/** Where an object is in its deletion, recorded before and after every step. */
export type DeletionStatus =
  | "PREDELETE_VERIFIED"
  | "DELETE_REQUESTED"
  | "DELETE_CONFIRMED"
  | "ALREADY_ABSENT"
  | "REFUSED"
  | "FAILED";

/**
 * What was true immediately before the delete request was sent.
 *
 * Persisted BEFORE the request, never after. If this cannot be written, the
 * deletion does not happen — an irreversible act with no record of what it
 * removed is worse than a full bucket.
 */
export interface PreDeleteEvidence {
  timestamp: string;
  batchId: string;
  manifestChecksum: string;
  sourcePath: string;
  sourceBytes: number;
  sourceChecksum: string;
  sourceDimensions: string | null;
  masterPath: string;
  masterBytes: number | null;
  masterDimensions: string | null;
  normalizerVersion: number;
  liveReferencesOnSource: 0;
  liveReferenceIdentitiesOnMaster: LiveReferenceIdentity[];
  liveReferencesOnMaster: number;
  historicalReferencesOnSource: number;
}
