import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { sweepStylePhotos } from "@/lib/stylePhotoStorage";

/**
 * Remove the signed-in customer's own style photographs that should go (0073).
 *
 * Called after they withdraw consent, so the file leaves the public URL at once
 * rather than when somebody next sweeps. It can only ever reach the caller's
 * own folder — the id comes from the session, never the request, and
 * selectForRemoval refuses anything outside it — and only what
 * style_photo_garbage() already names. Calling it more often removes nothing
 * extra.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  let sameSite = false;
  try {
    sameSite = !!origin && new URL(origin).host === new URL(request.url).host;
  } catch {
    // "null" or garbage: not us.
  }
  if (!sameSite) return NextResponse.json({ ok: false }, { status: 403 });

  const {
    data: { user },
  } = await createRSCClient().auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const result = await sweepStylePhotos(createServiceClient(), { onlyOwnerId: user.id });
  if (result.failed) console.error(`style cleanup ${user.id}: ${result.failed}`);
  return NextResponse.json({ ok: !result.failed, removed: result.removed });
}
