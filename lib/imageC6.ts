/**
 * C6 — normalising the live originals C2 never got to.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * C6 is not a new kind of operation. It is C2, pointed at the 94 oversized
 * live originals the storage audit found still sitting at camera resolution —
 * a mean of 34.6 megapixels each, on a site whose widest possible request is
 * 1920px. The shape is identical and deliberately so:
 *
 *     normalize -> verify -> upload an immutable master -> repoint every
 *     reference -> verify -> KEEP THE ORIGINAL
 *
 * THE LAST STEP IS THE WHOLE SAFETY MODEL. C6 never deletes anything. An
 * original that has been migrated is still there afterwards, byte for byte,
 * which is what made five C2 batches safe to run from an unmerged branch: a
 * bad result is undone by pointing rows back, not by restoring from a backup
 * that does not exist. Reclaiming the bytes is a separate, later, irreversible
 * decision — C3's job, under its own review.
 *
 * So the rules here are about one question: can every reference to this
 * photograph be moved, and proved moved? An original whose references cannot
 * all be rewritten is refused outright rather than half-migrated. Migrating
 * three of a photograph's four references and calling it done is how an image
 * ends up half-moved with nobody noticing.
 *
 * WHY A SEPARATE MODULE AT ALL. Two things differ from C2 and neither belongs
 * in C2's own rules: the candidate set is fixed by an audit rather than
 * discovered by scanning, and the batch ceiling is half of C2's because the
 * catalogue is now live and busier than it was in August. Everything else —
 * planRepoints, the compare-and-set discipline, rollbackFor, the checksum
 * envelope — is imported, not reimplemented.
 *
 * The normalization policy is C2's, unchanged and not C6's to change:
 * TARGET_SHORT_EDGE 2400, MAX_LONG_EDGE 4200, JPEG q92 4:4:4 progressive,
 * sRGB, EXIF orientation baked, never enlarged.
 */
import {
  MigrationRefused,
  isRetainedReferenceTable,
  isRepointable,
} from "./imageBackfill";
import { looksLikeMaster } from "./imageDeletion";
import { NORMALIZER_VERSION, targetSize } from "./imageNormalize";

/* ─────────────────────────────── scope ─────────────────────────────────── */

/** The only prefix C6 will ever normalize. */
export const C6_ALLOWED_PREFIX = "products/";

/** Extensions C6 refuses outright, whatever else is true. */
export const C6_REFUSED_EXTENSIONS = [".heic", ".heif"] as const;

/**
 * The scope gate, run on the exact path that would be read and rewritten.
 *
 * Deliberately independent of classification: this is the check that still
 * holds if every other check was computed from stale data.
 */
export function assertC6InScope(sourcePath: unknown): void {
  const refuse = (message: string) => new MigrationRefused(message, "c6_out_of_scope");
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw refuse("C6 needs an exact source path.");
  }
  if (!sourcePath.startsWith(C6_ALLOWED_PREFIX)) {
    throw refuse(`${sourcePath} is outside ${C6_ALLOWED_PREFIX}, the only prefix C6 normalizes`);
  }
  if (looksLikeMaster(sourcePath)) {
    throw refuse(`${sourcePath} is already a normalised master — C6 never re-normalizes a master`);
  }
  for (const ext of C6_REFUSED_EXTENSIONS) {
    if (sourcePath.toLowerCase().endsWith(ext)) {
      throw refuse(`${sourcePath} is HEIC/HEIF, which is out of scope for this tooling`);
    }
  }
  if (sourcePath.endsWith("/") || sourcePath.includes("*") || sourcePath.includes("..")) {
    throw refuse(`${sourcePath} is not an exact single object path`);
  }
}

/* ──────────────────────────── classification ───────────────────────────── */

export const C6_STATES = [
  "C6_NORMALIZE_ELIGIBLE",
  "C6_BLOCKED_GRAPH_INCOMPLETE",
  "C6_BLOCKED_OUT_OF_SCOPE",
  "C6_BLOCKED_SOURCE_ABSENT",
  "C6_BLOCKED_NOT_LIVE",
  "C6_BLOCKED_CART_HELD",
  "C6_BLOCKED_UNREPOINTABLE_REFERENCE",
  "C6_BLOCKED_NOTHING_TO_GAIN",
  "C6_BLOCKED_NO_CHECKSUM",
  "C6_BLOCKED_UNREADABLE_DIMENSIONS",
  "C6_MANUAL_REVIEW",
] as const;
export type C6State = (typeof C6_STATES)[number];

