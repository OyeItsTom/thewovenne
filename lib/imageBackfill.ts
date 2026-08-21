/**
 * The rules that decide what a migration is allowed to touch.
 *
 * C2 is the first tool in this series that writes, so everything about it is
 * arranged to fail closed. The batch ceiling is a constant rather than an
 * argument, the set of columns it may rewrite is a whitelist rather than a
 * filter, and a run is bound to a manifest whose checksum must still describe
 * the live data or nothing happens at all.
 *
 * WHAT C2 DOES NOT DO: delete. The original stays exactly where it is, and the
 * references move to the new master. That is what makes the whole phase
 * reversible — a bad result is undone by pointing the rows back, not by
 * restoring anything from a backup that does not exist.
 */

/**
 * Ten. Not a default, not a maximum a flag can raise — the number.
 *
 * A migration that can be told to do 148 things is one keystroke away from
 * doing 148 things. Raising this is a code change, which is a review, which is
 * the point.
 *
 * It was five for the first three batches. Fifteen sources migrated with no
 * rollback and no drift, so the ceiling moved once — and only once. Note what
 * the evidence does and does not say: batch size has never affected per-source
 * safety, because each source is repointed by compare-and-set and rolled back
 * alone. What it affects is how far a SYSTEMATIC error travels before a person
 * notices. Batch 1 put four wrong photographs live while the executor worked
 * perfectly; review caught it, not the tool. Ten is the size at which a
 * contact sheet is still looked at rather than skimmed. Twenty is deliberately
 * not approved yet, and waits on two clean batches at ten.
 */
export const MAX_EXECUTION_BATCH = 10;

/**
 * Columns a product-image migration may rewrite.
 *
 * A WHITELIST OF (table, column), not "anything holding the URL". Two live
 * reference sources are deliberately absent:
 *
 * `carts.items` is a JSONB blob belonging to a customer who is mid-shop.
 * Rewriting it to save storage is a poor trade, and it is unnecessary here:
 * C2 keeps the original, so a basket pointing at the original keeps working.
 *
 * `site_content` is the lookbook and campaign CMS. A product-image migration
 * has no business editing page content, and those assets are not product
 * sources anyway.
 *
 * Both are still counted as LIVE references by lib/imageReferences, which is
 * exactly why sources touching them are excluded from a batch rather than
 * quietly half-migrated.
 */
export const REPOINTABLE_COLUMNS: ReadonlyArray<{ table: string; column: string; idColumn: string }> = [
  { table: "product_images", column: "url", idColumn: "id" },
  { table: "products", column: "image_url", idColumn: "id" },
  { table: "product_versions", column: "image_url", idColumn: "id" },
];

/** Live reference sources this tool must never rewrite. */
export const NON_REPOINTABLE_TABLES = ["carts", "site_content"] as const;

/**
 * Live references that are ALLOWED to stay on the original after a migration.
 *
 * A cart is a customer's basket. It stores an absolute URL and
 * components/cart/CartItem.tsx renders that URL verbatim — nothing re-resolves
 * it from the product. So a cart reference is a reason never to DELETE the
 * original, which is a C3 concern. It is not a reason to refuse to move the
 * PRODUCT rows to a normalised master, which is what C2 does.
 *
 * Conflating those two cost us the largest single candidate in the catalogue:
 * a live published cover, 12.35 MiB, blocked from C2 for a property that only
 * ever constrained C3. The rule now says what it means — the cart keeps
 * pointing at the retained original, and the original stays forever, or at
 * least until nothing points at it.
 */
export const RETAINED_REFERENCE_TABLES = ["carts"] as const;

/**
 * Live references that still disqualify a source from C2 entirely.
 *
 * site_content is the lookbook and campaign CMS. Unlike a cart it is content
 * this project edits, so a reference there means the object is not really a
 * product source and a product-image migration has no business reasoning about
 * it. Left disqualifying, exactly as before.
 */
export const DISQUALIFYING_REFERENCE_TABLES = ["site_content"] as const;

export function isRetainedReferenceTable(table: string): boolean {
  return (RETAINED_REFERENCE_TABLES as readonly string[]).includes(table);
}

export function isRepointable(table: string): boolean {
  return REPOINTABLE_COLUMNS.some((c) => c.table === table);
}

export class MigrationRefused extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/* ────────────────────────────── batch guards ────────────────────────────── */

export function assertBatchSize(count: number): void {
  if (!Number.isInteger(count) || count <= 0) {
    throw new MigrationRefused("A batch needs at least one source.", "empty_batch");
  }
  if (count > MAX_EXECUTION_BATCH) {
    throw new MigrationRefused(
      `This tool migrates at most ${MAX_EXECUTION_BATCH} sources per run; the manifest has ${count}.`,
      "batch_too_large"
    );
  }
}

/* ─────────────────────────────── the manifest ───────────────────────────── */

