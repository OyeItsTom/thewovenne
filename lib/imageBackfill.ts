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
 * Five. Not a default, not a maximum a flag can raise — the number.
 *
 * A migration that can be told to do 148 things is one keystroke away from
 * doing 148 things. Raising this is a code change, which is a review, which is
 * the point.
 */
export const MAX_EXECUTION_BATCH = 5;

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
 * A reference in a table this tool may not rewrite is not skipped quietly — it
 * is returned as a blocker, and the caller refuses the source. Migrating three
 * of a photograph's four references and calling it done is how an image ends up
 * half-moved with nobody noticing.
 */
export function planRepoints(
  references: Array<{ table: string; rowId: string; field: string; live: boolean }>,
  oldUrl: string
): {
  repoints: Array<{ table: string; rowId: string; column: string; oldUrl: string }>;
  blockers: Array<{ table: string; rowId: string; reason: string }>;
} {
  const repoints: Array<{ table: string; rowId: string; column: string; oldUrl: string }> = [];
  const blockers: Array<{ table: string; rowId: string; reason: string }> = [];
  for (const reference of references) {
    if (!reference.live) continue; // audit log: evidence, never rewritten
    const allowed = REPOINTABLE_COLUMNS.find((c) => c.table === reference.table);
    if (!allowed) {
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
  return { repoints, blockers };
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