export function isC6Eligible(state: C6State): boolean {
  return state === "C6_NORMALIZE_ELIGIBLE";
}

export interface C6Reference {
  table: string;
  rowId: string;
  field: string;
  live: boolean;
}

export interface C6Candidate {
  sourcePath: string;
  exists: boolean;
  sourceBytes: number;
  /** SHA-256 of the source's live bytes. Null means it could not be read. */
  sourceChecksum: string | null;
  /** Orientation-corrected dimensions, as the storefront would see them. */
  displayWidth: number | null;
  displayHeight: number | null;
  orientation: number | null;
  format: string | null;
  references: C6Reference[];
  graphIsComplete: boolean;
  /** True only for paths the storage audit placed in SAFE_OPTIMIZATION_CANDIDATE. */
  auditedSafeCandidate: boolean;
}

export interface C6Verdict {
  state: C6State;
  reason: string;
  /** Rows this migration would rewrite, in the order they were planned. */
  repoints: Array<{ table: string; rowId: string; column: string; oldUrl: string }>;
  /** Live references that stay on the retained original on purpose (carts). */
  retained: Array<{ table: string; rowId: string; reason: string }>;
  blockers: Array<{ table: string; rowId: string; reason: string }>;
}

const NONE = { repoints: [], retained: [], blockers: [] };

/**
 * The whole decision, in refusal order.
 *
 * Structure first, because an incomplete graph makes every later answer
 * meaningless. Then scope, then the object, then — last and most importantly —
 * whether every live reference can actually be moved.
 */
export function classifyForC6(
  c: C6Candidate,
  planRepoints: (
    references: C6Reference[],
    oldUrl: string
  ) => {
    repoints: Array<{ table: string; rowId: string; column: string; oldUrl: string }>;
    retained: Array<{ table: string; rowId: string; reason: string }>;
    blockers: Array<{ table: string; rowId: string; reason: string }>;
  },
  oldUrl: string
): C6Verdict {
  const no = (state: C6State, reason: string): C6Verdict => ({ state, reason, ...NONE });

  if (!c.graphIsComplete) {
    return no("C6_BLOCKED_GRAPH_INCOMPLETE",
      "the reference graph is incomplete — cannot prove what points here");
  }
  try {
    assertC6InScope(c.sourcePath);
  } catch (error) {
    return no("C6_BLOCKED_OUT_OF_SCOPE",
      error instanceof MigrationRefused ? error.message : "out of scope");
  }
  if (!c.auditedSafeCandidate) {
    return no("C6_MANUAL_REVIEW",
      "not classified SAFE_OPTIMIZATION_CANDIDATE by the storage audit — outside the approved scope");
  }
  if (!c.exists) {
    return no("C6_BLOCKED_SOURCE_ABSENT", "the source is no longer in the bucket");
  }
  if (c.format === "HEIF") {
    return no("C6_BLOCKED_OUT_OF_SCOPE", "HEIC/HEIF is out of scope for this tooling");
  }
  if (c.sourceChecksum === null) {
    return no("C6_BLOCKED_NO_CHECKSUM",
      "a live SHA-256 could not be computed — the plan would not be pinned to these bytes");
  }
  if (!c.displayWidth || !c.displayHeight) {
    return no("C6_BLOCKED_UNREADABLE_DIMENSIONS",
      "orientation-corrected dimensions could not be read from the header");
  }

  const live = c.references.filter((r) => r.live);
  if (live.length === 0) {
    // A source nothing renders is not a C6 candidate. Moving references it
    // does not have gains nothing, and an unreferenced object is C4/C5's
    // question, not a migration's.
    return no("C6_BLOCKED_NOT_LIVE",
      "nothing live references this object — normalising it would move nothing");
  }

  // NOTHING TO GAIN. targetSize never enlarges, so an image already at or
  // below the policy size returns its own dimensions. Re-encoding those would
  // spend a JPEG generation for no bytes, which is a quality loss with no
  // upside.
  const target = targetSize({ width: c.displayWidth, height: c.displayHeight });
  if (target.width === c.displayWidth && target.height === c.displayHeight) {
    return no("C6_BLOCKED_NOTHING_TO_GAIN",
      `${c.displayWidth}x${c.displayHeight} is already at or below the ${NORMALIZER_VERSION === 1 ? "2400" : "policy"} short-edge target`);
  }

  const plan = planRepoints(live, oldUrl);

  // A cart reference is not a blocker for a migration — C2 established that,
  // at the cost of a batch. The cart keeps pointing at the RETAINED original,
  // which is exactly what retention is for. It blocks deletion later, never
  // this. But a cart-held source has no repointable references of its own if
  // the cart is all it has, and that case falls out below.
  if (plan.blockers.length > 0) {
    return {
      state: "C6_BLOCKED_UNREPOINTABLE_REFERENCE",
      reason:
        `${plan.blockers.length} live reference(s) cannot be rewritten by this tool ` +
        `(${plan.blockers.map((b) => b.table).join(", ")}); a half-migrated photograph is worse than an unmigrated one`,
      repoints: [], retained: plan.retained, blockers: plan.blockers,
    };
  }
  if (plan.repoints.length === 0) {
    return {
      state: "C6_BLOCKED_CART_HELD",
      reason:
        "every live reference is a retained one (a cart renders the original URL verbatim), " +
        "so there is nothing for this migration to move",
      repoints: [], retained: plan.retained, blockers: [],
    };
  }

  return {
    state: "C6_NORMALIZE_ELIGIBLE",
    reason:
      `${c.displayWidth}x${c.displayHeight} -> ${target.width}x${target.height}; ` +
      `${plan.repoints.length} reference(s) to move` +
      (plan.retained.length ? `, ${plan.retained.length} retained on the original` : ""),
    repoints: plan.repoints,
    retained: plan.retained,
    blockers: [],
  };
}

