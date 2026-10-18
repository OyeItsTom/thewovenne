import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Where customers' style photographs live, and how they are taken away.
 *
 * The database decides WHAT may be uploaded and WHAT should go (migration 0073:
 * style_photo_upload_allowed, style_photo_garbage). It cannot do the removing:
 * storage.protect_delete refuses SQL deletes, because a row deleted that way
 * leaves the file behind in the object store. So the removing happens here,
 * through the Storage API: after an account is deleted (/api/account/delete),
 * after a customer withdraws (/api/style/cleanup), when an admin deletes a
 * submission (StyleManager, with the admin's own storage permission), and as a
 * backstop whenever an admin opens the style queue (/api/admin/style/sweep).
 */
export const STYLE_PHOTO_BUCKET = "style-photos";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The only shape 0073 lets anybody upload: <owner>/<product>/<uuid>.jpg */
const NAME = new RegExp(`^(${UUID})/(${UUID})/${UUID}\\.jpg$`);

/** The object key a customer's upload must use. */
export function stylePhotoPath(ownerId: string, productId: string, fileId: string): string {
  return `${ownerId}/${productId}/${fileId}.jpg`;
}

/**
 * The object key inside a photo_url, or null if the URL is not this project's
 * style-photos address. 0073 guarantees a submission's photo_url has exactly
 * this shape, so null means there is no file of ours to remove.
 */
export function stylePhotoNameFromUrl(url: string | null, supabaseUrl: string): string | null {
  if (!url) return null;
  const base = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${STYLE_PHOTO_BUCKET}/`;
  if (!url.startsWith(base)) return null;
  const name = url.slice(base.length);
  return NAME.test(name) ? name : null;
}

export interface GarbageRow {
  name: string;
  reason: string;
}

/**
 * Which of the database's garbage names may actually be removed.
 *
 * A second lock on top of the function that produced them: only names of the
 * shape 0073 allows, and — when one account is being cleaned up — only names
 * inside that account's own folder. Deleting one person's photographs must
 * never be able to reach anyone else's.
 */
export function selectForRemoval(rows: GarbageRow[], onlyOwnerId?: string): string[] {
  const owner = onlyOwnerId?.toLowerCase();
  return rows
    .map((r) => r.name)
    .filter((name) => {
      const m = NAME.exec(name);
      if (!m) return false;
      return owner ? m[1] === owner : true;
    });
}

export interface SweepResult {
  candidates: number;
  removed: number;
  failed: string | null;
}

/** Remove what style_photo_garbage() names. Never throws; reports instead. */
export async function sweepStylePhotos(
  service: SupabaseClient,
  opts: { onlyOwnerId?: string } = {}
): Promise<SweepResult> {
  const { data, error } = await service.rpc("style_photo_garbage");
  if (error) return { candidates: 0, removed: 0, failed: `list: ${error.message}` };

  const names = selectForRemoval((data ?? []) as GarbageRow[], opts.onlyOwnerId);
  let removed = 0;
  // Storage's remove takes a list; a hundred at a time keeps each request small.
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const { data: gone, error: removeError } = await service.storage
      .from(STYLE_PHOTO_BUCKET)
      .remove(batch);
    if (removeError) {
      return { candidates: names.length, removed, failed: `remove: ${removeError.message}` };
    }
    removed += gone?.length ?? 0;
  }
  return { candidates: names.length, removed, failed: null };
}
