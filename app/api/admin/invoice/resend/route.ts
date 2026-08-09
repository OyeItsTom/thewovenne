import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createRSCClient } from "@/lib/supabaseRSC";
import InvoiceDocument from "@/components/invoice/InvoiceDocument";
import { buildInvoice, INVOICE_SELECT } from "@/lib/invoice";
import { sendEmail } from "@/lib/email";

/**
 * Send an already-issued invoice to the customer again.
 *
 * RE-RENDERS RATHER THAN STORING. The order is the source of the document, so
 * a resend produces exactly what the original download produces — there is no
 * archived copy that could have drifted from the order it describes.
 *
 * Nothing here reissues or renumbers anything. A resent invoice is the same
 * invoice; the sequence is untouched.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const { orderId } = (await request.json()) as { orderId?: string };
  if (!orderId) {
    return NextResponse.json({ error: "No order given." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("orders")
    .select(INVOICE_SELECT)
    .eq("id", orderId)
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json({ error: "That order could not be found." }, { status: 404 });
  }

  const order = data as unknown as Parameters<typeof buildInvoice>[0];
  const invoice = buildInvoice(order);
  if (!invoice) {
    return NextResponse.json(
      { error: "That order has no invoice number yet." },
      { status: 409 }
    );
  }
  if (!invoice.customer.email) {
    return NextResponse.json(
      { error: "That order has no email address to send to." },
      { status: 400 }
    );
  }

  const pdf = await renderToBuffer(InvoiceDocument({ data: invoice }));

  const result = await sendEmail({
    to: invoice.customer.email,
    subject: `Your invoice ${invoice.invoiceNumber} — THE WOVENNE`,
    html:
      `<p>Hello ${invoice.customer.name || "there"},</p>` +
      `<p>Your invoice <strong>${invoice.invoiceNumber}</strong> is attached.</p>` +
      `<p>THE WOVENNE</p>`,
    text: `Your invoice ${invoice.invoiceNumber} is attached.`,
    attachments: [
      {
        filename: `${invoice.invoiceNumber}.pdf`,
        content: Buffer.from(pdf).toString("base64"),
      },
    ],
  });

  if (!result.ok) {
    // Surfaced rather than swallowed: unlike an order confirmation, a resend is
    // something an admin asked for and is waiting on, so silence would read as
    // success.
    return NextResponse.json(
      { error: result.error ?? "The email provider refused that message." },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true });
}
