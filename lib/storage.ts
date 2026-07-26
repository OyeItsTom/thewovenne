import { supabase } from "./supabase";

const BUCKET = "product-images";

/**
 * Upload an image to Supabase Storage and return its public URL. Runs with the
 * signed-in admin's session (Storage RLS allows authenticated writes). The
 * bucket is public-read so the storefront can render the image directly.
 */
export async function uploadImage(file: File, folder = "products"): Promise<string> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
