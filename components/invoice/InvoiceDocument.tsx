import type { InvoiceData } from "@/lib/invoice";
import { invoiceLayoutFor } from "@/lib/invoiceLayout";
import InvoiceDocumentV1 from "./InvoiceDocumentV1";
import InvoiceDocumentV2 from "./InvoiceDocumentV2";

/**
 * The invoice PDF, in the layout it was issued in.
 *
 * Every caller (the customer download, the admin resend, the manual-order email)
 * goes through this, so the layout choice lives in one place. See
 * lib/invoiceLayout for why the choice is made by issue date.
 */
export default function InvoiceDocument({ data }: { data: InvoiceData }) {
  // Called, not mounted, so the element handed to renderToBuffer is the
  // layout's own <Document>, exactly as it was before there were two.
  return invoiceLayoutFor(data.issuedAt) === "v2"
    ? InvoiceDocumentV2({ data })
    : InvoiceDocumentV1({ data });
}
