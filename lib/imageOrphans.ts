/**
 * C5 — deleting an orphan only when its photograph provably survives elsewhere.
 *
 * HOW THIS DIFFERS FROM C3, WHICH IS THE WHOLE POINT.
 *
 * C3 deleted a migrated original because C2 had built a normalised master to
 * replace it: the safety claim was "a better copy exists, and the site now
 * points at it". C5 has no master and no migration. Its candidates are files
 * an admin uploaded twice — the same photograph stored under two UUIDs, one of
 * which nothing references.
 *
 * So C5's safety claim is different in kind: "a byte-identical twin exists,
 * and something live points at the twin". That is a claim about two objects,
 * and it can rot in ways C3's could not — the twin can be deleted, replaced in
 * place, or quietly detached from every row that referenced it. A C5 plan is
 * therefore a statement about a PAIR, and the executor has to re-prove the
 * pair, not just the candidate, immediately before each delete.
 *
 * ZERO REFERENCES IS NOT A REASON TO DELETE ANYTHING. It is the reason to
 * start looking. The C4 audit found 23 unreferenced objects, and 9 of them are
 * the only surviving copy of their content — deleting those would lose a
 * photograph permanently, and nothing about "no rows point here" would have
 * warned us. Eligibility here requires an identified, live-referenced,
 * hash-identical twin, which those 9 structurally cannot have. That is the
 * safeguard: not a rule that excludes them, but a shape they cannot satisfy.
 *
 * There is no `executable` field on the manifest, and there will not be one.
 * See the note above DeletionManifest in lib/imageDeletion.ts for why a
 * self-declared boolean is worse than no boolean at all.
 */
import { MigrationRefused } from "./imageBackfill";
import { looksLikeMaster } from "./imageDeletion";

/* ─────────────────────────────── scope ─────────────────────────────────── */

/**
 * The only prefix C5 may ever consider.
 *
 * `lookbook/` and `campaigns/` are CMS media with their own lifecycle and
 * their own unanswered questions; C4 found both largely unreferenced and
 * heavily duplicated, which is a content decision, not a storage one. Keeping
 * C5 inside `products/` means a mistake in the CMS scope cannot become a
 * deletion here.
 */
export const C5_ALLOWED_PREFIX = "products/";

/** Extensions C5 refuses outright, whatever else is true about the object. */
export const C5_REFUSED_EXTENSIONS = [".heic", ".heif"] as const;

/**
 * Everything C5 will not touch, checked on the exact string that would be
 * deleted rather than on any classification carried alongside it.
 *
 * This is deliberately independent of the eligibility rules: it is the check
 * that still holds if every other check was computed from stale data.
 */
export function assertC5InScope(candidatePath: unknown, twinPath: unknown): void {
  const refuse = (message: string) =>
    new MigrationRefused(message, "c5_out_of_scope");

  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    throw refuse("C5 needs an exact candidate path.");
  }
  if (typeof twinPath !== "string" || twinPath.length === 0) {
    throw refuse("C5 needs an exact surviving-twin path.");
  }
  if (candidatePath === twinPath) {
    throw refuse("the candidate and its twin are the same object — deleting it would delete the survivor");
  }
  if (!candidatePath.startsWith(C5_ALLOWED_PREFIX)) {
    throw refuse(`${candidatePath} is outside ${C5_ALLOWED_PREFIX}, which is the only prefix C5 considers`);
  }
  if (!twinPath.startsWith(C5_ALLOWED_PREFIX)) {
    throw refuse(`the twin ${twinPath} is outside ${C5_ALLOWED_PREFIX}; C5 will not rely on a survivor it does not scope`);
  }
  if (looksLikeMaster(candidatePath)) {
    throw refuse(`${candidatePath} is a normalised master — C5 deletes duplicate uploads, never masters`);
  }
  for (const ext of C5_REFUSED_EXTENSIONS) {
    if (candidatePath.toLowerCase().endsWith(ext)) {
      throw refuse(`${candidatePath} is HEIC/HEIF, which is out of scope for this tooling`);
    }
  }
  if (candidatePath.endsWith("/") || candidatePath.includes("*") || candidatePath.includes("..")) {
    throw refuse(`${candidatePath} is not an exact single object path`);
  }
}

