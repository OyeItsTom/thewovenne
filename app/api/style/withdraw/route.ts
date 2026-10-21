import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { isSameOrigin } from "@/lib/sameOrigin";
import { isUuid, removeGalleryCopies, sweepStylePhotos } from "@/lib/stylePhotoStorage";

/**
 * A customer takes their photograph down — the record and the files together.
 *
 * Withdrawal is still the one UPDATE a customer may make themselves (0047),
 * made here with THEIR session, so RLS decides whose row it is.
 *
 * THE PUBLIC COPY GOES FIRST. Once the row is confirmed as theirs (read with
 * their session), its public copy is removed, THEN the withdrawal is recorded —
 * 0073's trigger clears the public address in that statement — and then the
 * scoped sweep removes the private original. So there is no moment where the
 * page says "taken down" while the file is still being served; Supabase's CDN
 * and browsers may hold it for about a minute more (STYLE_GALLERY_CACHE_CONTROL).
 * Only this customer's own files can be reached: their folder, this submission.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ ok: false }, { status: 403 });

  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  if (!isUuid(id)) return NextResponse.json({ ok: false }, { status: 400 });

  const { data: own } = await supabase
    .from("style_submissions")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!own) return NextResponse.json({ ok: false }, { status: 404 });

  const service = createServiceClient();
  const down = await removeGalleryCopies(service, [id]);
  if (down.failed) console.error(`style withdraw ${id}: ${down.failed}`);

  const { data: rows, error } = await supabase
    .from("style_submissions")
    .update({ withdrawn_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id");
  if (error || !rows?.length) return NextResponse.json({ ok: false }, { status: 404 });

  const sweep = await sweepStylePhotos(service, { ownerId: user.id, submissionIds: [id] });
  // Withdrawn either way: the public view hides it already. A file that did not
  // go is named again by the next sweep.
  if (sweep.failed) console.error(`style withdraw ${id}: ${sweep.failed}`);
  return NextResponse.json({ ok: true, removed: down.removed + sweep.removed });
}
