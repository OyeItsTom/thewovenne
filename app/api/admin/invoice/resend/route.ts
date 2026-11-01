import { adminApiGate } from "@/lib/adminApiGate";
import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createRSCClient } from "@/lib/supabaseRSC";
import InvoiceDocument from "@/components/invoice/InvoiceDocument";
import { buildInvoice, INVOICE_SELECT } from "@/lib/invoice";
import { sendEmail } from "@/lib/email";
import { deliverInvoiceEmail, resendDecision, resendHttpStatus, type ResendOrderRow } from "@/lib/invoiceEmail";

/**
 * Send an already-issued invoice to the customer again.
 *
 * RE-RENDERS RATHER THAN STORING. The order is the source of the document, so
 * a resend produces exactly what the original download produces — there is no
 * archived copy that could have drifted from the order it describes.
 *
 * Nothing here reissues or renumbers anything. A resent invoice is the same
 * invoice; the sequence is untouched.
 *
 * ELIGIBILITY (WP-EMAIL-E4, lib/invoiceEmail resendDecision): the order must
 * have an invoice number, be paid (as the customer's own download requires)
 * and have an address. A cancelled order is resent only if credit notes exist
 * against it, and the email then says it was cancelled and names them. With
 * no credit note it is refused: an invoice alone would read as a live sale.
 * Credit notes are read, never created.
 *
 * Reads go through the admin's own session, so RLS (admin read on orders and
 * credit_notes) is what serves the data.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const ended = await adminApiGate(request);
  if (ended) return ended;

  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const { orderId } = ((await request.json().catch(() => ({}))) ?? {}) as { orderId?: unknown };
  if (typeof orderId !== "string" || !orderId) {
    return NextResponse.json({ error: "No order given." }, { status: 400 });
  }

  // `status` is read alongside, not added to INVOICE_SELECT, so the PDF's
  // input is exactly what it was.
  const { data, error } = await supabase
    .from("orders")
    .select(`${INVOICE_SELECT}, status`)
    .eq("id", orderId)
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json({ error: "That order could not be found." }, { status: 404 });
  }
  const row = data as unknown as ResendOrderRow;

  const { data: notes, error: notesError } = await supabase
    .from("credit_notes")
    .select("credit_note_number, issued_at")
    .eq("order_id", orderId)
    .order("issued_at", { ascending: true });
  if (notesError) console.error(`invoice resend ${orderId}: credit notes unreadable — ${notesError.message}`);

  const decision = resendDecision(
    row,
    notesError ? null : ((notes ?? []) as { credit_note_number: string }[]).map((n) => n.credit_note_number)
  );
  if (!decision.ok) {
    return NextResponse.json({ error: decision.error }, { status: decision.httpStatus });
  }

  const invoice = buildInvoice(data as unknown as Parameters<typeof buildInvoice>[0]);
  const outcome = await deliverInvoiceEmail(
    {
      invoice,
      kind: "copy",
      cancelled: decision.cancelled,
      creditNoteNumbers: decision.creditNoteNumbers,
    },
    {
      send: sendEmail,
      renderPdf: async (inv) => renderToBuffer(InvoiceDocument({ data: inv })),
    }
  );

  // Surfaced rather than swallowed: a resend is something an admin asked for
  // and is waiting on, so silence would read as success.
  if (outcome.status !== "accepted") {
    return NextResponse.json({ error: outcome.message, status: outcome.status }, { status: resendHttpStatus(outcome.status) });
  }
  return NextResponse.json({ ok: true, status: outcome.status, message: outcome.message });
}
