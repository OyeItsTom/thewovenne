import { supabase } from "./supabase";

const BUCKET = "product-images";

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

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
