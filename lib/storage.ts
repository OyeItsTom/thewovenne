import { getBrowserSupabase } from "./supabase";
import { MAX_INPUT_BYTES, STAGING_CACHE_CONTROL } from "./imageNormalize";

const BUCKET = "product-images";

/** The browser refuses the obviously-too-large before spending the upload. */
const MAX_UPLOAD_BYTES = MAX_INPUT_BYTES;

/**
 * Formats browsers can actually render. HEIC/HEIF is the iPhone default and is
 * the reason this list exists: Safari displays it, Chrome/Firefox/Edge do not,
 * and Next's image optimizer passes it through untouched — so it uploads and
 * saves cleanly, then shows as a broken image for most visitors.
 */
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "avif", "gif"];
const REJECTED_EXTENSIONS = ["heic", "heif"];

export class UnsupportedImageError extends Error {}

/**
 * Upload an image to Supabase Storage and return its public URL. Runs with the
 * signed-in admin's session (Storage RLS allows admin writes). The bucket is
 * public-read so the storefront can render the image directly.
 *
 * Throws UnsupportedImageError for formats browsers can't display, rather than
 * letting them through to fail silently on the storefront.
 */
export async function uploadImage(file: File, folder = "products"): Promise<string> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const type = file.type.toLowerCase();

  if (REJECTED_EXTENSIONS.includes(ext) || type.includes("heic") || type.includes("heif")) {
    throw new UnsupportedImageError(
      "HEIC photos don't display in Chrome, Firefox or Edge. On iPhone: Settings → Camera → Formats → Most Compatible, or export the photo as JPEG and upload that."
    );
  }

  // Some browsers report an empty type for unusual formats, so check both.
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new UnsupportedImageError(
      `“.${ext}” isn't a supported image format. Use JPEG, PNG or WebP.`
    );
  }

  const path = `${folder}/${crypto.randomUUID()}.${ext}`;

  const { error } = await getBrowserSupabase().storage
    .from(BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false });

  if (error) throw error;

  const { data } = getBrowserSupabase().storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/* ───────────────────────── product images: staged, then normalized ──────── */

/**
 * A product photograph, normalized on the way in.
 *
 * PRODUCTS ONLY, DELIBERATELY. `uploadImage` above still serves the journal,
 * pages, campaigns and the lookbook exactly as before. Those carry logos and
 * graphics where an alpha channel and a lossless format are the point, and
 * sending them down a pipeline tuned for 50-megapixel photographs of cloth would
 * change assets nobody asked to change. When they want it, they can opt in.
 *
 * THE ORIGINAL IS STAGED, NOT KEPT. It goes to `staging/` under a UUID the
 * server will recognise, the route normalizes it into a content-addressed
 * master, and the route deletes the staged copy once the master is proven
 * readable. The 13–27MB original never becomes part of the catalogue's storage.
 *
 * WHAT THE BROWSER CHECKS is only what is cheap and certain: the format the file
 * claims to be, and its size. The real inspection reads the container's own
 * bytes, and that happens on the server where the answer cannot be edited.
 */
export interface NormalizedImage {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

export async function uploadProductImage(file: File): Promise<NormalizedImage> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const type = file.type.toLowerCase();

  if (REJECTED_EXTENSIONS.includes(ext) || type.includes("heic") || type.includes("heif")) {
    throw new UnsupportedImageError(
      "HEIC photos don't display in Chrome, Firefox or Edge. On iPhone: Settings → Camera → Formats → Most Compatible, or export the photo as JPEG and upload that."
    );
  }
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new UnsupportedImageError(
      `“.${ext}” isn't a supported image format. Use JPEG, PNG or WebP.`
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UnsupportedImageError(
      `That photograph is ${(file.size / 1048576).toFixed(0)}MB. Please use one under ${MAX_UPLOAD_BYTES / 1048576}MB.`
    );
  }

  // The server rebuilds this key from the id and extension; it never accepts a
  // path. See lib/imageNormalize.stagingKey.
  const stagingId = crypto.randomUUID();
  const client = getBrowserSupabase();

  const { error: stageError } = await client.storage
    .from(BUCKET)
    .upload(`staging/${stagingId}.${ext}`, file, {
      cacheControl: STAGING_CACHE_CONTROL,
      upsert: false,
    });
  if (stageError) throw stageError;

  const response = await fetch("/api/admin/images/normalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stagingId, ext }),
  });

  if (!response.ok) {
    // The staged original is still in the bucket — the route only deletes it
    // once a master is live — so the admin can simply try again.
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new UnsupportedImageError(
      body?.error ?? "That photograph could not be processed. Please try another photo."
    );
  }

  return (await response.json()) as NormalizedImage;
}
