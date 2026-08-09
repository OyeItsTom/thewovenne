import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createRSCClient } from "@/lib/supabaseRSC";
import CreditNoteDocument from "@/components/invoice/CreditNoteDocument";
import {
  buildCreditNote,
  CREDIT_NOTE_ORDER_SELECT,
  CREDIT_NOTE_SELECT,
  type CreditNoteOrderRow,
  type CreditNoteRow,
} from "@/lib/creditNote";

/**
 * Download one credit note.
 *
 * AUTHORISATION IS THE DATABASE'S, exactly as the invoice route has it. This
 * uses the caller's own session, so 0043's policies decide: an admin reads every
 * credit note, a customer reads the ones against their own orders, anyone else
 * reads nothing. There is deliberately no is_admin() branch — a credit note
 * carries a name and an address, and a hand-written check in a route handler is
 * how one condition gets written wrong and serves someone else's document.
 *
 * A caller who cannot see it gets 404 rather than 403, so the reply does not
 * confirm that a note with that id exists.
 *
 * The order is fetched separately and may legitimately be missing: 0043 sets
 * order_id to null if an order is ever deleted, and 0033 anonymises the customer
 * on request. The number, the amount and the invoice it credits are on the note
 * itself, so it stays a valid financial record either way.
 */
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createRSCClient();

  const { data, error } = await supabase
    .from("credit_notes")
    .select(CREDIT_NOTE_SELECT)
    .eq("id", params.id)
    .maybeSingle();

  if (error) {
    console.error("credit note lookup:", error.message);
    return new NextResponse("Could not load that credit note.", { status: 500 });
  }
  if (!data) return new NextResponse("Not found", { status: 404 });

  const note = data as unknown as CreditNoteRow;

  let order: CreditNoteOrderRow | null = null;
  if (note.order_id) {
    const { data: orderRow } = await supabase
      .from("orders")
      .select(CREDIT_NOTE_ORDER_SELECT)
      .eq("id", note.order_id)
      .maybeSingle();
    order = (orderRow as unknown as CreditNoteOrderRow) ?? null;
  }

  const credit = buildCreditNote(note, order);
  if (!credit) return new NextResponse("Not found", { status: 404 });

  const pdf = await renderToBuffer(CreditNoteDocument({ data: credit }));

  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${credit.creditNoteNumber}.pdf"`,
      // Personal data, generated per caller: never cached by a CDN or a proxy.
      "Cache-Control": "private, no-store",
    },
  });
}
