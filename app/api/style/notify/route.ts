import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { sendEmail } from "@/lib/email";
import {
  styleSubmittedHtml,
  styleSubmittedSubject,
  styleSubmittedText,
} from "@/lib/emails/styleSubmitted";

/**
 * Tell the shop a photograph has arrived.
 *
 * CALLED BY THE CUSTOMER'S BROWSER, right after their submission is saved,
 * because there is no other server moment in the flow — the submission itself is
 * an INSERT under RLS. That makes this endpoint reachable by anybody signed in,
 * so it is written as though it were: it holds no opinion about who is calling
 * and asks the database to prove there is something to announce.
 *
 * claim_style_notification (0055) is what makes that safe. It stamps and reads
 * the row in one statement, and only if the row belongs to auth.uid(), is still
 * pending, and has not been claimed. A caller with nothing to announce gets null
 * and this route sends nothing — so hammering it produces one email at most,
 * which is the same email the honest path produces.
 *
 * THE SUBMISSION IS ALREADY SAVED BY THE TIME THIS RUNS. Nothing here may report
 * failure in a way that makes a customer think their photograph was lost: every
 * outcome below returns 200 with a flag the form ignores. The customer is not
 * waiting on the shop's mail.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Not found", { status: 404 });

  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id) return NextResponse.json({ notified: false, reason: "no id" }, { status: 400 });

  // Claims it, or returns null because it is not theirs, not pending, or
  // somebody already announced it.
  const { data: claim, error: claimError } = await supabase.rpc(
    "claim_style_notification",
    { p_id: id }
  );

  if (claimError) {
    console.error(`style notify ${id}: claim failed — ${claimError.message}`);
    return NextResponse.json({ notified: false, reason: "claim failed" });
  }
  if (!claim) {
    // The ordinary case for a repeat call. Not an error, and not logged as one.
    return NextResponse.json({ notified: false, reason: "nothing to announce" });
  }

  const details = claim as {
    product_name: string;
    caption: string | null;
    credit_name: string | null;
    has_photo: boolean;
    video_platform: string | null;
  };

  // ── Who to tell ────────────────────────────────
  // Every admin, read with the service key: this runs under a CUSTOMER's
  // session, and their session must never be able to read other people's
  // profiles. The addresses stay on the server — the response below says only
  // whether something was sent, never to whom.
  const admin = createServiceClient();
  const { data: admins, error: adminError } = await admin
    .from("profiles")
    .select("email")
    .eq("is_admin", true);

  const recipients = (admins ?? [])
    .map((a: { email: string | null }) => a.email?.trim())
    .filter((e): e is string => !!e && e.includes("@"));

  if (adminError || recipients.length === 0) {
    console.error(
      `style notify ${id}: no admin address to write to — ${adminError?.message ?? "none on file"}`
    );
    await releaseQuietly(supabase, id);
    return NextResponse.json({ notified: false, reason: "no recipients" });
  }

  const site =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://www.thewovenne.com";
  const payload = {
    productName: details.product_name,
    creditName: details.credit_name,
    caption: details.caption,
    hasPhoto: details.has_photo,
    videoPlatform: details.video_platform,
    queueUrl: `${site}/admin/dashboard/style`,
  };

  // One message to all admins. Three separate sends would be three chances to
  // half-fail, and there is nothing per-recipient in it.
  const sent = await sendEmail({
    to: recipients.join(", "),
    subject: styleSubmittedSubject(details.product_name),
    html: styleSubmittedHtml(payload),
    text: styleSubmittedText(payload),
  });

  if (!sent.ok) {
    // Put the claim back. A stamp with no email behind it is worse than no
    // stamp: the queue would show this as announced and nobody would know it
    // never went.
    console.error(`style notify ${id}: send failed — ${sent.error}`);
    await releaseQuietly(supabase, id);
    return NextResponse.json({ notified: false, reason: "send failed" });
  }

  return NextResponse.json({ notified: true });
}

/**
 * Undo the claim, and never make things worse by throwing while doing it. If
 * this fails too, the row stays stamped and the log is the only trace — which is
 * why the failure is logged loudly rather than swallowed.
 */
async function releaseQuietly(
  supabase: ReturnType<typeof createRSCClient>,
  id: string
): Promise<void> {
  const { error } = await supabase.rpc("release_style_notification", { p_id: id });
  if (error) {
    console.error(
      `style notify ${id}: could not release the claim — the queue will show this as announced when it was not (${error.message})`
    );
  }
}
