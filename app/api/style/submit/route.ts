import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { isSameOrigin } from "@/lib/sameOrigin";
import { LINK_HELP, parseStyleLink } from "@/lib/styleMedia";
import {
  STYLE_GALLERY_CACHE_CONTROL,
  STYLE_PHOTO_BUCKET,
  STYLE_PHOTO_MAX_BYTES,
  isUuid,
  stylePhotoPath,
} from "@/lib/stylePhotoStorage";
import { StylePhotoRejected, normalizeStylePhoto } from "@/lib/stylePhotoValidate";

/**
 * "Share your style" — the one way a customer's photograph gets stored (0073).
 *
 * The browser cannot write to either style bucket; this route does it, in this
 * order, and stops at the first refusal:
 *
 *   1. same-origin, and a signed-in customer (from the session, never the body);
 *   2. style_photo_upload_allowed(product) with THEIR session — a verified
 *      purchase of that piece, and fewer than five files for it — before any
 *      effort is spent on the bytes;
 *   3. at most 4 MiB, a JPEG by its own signature, decodable, re-encoded fresh
 *      (lib/stylePhotoValidate);
 *   4. stored in the PRIVATE bucket at a name this route makes up;
 *   5. the submission saved with THEIR session, so RLS, has_purchased and
 *      0073's trigger all judge it exactly as before;
 *   6. if step 5 fails, the file from step 4 is removed before replying. A
 *      resubmission's previous original is removed once the new one is saved.
 *
 * Only a request that dies between 4 and 6 leaves a file behind; it is unused,
 * private, and the queue's backstop sweep removes it after an hour.
 */
export const runtime = "nodejs";
export const maxDuration = 30;

sharp.cache(false);
sharp.concurrency(1);

const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return fail(403, "Not allowed.");

  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail(401, "Please sign in again — your session has expired.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "That didn't arrive properly. Please try again.");
  }

  const text = (key: string) => {
    const v = form.get(key);
    return typeof v === "string" ? v.trim() : "";
  };
  const productId = text("product_id");
  const existingId = text("existing_id") || null;
  if (!isUuid(productId) || (existingId && !isUuid(existingId))) return fail(400, "Unknown piece.");
  if (text("consent") !== "yes") return fail(400, "We need your permission before we can show it.");

  const rawLink = text("link");
  const link = rawLink ? parseStyleLink(rawLink) : null;
  if (rawLink && !link) return fail(400, LINK_HELP);

  const file = form.get("photo");
  const photo = file instanceof File && file.size > 0 ? file : null;
  if (!photo && !link) return fail(400, "Add a photograph or a link first.");

  const service = createServiceClient();
  let stored: { path: string; width: number; height: number } | null = null;

  if (photo) {
    if (photo.size > STYLE_PHOTO_MAX_BYTES) return fail(413, "That photograph is too large. Please choose it again.");

    const { data: allowed, error: allowedError } = await supabase.rpc("style_photo_upload_allowed", {
      p_product: productId,
    });
    if (allowedError || allowed !== true) {
      return fail(403, "Only a delivered purchase can be shared, and only a few photographs per piece.");
    }

    let normalized;
    try {
      normalized = await normalizeStylePhoto(new Uint8Array(await photo.arrayBuffer()));
    } catch (e) {
      return fail(415, e instanceof StylePhotoRejected ? e.message : "That photograph couldn't be read.");
    }

    const path = stylePhotoPath(user.id, productId, randomUUID());
    const { error: uploadError } = await service.storage.from(STYLE_PHOTO_BUCKET).upload(path, normalized.jpeg, {
      contentType: "image/jpeg",
      cacheControl: STYLE_GALLERY_CACHE_CONTROL,
      upsert: false,
    });
    if (uploadError) {
      console.error(`style submit ${user.id}: store failed — ${uploadError.message}`);
      return fail(502, "We couldn't store that photograph just now. Please try again.");
    }
    stored = { path, width: normalized.width, height: normalized.height };
  }

  const shared = {
    photo_width: stored?.width ?? null,
    photo_height: stored?.height ?? null,
    video_platform: link?.platform ?? null,
    video_url: link?.url ?? null,
    caption: text("caption") || null,
    credit_name: text("credit_name") || null,
  };

  let submissionId: string | null = existingId;
  let previousPath: string | null = null;
  try {
    if (existingId) {
      // Their own row (RLS); its old original goes once the new one is saved.
      const { data: before } = await supabase
        .from("style_submissions")
        .select("photo_path")
        .eq("id", existingId)
        .maybeSingle();
      previousPath = (before?.photo_path as string | null) ?? null;

      // A second INSERT is refused by the one-per-customer-per-product index,
      // so a replacement goes through resubmit_style — which also puts it back
      // in front of an admin and clears the old rejection.
      const { data: done, error } = await supabase.rpc("resubmit_style", {
        p_id: existingId,
        p_photo_path: stored?.path ?? null,
        p_photo_width: shared.photo_width,
        p_photo_height: shared.photo_height,
        p_video_platform: shared.video_platform,
        p_video_url: shared.video_url,
        p_caption: shared.caption,
        p_credit_name: shared.credit_name,
      });
      if (error) throw new Error(error.message);
      if (done !== true) throw new Error("We couldn't find that submission.");
    } else {
      const { data: inserted, error } = await supabase
        .from("style_submissions")
        .insert({
          product_id: productId,
          user_id: user.id,
          photo_path: stored?.path ?? null,
          ...shared,
          // The moment permission was given, recorded as a fact rather than
          // inferred later from the row existing.
          consented_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      submissionId = (inserted?.id as string) ?? null;
    }
  } catch (e) {
    // Saved nothing, so keep nothing.
    if (stored) await service.storage.from(STYLE_PHOTO_BUCKET).remove([stored.path]);
    const message = e instanceof Error ? e.message : "Something went wrong.";
    return fail(
      400,
      // The database's own words are usually right — 0053 raises sentences on
      // purpose — but a duplicate-key error is machine noise.
      /duplicate key|already exists/i.test(message)
        ? "You've already shared a photograph of this piece. We'll be in touch about it."
        : message
    );
  }

  if (previousPath && previousPath !== stored?.path && previousPath.startsWith(`${user.id}/`)) {
    const { error } = await service.storage.from(STYLE_PHOTO_BUCKET).remove([previousPath]);
    if (error) console.error(`style submit ${user.id}: old original not removed yet — ${error.message}`);
  }

  return NextResponse.json({ ok: true, id: submissionId });
}
