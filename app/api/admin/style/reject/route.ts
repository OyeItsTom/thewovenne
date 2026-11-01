import { adminApiGate } from "@/lib/adminApiGate";
import { isSameOrigin } from "@/lib/sameOrigin";
import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { removeGalleryCopies, sweepStylePhotos } from "@/lib/stylePhotoStorage";
import { sendEmail } from "@/lib/email";
import { sendClaimedRejection, type BeginResult, type Claim, type NoticeReport } from "@/lib/styleRejectionNotice";

/**
 * Turn a submission down, and tell the customer why.
 *
 * WHY A ROUTE. moderate_style() could be called straight from the browser.
 * Rejection cannot, because a browser cannot
 * send email, and the whole decision recorded in 0052 was that a customer hears
 * the reason. Keeping the two together means a rejection cannot be recorded
 * without the message going out, or the message going out for something that was
 * not recorded.
 *
 * THE ADMIN'S OWN SESSION, NOT THE SERVICE KEY. moderate_style is gated on
 * is_admin() and stamps reviewed_by from auth.uid(); with the service key
 * auth.uid() is null, so the function would refuse and — if it did not — nobody
 * would know who made the decision.
 *
 * SILENT REJECTION DOES NOT COME THROUGH HERE. Spam is turned down from the
 * browser with no reason, which sends nothing. This route exists for the case
 * where somebody is owed an explanation, so it refuses a request without one
 * rather than quietly doing the silent thing under a name that promises a
 * message.
 *
 * AT MOST ONE EMAIL PER REJECTION (0076, WP-EMAIL-E5 Stage B). moderate_style
 * records the rejection and, in the same transaction, one notification intent
 * for this rejection round; repeating the same rejection changes nothing, and
 * a different reason on an already-rejected submission is refused (409).
 * claim_style_rejection_notice then lets exactly one request proceed;
 * begin_style_rejection_send re-checks eligibility immediately before the
 * provider call (withdrawn / resubmitted / moved → recorded as skipped, not
 * sent); the result
 * is recorded as accepted, failed (may be tried again) or uncertain (never
 * resent automatically). Only "accepted" sets rejection_emailed_at.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const ended = await adminApiGate(request);
  if (ended) return ended;

  // Only our own admin pages send this: a cross-site form or a request with no
  // (or a malformed) Origin is refused before anything is read, written or
  // emailed. Same order as the other admin POST routes (WP-EMAIL-E5).
  if (!isSameOrigin(request)) return NextResponse.json({ ok: false, error: "Not allowed." }, { status: 403 });

  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const { id, reason } = (await request.json()) as { id?: string; reason?: string };
  const trimmed = reason?.trim();

  if (!id) return NextResponse.json({ error: "No submission given." }, { status: 400 });
  if (!trimmed) {
    return NextResponse.json(
      { error: "A reason is required. To turn something down silently, use the silent option." },
      { status: 400 }
    );
  }

  // If it was on the site, its public copy comes down BEFORE the decision is
  // recorded (see removeGalleryCopies); 0073's trigger then clears its address.
  const service = createServiceClient();
  const down = await removeGalleryCopies(service, [id]);
  if (down.failed) console.error(`style reject ${id}: ${down.failed}`);

  const { data: moderated, error: rpcError } = await supabase.rpc("moderate_style", {
    p_id: id,
    p_status: "rejected",
    p_reason: trimmed,
  });
  if (rpcError) {
    // 0076: an already-rejected submission keeps its reason. Changing it needs
    // the submission moved back to pending first, which starts a new round.
    if (/ALREADY_REJECTED/.test(rpcError.message)) {
      return NextResponse.json(
        { error: "This is already turned down with a different reason. Nothing was changed and no email was sent. Move it back to pending first if the reason must change." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: rpcError.message }, { status: 400 });
  }
  if (moderated !== true) {
    // moderate_style answers false when there is no such submission: nothing
    // was recorded, so nothing is claimed or sent.
    return NextResponse.json({ error: "That submission no longer exists. Nothing was changed and no email was sent." }, { status: 404 });
  }

  // Anything a race left comes down now rather than at the next queue visit.
  const sweep = await sweepStylePhotos(service);
  if (sweep.failed) console.error(`style reject ${id}: ${sweep.failed}`);

  // ── Tell them, at most once ────────────────────
  // Past this point the decision is recorded and is never undone by email.
  // claim_style_rejection_notice (0076) lets exactly one request send for this
  // rejection round; every other request (a double press, a second tab, a
  // retry after an interruption) is told why it did not send.
  let report: NoticeReport;
  try {
    const { data: claim, error: claimError } = await supabase.rpc("claim_style_rejection_notice", { p_id: id });
    if (claimError || !claim) {
      console.error(`style reject ${id}: claim failed — ${claimError?.message ?? "no answer"}`);
      report = {
        emailed: false,
        status: "claim_failed",
        message: "The rejection is recorded, but the notification could not be claimed, so no email was sent.",
      };
    } else {
      report = await sendClaimedRejection(claim as Claim, {
        send: sendEmail,
        begin: async (notice) => {
          const { data, error } = await supabase.rpc("begin_style_rejection_send", { p_notice: notice });
          return { data: (data as BeginResult | null) ?? null, error: error?.message ?? null };
        },
        record: async (notice, outcome, providerId, error) => {
          const { error: recordError } = await supabase.rpc("record_style_rejection_notice", {
            p_notice: notice,
            p_outcome: outcome,
            p_provider_id: providerId,
            p_error: error,
          });
          return { error: recordError?.message ?? null };
        },
      });
    }
  } catch (e) {
    console.error(`style reject ${id}: telling the customer failed`, e);
    report = {
      emailed: false,
      status: "claim_failed",
      message: "The rejection is recorded, but something went wrong before any email was attempted.",
    };
  }

  const emailed = report.emailed;
  const problem = emailed ? null : report.message;
  return NextResponse.json({ ok: true, emailed, problem, notice: report.status, message: report.message });
}