export interface ManifestEntry {
  sourcePath: string;
  sourceBytes: number;
  /** Exactly the rows this run expects to rewrite, snapshotted at plan time. */
  repoints: Array<{ table: string; rowId: string; column: string; oldUrl: string }>;
}

export interface Manifest {
  batchId: string;
  createdAt: string;
  normalizerVersion: number;
  entries: ManifestEntry[];
  checksum: string;
}

/**
 * A stable fingerprint of what the plan expected to find.
 *
 * Recomputed against live data immediately before execution: if a photograph
 * was replaced, a gallery reordered or a draft edited in the meantime, the
 * checksum stops matching and the run aborts rather than writing a plan that
 * describes a catalogue that no longer exists.
 */
export function manifestChecksum(
  entries: ManifestEntry[],
  hash: (input: string) => string
): string {
  const canonical = entries
    .map((e) => ({
      sourcePath: e.sourcePath,
      sourceBytes: e.sourceBytes,
      repoints: [...e.repoints]
        .map((r) => `${r.table}|${r.rowId}|${r.column}|${r.oldUrl}`)
        .sort(),
    }))
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return hash(JSON.stringify(canonical));
}

/**
 * Which rows a source's references translate into.
 *
 * Three outcomes, and the difference between the last two is the whole point:
 *
 *   repoints — rows C2 will move to the master. These MUST all move.
 *   retained — live references that stay on the original ON PURPOSE (carts).
 *              Not skipped quietly, not an error; recorded, so that a later
 *              verification can prove they are still exactly where they were.
 *   blockers — anything else this tool cannot rewrite, which disqualifies the
 *              whole source. Migrating three of a photograph's four references
 *              and calling it done is how an image ends up half-moved with
 *              nobody noticing.
 */
export function planRepoints(
  references: Array<{ table: string; rowId: string; field: string; live: boolean }>,
  oldUrl: string
): {
  repoints: Array<{ table: string; rowId: string; column: string; oldUrl: string }>;
  retained: Array<{ table: string; rowId: string; reason: string }>;
  blockers: Array<{ table: string; rowId: string; reason: string }>;
} {
  const repoints: Array<{ table: string; rowId: string; column: string; oldUrl: string }> = [];
  const retained: Array<{ table: string; rowId: string; reason: string }> = [];
  const blockers: Array<{ table: string; rowId: string; reason: string }> = [];
  for (const reference of references) {
    if (!reference.live) continue; // audit log: evidence, never rewritten
    const allowed = REPOINTABLE_COLUMNS.find((c) => c.table === reference.table);
    if (!allowed) {
      if (isRetainedReferenceTable(reference.table)) {
        retained.push({
          table: reference.table,
          rowId: reference.rowId,
          reason: `${reference.table} keeps pointing at the retained original; it blocks C3 deletion, not C2`,
        });
        continue;
      }
      blockers.push({
        table: reference.table,
        rowId: reference.rowId,
        reason: `${reference.table} is a live reference this migration may not rewrite`,
      });
      continue;
    }
    if (reference.field !== allowed.column) {
      blockers.push({
        table: reference.table,
        rowId: reference.rowId,
        reason: `reference sits in "${reference.field}", not the expected "${allowed.column}"`,
      });
      continue;
    }
    repoints.push({ table: reference.table, rowId: reference.rowId, column: allowed.column, oldUrl });
  }
  return { repoints, retained, blockers };
}

/**
 * A canonical identity for one retained reference.
 *
 * Counting retained references was not enough. "One before, one after" also
 * describes a run in which one cart lost the reference and a different cart
 * gained it — the count is preserved and the guarantee is not. Identity is what
 * the invariant actually needs: the SAME row, in the SAME field, still pointing
 * at the SAME original.
 *
 * Built from ReferenceHit rather than a parallel shape, so the graph stays the
 * one description of what points where. The source URL is included because a
 * verifier that only compared table/row/field would accept a row that had been
 * repointed to something else entirely.
 */
export function retainedIdentity(
  reference: { table: string; rowId: string; field: string },
  sourceUrl: string
): string {
  return [reference.table, reference.rowId, reference.field, sourceUrl].join(" ");
}

/** The identity set for every retained reference, ordered so it compares stably. */
export function retainedIdentitySet(
  references: Array<{ table: string; rowId: string; field: string; live: boolean }>,
  sourceUrl: string
): string[] {
  return references
    .filter((reference) => reference.live && isRetainedReferenceTable(reference.table))
    .map((reference) => retainedIdentity(reference, sourceUrl))
    .sort();
}

/**
 * Compare two retained-reference identity sets.
 *
 * Returns what changed rather than a boolean, because the operator needs to
 * know WHICH guarantee broke: a reference that vanished means something wrote
 * to a cart, and a reference that appeared means something else did.
 */
export function retainedIdentityDiff(
  before: string[],
  after: string[]
): { missing: string[]; unexpected: string[]; unchanged: boolean } {
  const b = new Set(before);
  const a = new Set(after);
  const missing = before.filter((id) => !a.has(id));
  const unexpected = after.filter((id) => !b.has(id));
  return { missing, unexpected, unchanged: missing.length === 0 && unexpected.length === 0 };
}

