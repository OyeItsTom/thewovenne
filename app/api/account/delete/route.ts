import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
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
 * not, and files can only be removed through the Storage API (0073). So once
 * the database says the account is gone, the service key removes what
 * style_photo_garbage() now names inside THAT account's folder — and only
 * there (selectForRemoval). If Storage is down the account is still deleted;
 * the queue's backstop sweep finds the same files ("owner gone") and finishes.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Same site, and said so. A form on another site would carry its own Origin;
  // a request with none is not one our page makes.
  const origin = request.headers.get("origin");
  let sameSite = false;
  try {
    sameSite = !!origin && new URL(origin).host === new URL(request.url).host;
  } catch {
    // "null" or garbage: not us.
  }
  if (!sameSite) return NextResponse.json({ ok: false, reason: "Not allowed." }, { status: 403 });

  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "You need to be logged in." }, { status: 401 });

  const { data, error } = await supabase.rpc("delete_my_account");
  if (error) return NextResponse.json({ ok: false, reason: error.message });
  const result = data as { ok: boolean; reason?: string };
  if (!result?.ok) return NextResponse.json(result ?? { ok: false });

  const sweep = await sweepStylePhotos(createServiceClient(), { onlyOwnerId: user.id });
  if (sweep.failed) {
    // The account is gone either way; the backstop sweep removes what is left.
    console.error(`account delete ${user.id}: style photos not removed yet — ${sweep.failed}`);
  }

  return NextResponse.json({ ok: true });
}
