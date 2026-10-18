import { adminApiGate } from "@/lib/adminApiGate";
import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { sweepStylePhotos } from "@/lib/stylePhotoStorage";

/**
 * Remove every style photograph style_photo_garbage() names (0073).
 *
 * Run whenever an admin opens the style queue — which is when submissions are
 * arriving, and so when leftovers are made. It catches what the immediate paths
 * cannot: an upload whose tab closed before the submission saved (removed once
 * it is a day old), and anything an earlier removal failed on. Account
 * deletion, withdrawal and the admin's own delete each remove their file at the
 * time; this is the backstop, not the mechanism.
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
