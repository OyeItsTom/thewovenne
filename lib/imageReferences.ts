/**
 * Who is still using a photograph.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE MOST IMPORTANT FILE IN THE BACKFILL. An
 * earlier count of "unreferenced" objects looked at product_images and the
 * products cover column, found 57, and called them orphans. Rebuilt against
 * every table that can hold a storage URL, the real number is 46 — and eleven
 * of the objects on that first list are genuinely in use, by draft product
 * versions, by CMS content, and by live customer baskets. Deleting them would
 * have destroyed photography that something was still rendering.
 *
 * So the rule here is that a reference is anything that could put the object in
 * front of a person, and the graph is rebuilt from current data every run.
 * There is no stored orphan list to go stale.
 *
 * NOTHING IN THIS MODULE WRITES. It reads rows, matches strings and answers
 * questions. The tooling that uses it is read-only by construction, which is
 * asserted in scripts/image-backfill.test.ts rather than merely intended.
 */

/**
 * Tables whose rows can put an image in front of somebody.
 *
 * `carts` is on this list and it is the one people forget: a basket stores the
 * photograph's URL at the moment the item was added, so deleting that object
 * breaks a thumbnail in a basket somebody is still shopping with. `site_content`
 * carries the lookbook and campaign imagery. `product_versions` holds the draft
 * and archived copies of a product, each with its own cover — which is why a
 * single photograph in this catalogue is routinely referenced two to fifteen
 * times.
 */
export const LIVE_REFERENCE_TABLES = [
  "product_images",
  "products",
  "product_versions",
  "site_content",
  "carts",
] as const;

/**
 * Evidence that an object was once used, and no reason at all to keep it.
 *
 * The audit log records what an admin did. It renders nothing, and an entry
 * mentioning a photograph does not mean anything still points at it — but it is
 * worth surfacing, because an object that appears here was attached once and
 * later detached, which is a different story from an object nothing has ever
 * referenced. It is reported, never counted as live.
 */
export const HISTORICAL_REFERENCE_TABLES = ["admin_audit_log"] as const;

export type LiveTable = (typeof LIVE_REFERENCE_TABLES)[number];
export type HistoricalTable = (typeof HISTORICAL_REFERENCE_TABLES)[number];

export interface ReferenceHit {
  table: string;
  /** The row's own id, or its product_id when that is the only identifier. */
  rowId: string;
  /** The column the URL was found in, as far as it can be determined. */
  field: string;
  live: boolean;
}

export interface StorageObject {
  bucket: string;
  /** Key within the bucket, e.g. "products/abc.jpg". */
  key: string;
  bytes: number;
  mime?: string | null;
  createdAt?: string | null;
}

/**
 * A storage URL as it appears anywhere in the database.
 *
 * Deliberately loose about the middle of the path: Supabase serves the same
 * object through `/object/public/`, `/object/sign/` and a bare `/object/`, and a
 * reference written by any of them is still a reference.
 */