/* ──────────────────────────── classification ───────────────────────────── */

export const C5_STATES = [
  "C5_DELETE_ELIGIBLE",
  "C5_BLOCKED_GRAPH_INCOMPLETE",
  "C5_BLOCKED_OUT_OF_SCOPE",
  "C5_BLOCKED_CANDIDATE_ABSENT",
  "C5_BLOCKED_LIVE_REFERENCE",
  "C5_BLOCKED_AUDIT_REFERENCE",
  "C5_BLOCKED_NO_TWIN",
  "C5_BLOCKED_TWIN_ABSENT",
  "C5_BLOCKED_TWIN_UNREFERENCED",
  "C5_BLOCKED_TWIN_NOT_INDEPENDENT",
  "C5_BLOCKED_CHECKSUM_MISMATCH",
  "C5_BLOCKED_BYTES_MISMATCH",
  "C5_MANUAL_REVIEW",
] as const;
export type C5State = (typeof C5_STATES)[number];

export function isC5Eligible(state: C5State): boolean {
  return state === "C5_DELETE_ELIGIBLE";
}

export interface C5ReferenceIdentity {
  table: string;
  rowId: string;
  field: string;
}

/** The surviving copy, and the evidence that it is one. */
export interface SurvivingTwin {
  path: string;
  exists: boolean;
  bytes: number | null;
  /** SHA-256 of the twin's live bytes, recomputed — never carried from a plan. */
  checksum: string | null;
  /** Rows that currently point at the twin. Empty means it is not a survivor. */
  liveReferences: C5ReferenceIdentity[];
}

export interface OrphanCandidate {
  path: string;
  exists: boolean;
  bytes: number;
  /** SHA-256 of the candidate's live bytes. */
  checksum: string | null;
  liveReferences: C5ReferenceIdentity[];
  /**
   * Audit-log mentions. C3 decided these do not block a migrated original,
   * because C2's own writes created them. C5 is stricter and treats any audit
   * mention as a reason to stop: an object that was attached and later
   * detached has a history a person may want, and C5's entire justification is
   * that the file is a redundant duplicate nobody ever curated.
   */
  historicalReferences: number;
  twin: SurvivingTwin | null;
  graphIsComplete: boolean;
  /** True only for objects the C4 audit placed in HIGH_CONFIDENCE_ORPHAN. */
  auditedHighConfidence: boolean;
}

export interface C5Verdict {
  state: C5State;
  reason: string;
  blockers: C5ReferenceIdentity[];
}

/**
 * The whole decision, in refusal order.
 *
 * Structure first, because an incomplete graph makes every later answer
 * meaningless. Then scope, then the candidate, then the twin — the twin last
 * because its checks are the expensive ones and the only ones that need bytes.
 */
