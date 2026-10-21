import { adminApiGate } from "@/lib/adminApiGate";
import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { STYLE_PHOTO_BUCKET, isUuid, removeGalleryCopies, sweepStylePhotos } from "@/lib/stylePhotoStorage";

/**
 * Delete a submission entirely, with its files (0073).
 *
 * The public copy is removed FIRST (removeGalleryCopies — see there for why
 * that order), then the row is deleted with the ADMIN'S session ("Admins
 * moderate style", 0047), then the private original is removed by name — it
 * would otherwise wait an hour as "unused" — and the sweep catches anything a
 * race left. No customer can reach this: adminApiGate and is_admin().
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const ended = await adminApiGate(request);
  if (ended) return ended;

  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  if (!isUuid(id)) return NextResponse.json({ error: "Unknown request." }, { status: 400 });

  const service = createServiceClient();
  const down = await removeGalleryCopies(service, [id]);

  const { data: rows, error } = await supabase
    .from("style_submissions")
    .delete()
    .eq("id", id)
    .select("photo_path");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!rows?.length) return NextResponse.json({ error: "That submission is gone." }, { status: 404 });

  const original = rows[0].photo_path as string | null;
  let problem: string | null = down.failed;
  if (original) {
    const { error: removeError } = await service.storage.from(STYLE_PHOTO_BUCKET).remove([original]);
    if (removeError) problem = removeError.message;
  }
  const sweep = await sweepStylePhotos(service);
  problem = problem ?? sweep.failed;
  if (problem) console.error(`style delete ${id}: ${problem}`);
  return NextResponse.json({ ok: true, cleanupPending: Boolean(problem) });
}