/* ──────────────────────────────── manifest ─────────────────────────────── */

/**
 * How many originals one C6 batch may ever migrate.
 *
 * Half of C2's ceiling of 10. C2 ran when this catalogue was quieter; C6 runs
 * against a live shop with baskets in flight, and every batch rewrites rows
 * customers are reading. There is no flag to raise this — a bigger job is more
 * batches, not a bigger batch.
 */
export const MAX_C6_BATCH = 5;

export function assertC6BatchSize(count: number): void {
  if (!Number.isInteger(count) || count <= 0) {
    throw new MigrationRefused("A C6 batch needs at least one source.", "empty_batch");
  }
  if (count > MAX_C6_BATCH) {
    throw new MigrationRefused(
      `C6 migrates at most ${MAX_C6_BATCH} originals per batch; got ${count}.`,
      "batch_too_large"
    );
  }
}

export interface C6ManifestEntry {
  sourcePath: string;
  sourceBytes: number;
  /** Pins the plan to exact bytes: the executor recomputes this before acting. */
  sourceChecksum: string;
  sourceWidth: number;
  sourceHeight: number;
  orientation: number | null;
  /** What the normalizer will produce, computed deterministically at plan time. */
  targetWidth: number;
  targetHeight: number;
  /**
   * Every row this run will rewrite, snapshotted with the value it must still
   * hold. The executor's compare-and-set uses oldUrl as the match condition,
   * so a row edited since planning fails rather than being overwritten.
   */
  repoints: Array<{ table: string; rowId: string; column: string; oldUrl: string }>;
  /** Live references that must still be on the original afterwards. */
  retained: Array<{ table: string; rowId: string }>;
}

export const C6_MANIFEST_KIND = "c6-normalize" as const;
export const C6_MANIFEST_VERSION = 1;

export interface C6Manifest {
  kind: typeof C6_MANIFEST_KIND;
  batchId: string;
  createdAt: string;
  normalizerVersion: number;
  entries: C6ManifestEntry[];
  checksum: string;
}

export interface C6ChecksumSubject {
  batchId: string;
  normalizerVersion: number;
  entries: C6ManifestEntry[];
}

/**
 * A fingerprint of every execution-critical field.
 *
 * Covers batch identity, normalizer version, and for every entry: the source,
 * its bytes and digest, the dimensions in and out, and the exact set of rows
 * to rewrite with the values they must still hold. Changing any of them
 * changes the checksum, so a reviewed plan cannot be edited into a different
 * one — including by swapping which row gets repointed.
 *
 * `createdAt` is excluded, as in C2, C3 and C5: when the plan ran is not an
 * input to what the plan says.
 */
