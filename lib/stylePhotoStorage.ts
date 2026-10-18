import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Where customers' style photographs live, and how they are taken away.
 *
 * TWO BUCKETS (migration 0073). What a customer sends goes to the PRIVATE
 * `style-photos` bucket — only an admin can read it, by signed URL, to review
 * it. Only when an admin approves does a copy go to the PUBLIC `style-gallery`
 * bucket, which is what the gallery and product pages show. So a pending,
 * rejected or withdrawn photograph has no public address at all.
 *
 * The database decides WHAT should go (style_photo_garbage). It cannot do the
 * removing — storage.protect_delete refuses SQL deletes — so the removing
 * happens here, through the Storage API, with the service key, at the moment
 * each thing happens (see the routes under app/api/style and
 * app/api/admin/style), and as a backstop whenever an admin opens the queue.
 */
export const STYLE_PHOTO_BUCKET = "style-photos";
export const STYLE_GALLERY_BUCKET = "style-gallery";

/**
 * Both buckets refuse more (0073). A serverless request body tops out near
 * 4.5 MB, and the browser's re-encoded JPEG is normally a few hundred KB.
 */
export const STYLE_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

/**
 * How long Supabase's CDN and browsers may keep a public copy. Short, so a
 * photograph taken off the site stops being served soon after its file is
 * deleted; the gallery's own images go through next/image, which caches them.
 */
export const STYLE_GALLERY_CACHE_CONTROL = "3600";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A private original: <owner>/<product>/<uuid>.jpg */
const ORIGINAL = new RegExp(`^(${UUID})/(${UUID})/${UUID}\\.jpg$`);
/** A public copy: <submission>/<uuid>.jpg */
const COPY = new RegExp(`^(${UUID})/${UUID}\\.jpg$`);
const IS_UUID = new RegExp(`^${UUID}$`);

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && IS_UUID.test(value);

/** The private original's key. Built by the server, never taken from a request. */
export function stylePhotoPath(ownerId: string, productId: string, fileId: string): string {
  return `${ownerId}/${productId}/${fileId}.jpg`;
}

/** The public copy's key for one approved submission. */
export function styleGalleryName(submissionId: string, fileId: string): string {
  return `${submissionId}/${fileId}.jpg`;
}

export interface GarbageRow {
  bucket: string;
  name: string;
  reason: string;
}

/**
 * Whose files a customer-triggered cleanup may touch: their own originals
 * (by folder) and the public copies of their own submissions (by id).
 */
export interface RemovalScope {
  ownerId: string;
  submissionIds: string[];
}

export interface Removal {
  originals: string[];
  copies: string[];
}

/**
 * Which of the database's garbage names may actually be removed.
 *
 * A second lock on top of the function that produced them: only names of the
 * shapes 0073 allows, and — when one customer is being cleaned up — only that
 * customer's own. Cleaning up after one person must never reach anybody else.
 */
export function selectForRemoval(rows: GarbageRow[], scope?: RemovalScope): Removal {
  const owner = scope?.ownerId.toLowerCase();
  const submissions = new Set(scope?.submissionIds.map((id) => id.toLowerCase()));
  const originals: string[] = [];
  const copies: string[] = [];
  for (const { bucket, name } of rows) {
    if (bucket === STYLE_PHOTO_BUCKET) {
      const m = ORIGINAL.exec(name);
      if (m && (!scope || m[1] === owner)) originals.push(name);
    } else if (bucket === STYLE_GALLERY_BUCKET) {
      const m = COPY.exec(name);
      if (m && (!scope || submissions.has(m[1]))) copies.push(name);
    }
  }
  return { originals, copies };
}

export interface SweepResult {
  candidates: number;
  removed: number;
  failed: string | null;
}

/** Remove names from one bucket, a hundred per request. Never throws. */
export async function removeStyleObjects(
  service: SupabaseClient,
  bucket: string,
  names: string[]
): Promise<{ removed: number; failed: string | null }> {
  let removed = 0;
  for (let i = 0; i < names.length; i += 100) {
    const { data, error } = await service.storage.from(bucket).remove(names.slice(i, i + 100));
    if (error) return { removed, failed: `remove ${bucket}: ${error.message}` };
    removed += data?.length ?? 0;
  }
  return { removed, failed: null };
}

/** Remove what style_photo_garbage() names. Never throws; reports instead. */
export async function sweepStylePhotos(
  service: SupabaseClient,
  scope?: RemovalScope
): Promise<SweepResult> {
  const { data, error } = await service.rpc("style_photo_garbage");
  if (error) return { candidates: 0, removed: 0, failed: `list: ${error.message}` };

  const { originals, copies } = selectForRemoval((data ?? []) as GarbageRow[], scope);
  // Public copies first: they are the ones a stranger could fetch.
  const a = await removeStyleObjects(service, STYLE_GALLERY_BUCKET, copies);
  const b = await removeStyleObjects(service, STYLE_PHOTO_BUCKET, originals);
  return {
    candidates: originals.length + copies.length,
    removed: a.removed + b.removed,
    failed: a.failed ?? b.failed,
  };
}
