import { randomUUID } from "node:crypto";
import { adminApiGate } from "@/lib/adminApiGate";
import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import {
  STYLE_GALLERY_BUCKET,
  STYLE_GALLERY_CACHE_CONTROL,
  STYLE_PHOTO_BUCKET,
  isUuid,
  styleGalleryName,
  sweepStylePhotos,
} from "@/lib/stylePhotoStorage";

/**
 * Put a submission on the site, take it off, or turn it down silently (0073).
 *
 * APPROVING PUBLISHES A COPY. The original stays in the private bucket; the
 * service key copies its bytes into the public style-gallery bucket under a
 * fresh name, and approve_style — with the ADMIN'S session, so is_admin() and
 * reviewed_by are real — records that address. If recording fails, the copy is
 * removed before replying. After recording, the copy is confirmed to exist and
 * made again if a concurrent sweep took it in between.
 *
 * TAKING IT OFF (back to pending) OR A SILENT REJECTION goes through
 * moderate_style as before; 0073's trigger clears the public address, and the
 * sweep that follows removes the copy before this replies.
 *
 * Turning down WITH a reason is /api/admin/style/reject, which also emails.
 */
export const runtime = "nodejs";

type Action = "approve" | "pending" | "rejected";

export async function POST(request: NextRequest) {
  const ended = await adminApiGate(request);
  if (ended) return ended;

  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const { id, action } = (await request.json().catch(() => ({}))) as { id?: unknown; action?: Action };
  if (!isUuid(id) || !["approve", "pending", "rejected"].includes(action as string)) {
    return NextResponse.json({ error: "Unknown request." }, { status: 400 });
  }

  const service = createServiceClient();

  if (action === "approve") {
    const { data: row, error: readError } = await supabase
      .from("style_submissions")
      .select("photo_path")
      .eq("id", id)
      .maybeSingle();
    if (readError || !row) return NextResponse.json({ error: "That submission is gone." }, { status: 404 });

    let copy: { name: string; bytes: Blob } | null = null;
    if (row.photo_path) {
      const { data: bytes, error: getError } = await service.storage.from(STYLE_PHOTO_BUCKET).download(row.photo_path);
      if (getError || !bytes) {
        return NextResponse.json({ error: "Its photograph could not be found, so it cannot be published." }, { status: 409 });
      }
      copy = { name: styleGalleryName(id, randomUUID()), bytes };
      const put = () =>
        service.storage.from(STYLE_GALLERY_BUCKET).upload(copy!.name, copy!.bytes, {
          contentType: "image/jpeg",
          cacheControl: STYLE_GALLERY_CACHE_CONTROL,
          upsert: false,
        });
      const { error: putError } = await put();
      if (putError) return NextResponse.json({ error: `The public copy was not made: ${putError.message}` }, { status: 502 });

      const { error: rpcError } = await supabase.rpc("approve_style", { p_id: id, p_public_name: copy.name });
      if (rpcError) {
        await service.storage.from(STYLE_GALLERY_BUCKET).remove([copy.name]);
        return NextResponse.json({ error: rpcError.message }, { status: 400 });
      }
      const { data: there } = await service.storage.from(STYLE_GALLERY_BUCKET).exists(copy.name);
      if (!there) await put();
    } else {
      const { error: rpcError } = await supabase.rpc("approve_style", { p_id: id, p_public_name: null });
      if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 400 });
    }
  } else {
    const { error: rpcError } = await supabase.rpc("moderate_style", { p_id: id, p_status: action, p_reason: null });
    if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 400 });
  }

  // Anything no longer published comes down now — this submission's old copy
  // included — rather than at the next queue visit.
  const sweep = await sweepStylePhotos(service);
  if (sweep.failed) console.error(`style moderate ${id}: ${sweep.failed}`);
  return NextResponse.json({ ok: true, cleanupPending: Boolean(sweep.failed) });
}