export function c6ManifestChecksum(
  subject: C6ChecksumSubject,
  hash: (input: string) => string
): string {
  const entries = subject.entries
    .map((e) => ({
      sourcePath: e.sourcePath,
      sourceBytes: e.sourceBytes,
      sourceChecksum: e.sourceChecksum,
      sourceWidth: e.sourceWidth,
      sourceHeight: e.sourceHeight,
      orientation: e.orientation,
      targetWidth: e.targetWidth,
      targetHeight: e.targetHeight,
      repoints: e.repoints
        .map((r) => `${r.table}/${r.rowId}/${r.column}/${r.oldUrl}`)
        .sort(),
      retained: e.retained.map((r) => `${r.table}/${r.rowId}`).sort(),
    }))
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return hash(JSON.stringify({
    version: C6_MANIFEST_VERSION,
    kind: C6_MANIFEST_KIND,
    batchId: subject.batchId,
    normalizerVersion: subject.normalizerVersion,
    entries,
  }));
}

/**
 * Refuse a manifest that does not agree with itself.
 *
 * Everything here is checkable without a network call, so a malformed plan
 * dies before production is touched. The executor calls this first and then
 * re-proves every entry against live data anyway.
 */
export function assertCoherentC6Manifest(manifest: C6Manifest): void {
  const refuse = (message: string, reason: string) => {
    throw new MigrationRefused(message, reason);
  };
  if (manifest.kind !== C6_MANIFEST_KIND) {
    refuse(`manifest kind is "${manifest.kind}", not "${C6_MANIFEST_KIND}"`, "wrong_kind");
  }
  if (manifest.normalizerVersion !== NORMALIZER_VERSION) {
    refuse("manifest was planned under a different normalizer version", "version_mismatch");
  }
  assertC6BatchSize(manifest.entries.length);

  const sources = new Set<string>();
  const claimedRows = new Set<string>();
  for (const e of manifest.entries) {
    assertC6InScope(e.sourcePath);
    if (e.repoints.length === 0) {
      refuse(`${e.sourcePath} has no repoints, so the migration would move nothing`, "no_repoints");
    }
    if (e.targetWidth > e.sourceWidth || e.targetHeight > e.sourceHeight) {
      refuse(`${e.sourcePath} would be enlarged, which the normalizer never does`, "would_enlarge");
    }
    if (e.targetWidth === e.sourceWidth && e.targetHeight === e.sourceHeight) {
      refuse(`${e.sourcePath} is already at target size; re-encoding gains nothing`, "nothing_to_gain");
    }
    for (const r of e.repoints) {
      if (!isRepointable(r.table)) {
        refuse(`${r.table} is not a table this migration may rewrite`, "unrepointable_table");
      }
      if (isRetainedReferenceTable(r.table)) {
        refuse(`${r.table} is a retained reference and must stay on the original`, "retained_table_repointed");
      }
      // The same row must never be claimed twice, by this entry or another:
      // two sources rewriting one column would race, and the second would
      // silently undo the first.
      const id = `${r.table}/${r.rowId}/${r.column}`;
      if (claimedRows.has(id)) {
        refuse(`${id} is repointed by more than one entry in this batch`, "duplicate_repoint");
      }
      claimedRows.add(id);
    }
    for (const r of e.retained) {
      if (!isRetainedReferenceTable(r.table)) {
        refuse(`${r.table} is recorded as retained but is not a retained-reference table`, "bad_retained");
      }
    }
    sources.add(e.sourcePath);
  }
  if (sources.size !== manifest.entries.length) {
    refuse("manifest contains duplicate source paths", "duplicate_entries");
  }
}

/**
 * C6 CANNOT DELETE, AND THIS IS WHERE THAT IS WRITTEN DOWN.
 *
 * The retained original is the entire rollback story: if a master turns out
 * wrong, the fix is to point the rows back at bytes that are still there. A
 * migration that also deleted would have no such fix, and would be C3 wearing
 * a migration's name.
 *
 * The test suite asserts this constant is exported and that no C6 file
 * contains a storage delete, so wiring one in later fails the suite rather
 * than shipping.
 */
export const C6_RETAINS_ORIGINALS = true as const;
