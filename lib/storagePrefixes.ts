/**
 * Enumerating a Supabase storage bucket without guessing what is in it.
 *
 * WHY THIS EXISTS. The C2 and C3 tooling listed a hard-coded prefix list —
 * `products/`, `styles/`, `lookbook/`, `staging/`, `tmp/`. Three of those
 * folders do not exist, and the one folder it never named, `campaigns/`, holds
 * six real objects. Every bucket total those tools reported was short by 6
 * objects and 6,595,428 bytes, and nobody could see it because the number
 * looked plausible.
 *
 * Deletion safety was never affected — C3 only ever considered paths a C2
 * ledger had already proven, and its path guard demanded a `products/` prefix
 * independently. But a storage audit that decides what is unreferenced MUST
 * see the whole bucket, or an object nothing points at is invisible rather
 * than reported.
 *
 * So: ask the bucket what is in it. Supabase's list endpoint returns folders
 * as entries with no `id`, so a listing of "" names the top-level folders and
 * each of those can be listed in turn. This module owns that walk and nothing
 * else — it takes a `list` callback so it can be tested without a network.
 */

/** One entry as Supabase's object/list returns it. A folder has no `id`. */
export interface StorageEntry {
  name: string;
  id?: string | null;
  metadata?: { size?: number | null; mimetype?: string | null } | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface StorageObject {
  /** Full key from the bucket root, e.g. "products/abc.jpg". */
  key: string;
  bytes: number;
  mimetype: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Lists one page of one prefix. Supplied by the caller so this stays testable. */
export type ListPage = (prefix: string, offset: number) => Promise<StorageEntry[]>;

/**
 * How deep the walk will go before it refuses to continue.
 *
 * A cycle is not possible through this API, but a pathological bucket could
 * still nest far enough to turn a listing into a very long crawl. Refusing is
 * better than looping: a caller that hits this has a bucket shape nobody has
 * reasoned about, and should look before automating anything against it.
 */
export const MAX_PREFIX_DEPTH = 8;

export class StorageEnumerationRefused extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/**
 * Every object in the bucket, found by asking rather than assuming.
 *
 * Walks breadth-first from the root. Entries with an `id` are objects; entries
 * without one are folders and are queued. Paging continues until a short page
 * arrives, which is how the REST endpoint signals the end.
 *
 * A prefix is never visited twice, so a bucket that reports a folder inside
 * itself cannot spin.
 */
export async function enumerateAllObjects(
  listPage: ListPage,
  pageSize = 100
): Promise<StorageObject[]> {
  const out: StorageObject[] = [];
  const seenPrefix = new Set<string>();
  const seenKey = new Set<string>();
  const queue: Array<{ prefix: string; depth: number }> = [{ prefix: "", depth: 0 }];

  while (queue.length > 0) {
    const { prefix, depth } = queue.shift()!;
    if (seenPrefix.has(prefix)) continue;
    seenPrefix.add(prefix);
    if (depth > MAX_PREFIX_DEPTH) {
      throw new StorageEnumerationRefused(
        `prefix "${prefix}" is deeper than ${MAX_PREFIX_DEPTH} levels; refusing to keep walking`,
        "prefix_too_deep"
      );
    }

    for (let offset = 0; ; offset += pageSize) {
      const page = await listPage(prefix, offset);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const entry of page) {
        if (typeof entry?.name !== "string" || entry.name.length === 0) continue;
        const key = `${prefix}${entry.name}`;
        if (entry.id) {
          if (seenKey.has(key)) continue;
          seenKey.add(key);
          out.push({
            key,
            bytes: entry.metadata?.size ?? 0,
            mimetype: entry.metadata?.mimetype ?? null,
            createdAt: entry.created_at ?? null,
            updatedAt: entry.updated_at ?? null,
          });
        } else {
          queue.push({ prefix: `${key}/`, depth: depth + 1 });
        }
      }
      if (page.length < pageSize) break;
    }
  }
  return out;
}