const STORAGE_URL = /\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?([a-z0-9][a-z0-9._-]*)\/([^"'\\\s)>?]+)/g;

/** Every (bucket, key) pair mentioned anywhere in a value. */
export function extractObjectKeys(value: unknown): Array<{ bucket: string; key: string }> {
  const blob = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const found: Array<{ bucket: string; key: string }> = [];
  const seen = new Set<string>();
  for (const match of blob.matchAll(STORAGE_URL)) {
    const bucket = match[1];
    // A trailing query string is not part of the key; a percent-encoded path is.
    const key = decodeURIComponent(match[2].split("?")[0]);
    const id = `${bucket}|${key}`;
    if (!seen.has(id)) {
      seen.add(id);
      found.push({ bucket, key });
    }
  }
  return found;
}

/** Which column of a row held a given key, best-effort, for the report. */
export function fieldHolding(row: Record<string, unknown>, key: string): string {
  const encoded = encodeURIComponent(key);
  for (const [column, value] of Object.entries(row)) {
    if (typeof value === "string" && (value.includes(key) || value.includes(encoded))) return column;
  }
  for (const [column, value] of Object.entries(row)) {
    if (value === null || typeof value !== "object") continue;
    const blob = JSON.stringify(value);
    if (blob.includes(key) || blob.includes(encoded)) return column;
  }
  return "?";
}

export interface TableRows {
  table: string;
  rows: Array<Record<string, unknown>>;
}

/**
 * The graph.
 *
 * Built from rows that were already fetched, so it can be exercised in a test
 * with a handful of literals and no network — which is the only way the
 * dangerous cases (a cart holding the last reference, a draft version holding
 * the last reference) can be checked deterministically.
 */
export class ImageReferenceGraph {
  private readonly hits = new Map<string, ReferenceHit[]>();
  /** Tables that were asked for but could not be read. See `isComplete`. */
  readonly unreadable: string[];

  constructor(tables: TableRows[], unreadable: string[] = []) {
    this.unreadable = [...unreadable];
    const live = new Set<string>(LIVE_REFERENCE_TABLES);
    const historical = new Set<string>(HISTORICAL_REFERENCE_TABLES);
    for (const { table, rows } of tables) {
      const isLive = live.has(table);
      const isHistorical = historical.has(table);
      // A table nobody classified is treated as LIVE. Counting an unknown
      // reference as historical would make an object look deletable because we
      // failed to think about where it was used.
      const countsAsLive = isLive || !isHistorical;
      for (const row of rows) {
        for (const { bucket, key } of extractObjectKeys(row)) {
          const id = `${bucket}|${key}`;
          const rowId = String(row.id ?? row.product_id ?? row.cart_id ?? "?");
          const list = this.hits.get(id) ?? [];
          list.push({ table, rowId, field: fieldHolding(row, key), live: countsAsLive });
          this.hits.set(id, list);
        }
      }
    }
  }

  /**
   * Whether every table that could hold a reference was actually read.
   *
   * A graph built with a table missing cannot prove anything is unreferenced,
   * and the caller must degrade its classification accordingly rather than
   * quietly reporting fewer references than exist.
   */
  get isComplete(): boolean {
    return this.unreadable.length === 0;
  }

  private id(bucket: string, key: string): string {
    return `${bucket}|${key}`;
  }

  referencesFor(bucket: string, key: string): ReferenceHit[] {
    return this.hits.get(this.id(bucket, key)) ?? [];
  }

  liveReferenceCount(bucket: string, key: string): number {
    return this.referencesFor(bucket, key).filter((h) => h.live).length;
  }

  historicalReferenceCount(bucket: string, key: string): number {
    return this.referencesFor(bucket, key).filter((h) => !h.live).length;
  }

  /** Referenced by more than one live row — deleting it needs all of them gone. */
  isShared(bucket: string, key: string): boolean {
    return this.liveReferenceCount(bucket, key) > 1;
  }

  /** The distinct products a photograph belongs to, for the operator's report. */
  associatedEntities(bucket: string, key: string): Array<{ table: string; rowId: string }> {
    const seen = new Set<string>();
    const out: Array<{ table: string; rowId: string }> = [];
    for (const hit of this.referencesFor(bucket, key)) {
      if (!hit.live) continue;
      const id = `${hit.table}:${hit.rowId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ table: hit.table, rowId: hit.rowId });
    }
    return out;
  }

  /** Counts per table, for the human-readable report. */
  breakdown(bucket: string, key: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const hit of this.referencesFor(bucket, key)) {
      out[hit.table] = (out[hit.table] ?? 0) + 1;
    }
    return out;
  }
}

/* ────────────────────────────── classification ──────────────────────────── */

export type Classification =
  | "REFERENCED_PRODUCT_SOURCE"
  | "REFERENCED_SHARED_SOURCE"
  | "REFERENCED_NON_PRODUCT_ASSET"
  | "ALREADY_NORMALIZED"
  | "CONFIRMED_ZERO_REFERENCE"
  | "HISTORICAL_REFERENCE_ONLY"
  | "RECENT_ZERO_REFERENCE"
  | "HEIC_REVIEW"
  | "UNKNOWN_REVIEW";

/** Only these may ever be considered for deletion, and only by a later PR. */
export const DELETABLE_CLASSIFICATIONS: readonly Classification[] = ["CONFIRMED_ZERO_REFERENCE"];

/**
 * How recently uploaded an unreferenced object must be before it is treated as
 * possibly-in-flight rather than abandoned.
 *
 * Somebody may be halfway through building a product in another tab. Seventy-two
 * hours costs a little storage and removes a whole category of accident.
 */
export const RECENT_UPLOAD_WINDOW_HOURS = 72;

/** Prefixes that are not product photography and are never backfill candidates. */
export const NON_PRODUCT_PREFIXES = ["lookbook", "campaigns", "pages", "journal"];

export function classifyObject(input: {
  object: StorageObject;
  liveReferences: number;
  historicalReferences: number;
  graphIsComplete: boolean;
  now?: Date;
}): Classification {
  const { object, liveReferences, historicalReferences, graphIsComplete } = input;
  const key = object.key;
  const prefix = key.includes("/") ? key.split("/")[0] : "";

  // A graph with a table missing cannot prove absence. Everything unreferenced
  // becomes a review item rather than an orphan.
  const canProveAbsence = graphIsComplete;

  if (/\.hei[cf]$/i.test(key) || (object.mime ?? "").toLowerCase().includes("hei")) {
    return "HEIC_REVIEW";
  }
  if (/-v\d+\.(jpg|webp)$/i.test(key)) return "ALREADY_NORMALIZED";
  if (key.startsWith("staging/")) {
    // Staging is transient by design; it is never a backfill source, and the
    // sweeper (a later PR) is what deals with leftovers.
    return liveReferences > 0 ? "UNKNOWN_REVIEW" : "RECENT_ZERO_REFERENCE";
  }

  if (liveReferences > 0) {
    if (NON_PRODUCT_PREFIXES.includes(prefix)) return "REFERENCED_NON_PRODUCT_ASSET";
    return liveReferences > 1 ? "REFERENCED_SHARED_SOURCE" : "REFERENCED_PRODUCT_SOURCE";
  }

  if (!canProveAbsence) return "UNKNOWN_REVIEW";

  if (isRecent(object.createdAt, input.now)) return "RECENT_ZERO_REFERENCE";
  if (historicalReferences > 0) return "HISTORICAL_REFERENCE_ONLY";
  return "CONFIRMED_ZERO_REFERENCE";
}

export function isRecent(createdAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!createdAt) return true; // no date is not evidence of age
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return true;
  return now.getTime() - created < RECENT_UPLOAD_WINDOW_HOURS * 3600_000;
}

/** Whether a later PR would be allowed to delete this. Never true here. */
export function isDeletionEligible(classification: Classification, liveReferences: number): boolean {
  return liveReferences === 0 && DELETABLE_CLASSIFICATIONS.includes(classification);
}
