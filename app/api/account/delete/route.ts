import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { isSameOrigin } from "@/lib/sameOrigin";
import { sweepStylePhotos } from "@/lib/stylePhotoStorage";

/**
 * Delete the signed-in customer's account, then their stored photographs.
 *
 * THE DELETION ITSELF IS UNCHANGED: delete_my_account() (0033), called with the
 * customer's own session, so auth.uid() decides whose account it is and every
 * refusal it already makes — staff, an order still on its way — still applies.
 * Nothing about who is deleted is read from the request.
 *
 * WHY A ROUTE. The account's database rows cascade; its files in Storage do
 * not, and files can only be removed through the Storage API (0073). So the
 * route notes the customer's submission ids first, and once the database says
 * the account is gone, the service key removes what style_photo_garbage() now
 * names — private originals ("owner gone") and public copies ("submission
 * gone") — limited to THAT customer's folder and submissions
 * (selectForRemoval). If Storage is down the account is still deleted; the
 * queue's backstop sweep finds the same files and finishes.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ ok: false, reason: "Not allowed." }, { status: 403 });

  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "You need to be logged in." }, { status: 401 });

  // Read while the rows still exist: their public copies are named by id.
  const { data: mine } = await supabase.from("style_submissions").select("id").eq("user_id", user.id);
  const submissionIds = (mine ?? []).map((r) => r.id as string);

  const { data, error } = await supabase.rpc("delete_my_account");
  if (error) return NextResponse.json({ ok: false, reason: error.message });
  const result = data as { ok: boolean; reason?: string };
  if (!result?.ok) return NextResponse.json(result ?? { ok: false });

  const sweep = await sweepStylePhotos(createServiceClient(), { ownerId: user.id, submissionIds });
  if (sweep.failed) {
    // The account is gone either way; the backstop sweep removes what is left.
    console.error(`account delete ${user.id}: style photos not removed yet — ${sweep.failed}`);
  }

  return NextResponse.json({ ok: true });
}
