import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createRSCClient } from "@/lib/supabaseRSC";
import CreditNoteDocument from "@/components/invoice/CreditNoteDocument";
import {
  buildCreditNote,
  CREDIT_NOTE_ORDER_SELECT,
  type CreditNoteOrderRow,
  type CreditNoteRow,
} from "@/lib/creditNote";
import { sendEmail } from "@/lib/email";
import { isOffline } from "@/lib/paymentMethods";
import { orderRef } from "@/lib/orders";
import {
  orderCancelledHtml,
  orderCancelledSubject,
  orderCancelledText,
} from "@/lib/emails/orderCancelled";
import type { OrderEmailItem } from "@/lib/emails/orderConfirmation";

/**
 * Cancel an order, and tell the customer.
 *
 * WHY THIS ROUTE EXISTS AT ALL. The Orders screen used to call cancel_order()
 * straight from the browser, which did everything the books need — credit note,
 * stock, status, timestamp — and nothing the customer needs. They had been sent
 * a confirmation and an invoice, and then heard nothing: the first sign would
 * have been a parcel that never arrived. Email cannot be sent from a browser,
 * so the call moves here and the email happens where the cancellation does.
 *
 * THE CALLER'S OWN SESSION, NOT THE SERVICE KEY. cancel_order() is gated on
 * is_admin() and stamps issued_by from auth.uid(); with the service key
 * auth.uid() is null, so the function would refuse and, if it did not, the
 * credit note would not say who issued it. The admin check below is therefore
 * about the reply — 404 rather than a Postgres error — while the database
 * remains what authorises the cancellation.
 *
 * THE EMAIL IS NEVER FATAL. By the time it is attempted the cancellation has
 * happened: a credit note is issued, stock is back, the order is marked. Failing
 * the request would tell an admin the cancellation had not gone through when it
 * had, and a second press would be refused as already-cancelled. So the outcome
 * of the email is reported back and shown, not thrown.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const { orderId, reason } = (await request.json()) as {
    orderId?: string;
    reason?: string | null;
  };
  if (!orderId) {
    return NextResponse.json({ error: "No order given." }, { status: 400 });
  }

  const trimmedReason = reason?.trim() || null;

  const { data: result, error: rpcError } = await supabase.rpc("cancel_order", {
    p_order_id: orderId,
    p_reason: trimmedReason,
  });

  if (rpcError) {
    // The function raises for every refusal that matters — not paid, already
    // cancelled, not an admin — and its wording is written to be read, so it is
    // passed through rather than replaced with something vaguer.
    return NextResponse.json({ error: rpcError.message }, { status: 400 });
  }

  const outcome = result as {
    credit_note?: CreditNoteRow;
    stock_returned?: boolean;
    stock_note?: string | null;
  } | null;

  const note = outcome?.credit_note ?? null;

  // ── Tell the customer ──────────────────────────
  let emailed = false;
  let emailProblem: string | null = null;

  try {
    const { data: orderRow } = await supabase
      .from("orders")
      // payment_method is already in CREDIT_NOTE_ORDER_SELECT; items is not,
      // because a credit note prints its own snapshot and the email prints the
      // order's.
      .select(`${CREDIT_NOTE_ORDER_SELECT}, items`)
      .eq("id", orderId)
      .maybeSingle();

    const order = orderRow as unknown as
      | (CreditNoteOrderRow & { items: OrderEmailItem[] | null })
      | null;

    if (!note) {
      emailProblem = "No credit note came back, so nothing was sent.";
    } else if (!order?.customer_email) {
      // Routine, not a fault: a stall sale can be recorded against a phone
      // number, and an anonymised order (0033) has no address by design.
      emailProblem = "That order has no email address, so nobody was told.";
    } else {
      const data = buildCreditNote(note, order);
      const pdf = data ? await renderToBuffer(CreditNoteDocument({ data })) : null;

      const payload = {
        orderRef: orderRef(orderId),
        customerName: order.customer_name || "there",
        items: Array.isArray(order.items) ? order.items : [],
        amount: Number(note.amount_inr ?? 0),
        creditNoteNumber: note.credit_note_number,
        invoiceNumber: note.invoice_number,
        reason: trimmedReason,
        paidInPerson: isOffline(order.payment_method),
      };

      const sent = await sendEmail({
        to: order.customer_email,
        subject: orderCancelledSubject(payload.orderRef),
        html: orderCancelledHtml(payload),
        text: orderCancelledText(payload),
        attachments: pdf
          ? [
              {
                filename: `${note.credit_note_number}.pdf`,
                content: Buffer.from(pdf).toString("base64"),
              },
            ]
          : undefined,
      });

      emailed = sent.ok;
      if (!sent.ok) {
        emailProblem = sent.error ?? "The email provider refused that message.";
      }
    }
  } catch (e) {
    console.error(`Cancel ${orderId}: telling the customer failed`, e);
    emailProblem = "The cancellation went through, but the email did not send.";
  }

  return NextResponse.json({
    ok: true,
    creditNoteNumber: note?.credit_note_number ?? null,
    creditNoteId: note?.id ?? null,
    amount: Number(note?.amount_inr ?? 0),
    stockReturned: outcome?.stock_returned ?? false,
    stockNote: outcome?.stock_note ?? null,
    emailed,
    emailProblem,
  });
}