export function classifyOrphan(c: OrphanCandidate): C5Verdict {
  const no = (state: C5State, reason: string, blockers: C5ReferenceIdentity[] = []): C5Verdict =>
    ({ state, reason, blockers });

  if (!c.graphIsComplete) {
    return no("C5_BLOCKED_GRAPH_INCOMPLETE",
      "the reference graph is incomplete — cannot prove what still points here");
  }

  // Scope is a hard gate, not a classification: anything the path guard would
  // refuse is refused here too, so the two can never disagree.
  try {
    assertC5InScope(c.path, c.twin?.path ?? "products/__no_twin__");
  } catch (error) {
    if (c.twin === null) {
      return no("C5_BLOCKED_NO_TWIN",
        "no surviving twin was identified — C5 never deletes on absence of references alone");
    }
    return no("C5_BLOCKED_OUT_OF_SCOPE",
      error instanceof MigrationRefused ? error.message : "out of scope");
  }

  // The audit's own verdict is required, not advisory. An object C4 did not
  // place in HIGH_CONFIDENCE_ORPHAN cannot be reasoned into eligibility here.
  if (!c.auditedHighConfidence) {
    return no("C5_MANUAL_REVIEW",
      "not classified HIGH_CONFIDENCE_ORPHAN by the C4 audit — outside the approved scope");
  }

  if (!c.exists) {
    return no("C5_BLOCKED_CANDIDATE_ABSENT",
      "the candidate is no longer in the bucket");
  }
  if (c.liveReferences.length > 0) {
    return no("C5_BLOCKED_LIVE_REFERENCE",
      `${c.liveReferences.length} live reference(s) now point at this object`,
      c.liveReferences);
  }
  if (c.historicalReferences > 0) {
    return no("C5_BLOCKED_AUDIT_REFERENCE",
      `${c.historicalReferences} audit-log mention(s) — this object has a history, so it is not a silent duplicate`);
  }

  const twin = c.twin;
  if (!twin) {
    return no("C5_BLOCKED_NO_TWIN",
      "no surviving twin was identified — C5 never deletes on absence of references alone");
  }
  if (!twin.exists) {
    return no("C5_BLOCKED_TWIN_ABSENT",
      `the surviving twin ${twin.path} is no longer in the bucket — the photograph would be lost`);
  }
  if (twin.liveReferences.length < 1) {
    return no("C5_BLOCKED_TWIN_UNREFERENCED",
      `nothing live points at the twin ${twin.path} — deleting the candidate would strand the photograph`);
  }
  // A twin that is itself a C5 candidate is not a survivor. Without this, a
  // duplicate pair could be planned as two entries that each cite the other.
  if (twin.liveReferences.every((r) => r.table === "__candidate__")) {
    return no("C5_BLOCKED_TWIN_NOT_INDEPENDENT",
      `the twin ${twin.path} is itself a deletion candidate, so it cannot be the survivor`);
  }
  if (c.checksum === null || twin.checksum === null) {
    return no("C5_BLOCKED_CHECKSUM_MISMATCH",
      "a live SHA-256 could not be computed for the candidate or its twin");
  }
  if (c.checksum !== twin.checksum) {
    return no("C5_BLOCKED_CHECKSUM_MISMATCH",
      `candidate ${c.checksum.slice(0, 16)}… and twin ${twin.checksum.slice(0, 16)}… are different photographs`);
  }
  if (twin.bytes === null || twin.bytes !== c.bytes) {
    return no("C5_BLOCKED_BYTES_MISMATCH",
      `candidate is ${c.bytes} bytes, twin is ${twin.bytes} — identical content cannot differ in length`);
  }

  return {
    state: "C5_DELETE_ELIGIBLE",
    reason:
      `byte-identical to ${twin.path}, which carries ${twin.liveReferences.length} live reference(s); ` +
      "the photograph survives there",
    blockers: [],
  };
}

/* ──────────────────────────────── manifest ─────────────────────────────── */

/**
 * How many orphans one C5 batch may ever propose.
 *
 * The same ceiling as C3, for the same reason: deletion has no rollback, so a
 * mistake should be a nuisance rather than an incident. C5's evidence is in
 * one sense weaker than C3's — a twin is not a curated replacement, it is just
 * another upload — so there is no argument for a larger batch here.
 */
export const MAX_C5_DELETION_BATCH = 5;

export function assertC5BatchSize(count: number): void {
  if (!Number.isInteger(count) || count <= 0) {
    throw new MigrationRefused("A C5 batch needs at least one candidate.", "empty_batch");
  }
  if (count > MAX_C5_DELETION_BATCH) {
    throw new MigrationRefused(
      `C5 proposes at most ${MAX_C5_DELETION_BATCH} orphans per batch; got ${count}.`,
      "batch_too_large"
    );
  }
}

/**
 * One planned deletion, recorded as a PAIR.
 *
 * Both halves are fingerprinted. A plan that named only the candidate would be
 * unable to notice that the twin had changed underneath it, which is the one
 * failure mode C5 has and C3 did not.
 */
export interface OrphanManifestEntry {
  candidatePath: string;
  candidateBytes: number;
  candidateChecksum: string;
  twinPath: string;
  twinBytes: number;
  twinChecksum: string;
  /** What the twin's reference state was when a person reviewed this. */
  expectedTwinLiveReferences: number;
  expectedCandidateLiveReferences: 0;
  expectedCandidateHistoricalReferences: 0;
}

