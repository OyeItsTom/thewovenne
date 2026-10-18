import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { isSameOrigin } from "@/lib/sameOrigin";
import { isUuid, sweepStylePhotos } from "@/lib/stylePhotoStorage";

/**
 * A customer takes their photograph down — the record and the files together.
 *
 * Withdrawal is still the one UPDATE a customer may make themselves (0047),
 * made here with THEIR session, so RLS decides whose row it is. 0073's trigger
 * clears the public address in the same statement; this route then removes the
 * public copy and the private original before replying, so "taken down" is
 * true when the page says it. Only this customer's own files can be reached:
 * the scope is their folder and this one submission.
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

  const { data: rows, error } = await supabase
    .from("style_submissions")
    .update({ withdrawn_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id");
  if (error || !rows?.length) return NextResponse.json({ ok: false }, { status: 404 });

  const sweep = await sweepStylePhotos(createServiceClient(), { ownerId: user.id, submissionIds: [id] });
  // Withdrawn either way: the public view hides it already. A file that did not
  // go is named again by the next sweep.
  if (sweep.failed) console.error(`style withdraw ${id}: ${sweep.failed}`);
  return NextResponse.json({ ok: true, removed: sweep.removed });
}
