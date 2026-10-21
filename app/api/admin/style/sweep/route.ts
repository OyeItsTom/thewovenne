import { adminApiGate } from "@/lib/adminApiGate";
import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { sweepStylePhotos } from "@/lib/stylePhotoStorage";

/**
 * Remove every style photograph style_photo_garbage() names (0073), in both
 * buckets.
 *
 * Every action removes its own files at the time: a failed save, a
 * resubmission, withdrawal, rejection, taking it off the site, an admin delete,
 * account deletion. This is the backstop for what those cannot guarantee — a
 * request that died between storing a file and saving the row, a Storage call
 * that failed, or a withdrawal made straight through the API rather than the
 * site. It runs whenever an admin opens the style queue, which is when
 * submissions are arriving.
 *
 * No Vercel cron on purpose: the project keeps none, and two test suites guard
 * that (no vercel.json, no app/api/cron).
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const ended = await adminApiGate(request);
  if (ended) return ended;

  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const result = await sweepStylePhotos(createServiceClient());
  if (result.failed) console.error(`style sweep: ${result.failed}`);
  return NextResponse.json({ ok: !result.failed, ...result });
}
