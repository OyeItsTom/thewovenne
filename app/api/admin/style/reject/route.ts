import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { sendEmail } from "@/lib/email";
import {
  styleRejectedHtml,
  styleRejectedSubject,
  styleRejectedText,
} from "@/lib/emails/styleRejected";

/**
 * Turn a submission down, and tell the customer why.
 *
 * WHY A ROUTE. moderate_style() could be called straight from the browser — the
 * approve path does exactly that. Rejection cannot, because a browser cannot
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
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
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

  const { error: rpcError } = await supabase.rpc("moderate_style", {
    p_id: id,
    p_status: "rejected",
    p_reason: trimmed,
  });
  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 400 });
  }

  // ── Tell them ──────────────────────────────────
  // Past this point the decision is recorded. A failure here is reported and
  // never thrown: an admin who is told "that failed" after the submission was
  // already rejected would press it again, and the customer would get two
  // emails about one photograph.
  let emailed = false;
  let problem: string | null = null;

  try {
    const { data: queue } = await supabase.rpc("admin_style_submissions");
    const row = ((queue ?? []) as { id: string; customer_email: string | null; customer_name: string | null; product_name: string | null }[])
      .find((r) => r.id === id);

    if (!row?.customer_email) {
      problem = "That customer has no email address on file, so nobody was told.";
    } else {
      const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://www.thewovenne.com";
      const sent = await sendEmail({
        to: row.customer_email,
        subject: styleRejectedSubject(row.product_name ?? "your piece"),
        html: styleRejectedHtml({
          customerName: row.customer_name || "there",
          productName: row.product_name ?? "your piece",
          reason: trimmed,
          ordersUrl: `${site}/in/account/orders`,
        }),
        text: styleRejectedText({
          customerName: row.customer_name || "there",
          productName: row.product_name ?? "your piece",
          reason: trimmed,
          ordersUrl: `${site}/in/account/orders`,
        }),
      });
      emailed = sent.ok;
      if (!sent.ok) problem = sent.error ?? "The email provider refused that message.";
    }

    if (emailed) {
      // Stamped only after Resend accepts, which is what makes a retry safe: the
      // queue shows an unstamped rejection as still owing a message.
      const { error: stampError } = await supabase
        .from("style_submissions")
        .update({ rejection_emailed_at: new Date().toISOString() })
        .eq("id", id);
      if (stampError) {
        console.error(`style reject ${id}: sent but not stamped — ${stampError.message}`);
        problem = "The customer was emailed, but we could not record that. Do not send it again.";
      }
    }
  } catch (e) {
    console.error(`style reject ${id}: telling the customer failed`, e);
    problem = "It was turned down, but the email did not send.";
  }

  return NextResponse.json({ ok: true, emailed, problem });
}