/** Human-readable form of an identity, for errors and the ledger. */
export function describeRetainedIdentity(identity: string): string {
  const [table, rowId, field, url] = identity.split(" ");
  return `${table}/${rowId}.${field} -> ${url}`;
}

/**
 * Whether C3 may ever delete this original.
 *
 * THIS FUNCTION DELETES NOTHING. It is a predicate, living here so that the
 * rule survives in one place while C2 relaxes around it: C2 is now allowed to
 * migrate a source a cart still points at, and the only thing standing between
 * that original and deletion is this answer. C3 is a separate PR; when it is
 * written it must ask this, and it must ask it again immediately before the
 * delete, against a freshly rebuilt graph.
 */
export function deletionBlockers(
  references: Array<{ table: string; rowId: string; field: string; live: boolean }>
): Array<{ table: string; rowId: string; reason: string }> {
  return references
    .filter((reference) => reference.live)
    .map((reference) => ({
      table: reference.table,
      rowId: reference.rowId,
      reason: `${reference.table}/${reference.rowId} still points at this original`,
    }));
}

/** Convenience for the future C3: any live reference at all forbids deletion. */
export function canDeleteOriginal(
  references: Array<{ table: string; rowId: string; field: string; live: boolean }>,
  graphIsComplete: boolean
): boolean {
  if (!graphIsComplete) return false;
  return deletionBlockers(references).length === 0;
}

/** The reverse of an applied repoint, for undoing a source that failed late. */
export function rollbackFor(
  applied: Array<{ table: string; rowId: string; column: string; oldUrl: string; newUrl: string }>
): Array<{ table: string; rowId: string; column: string; from: string; to: string }> {
  return applied.map((a) => ({
    table: a.table,
    rowId: a.rowId,
    column: a.column,
    from: a.newUrl,
    to: a.oldUrl,
  }));
}

/* ──────────────────────────── eligibility ───────────────────────────────── */

export interface EligibilityInput {
  classification: string;
  liveReferences: number;
  graphIsComplete: boolean;
  format: string | null;
  hasWarnings: boolean;
  blockers: number;
  /**
   * How many rows C2 would actually move. Distinct from liveReferences, which
   * now counts permitted retained references too: a source three abandoned
   * carts point at has live references and nothing to migrate.
   */
  migratableReferences: number;
}

/**
 * Whether a source may be migrated at all.
 *
 * Everything here is a refusal. There is no branch that says yes to something
 * uncertain: an unreadable header, an incomplete graph, a HEIC, a reference in
 * a table this tool cannot rewrite — each of those ends the source's candidacy
 * rather than being worked around.
 */
export function migrationRefusal(input: EligibilityInput): string | null {
  if (!input.graphIsComplete) return "the reference graph is incomplete — cannot prove what points here";
  if (input.format === "HEIF") return "HEIC/HEIF is out of scope until PR B";
  if (input.hasWarnings) return "the source could not be profiled confidently";
  if (input.blockers > 0) return "a live reference sits in a table this migration may not rewrite";
  if (input.liveReferences < 1) return "nothing references it — that is orphan work, not backfill";
  // A source only a cart points at has nothing C2 can move. Its product was
  // deleted; the basket is a snapshot of something that no longer exists.
  // Normalising it would add a master nothing would ever read.
  if (input.migratableReferences < 1) {
    return "only permitted-retained references (e.g. carts) point here — nothing for C2 to move";
  }
  if (
    input.classification !== "REFERENCED_PRODUCT_SOURCE" &&
    input.classification !== "REFERENCED_SHARED_SOURCE"
  ) {
    return `classification ${input.classification} is not a product source`;
  }
  return null;
}

/** The flags a destructive run must carry. Absent any one of them, it plans. */
export const EXECUTE_FLAGS = {
  execute: "--execute",
  batchId: "--batch-id",
  manifest: "--source-manifest",
  acknowledgement: "--yes-i-understand-originals-are-retained",
} as const;

export function assertExecuteFlags(argv: string[]): { batchId: string; manifestPath: string } {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (!has(EXECUTE_FLAGS.execute)) {
    throw new MigrationRefused("Not an execution run.", "not_execute");
  }
  if (!has(EXECUTE_FLAGS.acknowledgement)) {
    throw new MigrationRefused(
      `Execution also needs ${EXECUTE_FLAGS.acknowledgement}.`,
      "missing_acknowledgement"
    );
  }
  const batchId = valueOf(EXECUTE_FLAGS.batchId);
  const manifestPath = valueOf(EXECUTE_FLAGS.manifest);
  if (!batchId) throw new MigrationRefused(`${EXECUTE_FLAGS.batchId} is required.`, "missing_batch_id");
  if (!manifestPath) {
    throw new MigrationRefused(`${EXECUTE_FLAGS.manifest} is required.`, "missing_manifest");
  }
  return { batchId, manifestPath };
}
