import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createRSCClient } from "@/lib/supabaseRSC";
import InvoiceDocument from "@/components/invoice/InvoiceDocument";
import { buildInvoice, INVOICE_SELECT } from "@/lib/invoice";

/**
 * Download one order's invoice.
 *
 * AUTHORISATION IS THE DATABASE'S. This uses the caller's own session, so RLS
 * decides what comes back: 0023 lets a customer read orders matching their
 * email, 0003 lets an admin read all of them. There is deliberately no
 * is_admin() branch here — an invoice carries a name, a postal address and a
 * phone number, and a hand-written check in a route handler is exactly the kind
 * of thing that gets one condition wrong and serves someone else's.
 *
 * A caller who cannot see the order gets 404, not 403: distinguishing them
 * would confirm that an order with that id exists.
 *
 * Node runtime — @react-pdf/renderer needs it.
 */
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: { orderId: string } }
) {
  const supabase = createRSCClient();

  const { data, error } = await supabase
    .from("orders")
    .select(INVOICE_SELECT)
    .eq("id", params.orderId)
    .maybeSingle();

  if (error) {
    console.error("invoice lookup:", error.message);
    return new NextResponse("Could not load that invoice.", { status: 500 });
  }
  if (!data) {
    return new NextResponse("Not found", { status: 404 });
  }

  const order = data as unknown as Parameters<typeof buildInvoice>[0];

  // An unpaid order has no invoice. Issuing one for a payment that has not
  // happened would put a document in someone's records for money nobody sent.
  if (order.payment_status !== "paid") {
    return new NextResponse("This order has no invoice yet.", { status: 404 });
  }

  const invoice = buildInvoice(order);
  if (!invoice) {
    // Paid but unnumbered: assign_invoice_number failed, or the order predates
    // migration 0037. Both are ours to fix, and neither is the customer's to
    // decipher, so it says so plainly and is logged loudly.
    console.error(
      `Order ${params.orderId} is paid but has no invoice number — check assign_invoice_number and migration 0037.`
    );
    return new NextResponse(
      "This invoice isn't ready yet. Please contact us and we'll send it over.",
      { status: 409 }
    );
  }

  const pdf = await renderToBuffer(InvoiceDocument({ data: invoice }));

  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoice.invoiceNumber}.pdf"`,
      // Contains personal data and is generated per caller: never cached by a
      // CDN or a shared proxy.
      "Cache-Control": "private, no-store",
    },
  });
}