export const C5_MANIFEST_KIND = "c5-orphan-delete" as const;
export const C5_MANIFEST_VERSION = 1;

export interface OrphanManifest {
  kind: typeof C5_MANIFEST_KIND;
  batchId: string;
  createdAt: string;
  entries: OrphanManifestEntry[];
  checksum: string;
}

export interface OrphanChecksumSubject {
  batchId: string;
  entries: OrphanManifestEntry[];
}

/**
 * A fingerprint of exactly what was reviewed.
 *
 * Covers batch identity and, for every entry, BOTH objects and the twin's
 * reference count. Changing any of them changes the checksum, so a manifest
 * cannot be edited to point at a different survivor after review.
 *
 * `createdAt` is excluded, as in C2 and C3: when the plan ran is not an input
 * to what the plan says.
 */
export function orphanManifestChecksum(
  subject: OrphanChecksumSubject,
  hash: (input: string) => string
): string {
  const entries = subject.entries
    .map((e) => ({
      candidatePath: e.candidatePath,
      candidateBytes: e.candidateBytes,
      candidateChecksum: e.candidateChecksum,
      twinPath: e.twinPath,
      twinBytes: e.twinBytes,
      twinChecksum: e.twinChecksum,
      expectedTwinLiveReferences: e.expectedTwinLiveReferences,
      expectedCandidateLiveReferences: e.expectedCandidateLiveReferences,
      expectedCandidateHistoricalReferences: e.expectedCandidateHistoricalReferences,
    }))
    .sort((a, b) => a.candidatePath.localeCompare(b.candidatePath));
  return hash(JSON.stringify({
    version: C5_MANIFEST_VERSION,
    kind: C5_MANIFEST_KIND,
    batchId: subject.batchId,
    entries,
  }));
}

/**
 * Refuse a manifest whose entries do not agree with themselves.
 *
 * Everything here is checkable without touching production, so a malformed
 * plan dies before any network call. A future executor calls this first, then
 * re-proves every entry against live data anyway.
 */
export function assertCoherentOrphanManifest(manifest: OrphanManifest): void {
  const refuse = (message: string, reason: string) => {
    throw new MigrationRefused(message, reason);
  };
  if (manifest.kind !== C5_MANIFEST_KIND) {
    refuse(`manifest kind is "${manifest.kind}", not "${C5_MANIFEST_KIND}"`, "wrong_kind");
  }
  assertC5BatchSize(manifest.entries.length);

  const candidates = new Set<string>();
  for (const e of manifest.entries) {
    assertC5InScope(e.candidatePath, e.twinPath);
    if (e.candidateChecksum !== e.twinChecksum) {
      refuse(`${e.candidatePath} and its twin have different checksums in the manifest`, "checksum_mismatch");
    }
    if (e.candidateBytes !== e.twinBytes) {
      refuse(`${e.candidatePath} and its twin have different byte lengths in the manifest`, "bytes_mismatch");
    }
    if (e.expectedTwinLiveReferences < 1) {
      refuse(`${e.twinPath} is recorded with no live references, so it is not a survivor`, "twin_unreferenced");
    }
    if (e.expectedCandidateLiveReferences !== 0 || e.expectedCandidateHistoricalReferences !== 0) {
      refuse(`${e.candidatePath} is recorded with references, so it is not an orphan`, "candidate_referenced");
    }
    candidates.add(e.candidatePath);
  }
  if (candidates.size !== manifest.entries.length) {
    refuse("manifest contains duplicate candidate paths", "duplicate_entries");
  }
  // The survivor of one entry must never be the candidate of another: that
  // pair would delete both copies of the same photograph in a single batch.
  for (const e of manifest.entries) {
    if (candidates.has(e.twinPath)) {
      refuse(
        `${e.twinPath} is cited as a survivor and also queued for deletion in this batch`,
        "twin_also_candidate"
      );
    }
  }
}
