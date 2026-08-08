import { Download } from "lucide-react";

/**
 * Download link for an order's invoice.
 *
 * One component for both the customer's Orders page and the admin's, so the
 * two can never disagree about when an invoice exists. The route behind it
 * authorises through RLS, which is why the same link is safe in both places:
 * a customer gets their own, an admin gets any, and neither needs a different
 * component to say so.
 *
 * Rendered only for a PAID order. An unpaid one has no invoice, and offering a
 * download that returns 404 is worse than not offering it.
 */
export default function InvoiceLink({
  orderId,
  paid,
  invoiceNumber,
}: {
  orderId: string;
  paid: boolean;
  /** Null on an order paid before invoice numbering existed. */
  invoiceNumber?: string | null;
}) {
  if (!paid) return null;

  return (
    <a
      href={`/api/invoice/${orderId}`}
      // The route sets Content-Disposition: attachment, so this downloads
      // rather than navigating. target=_blank would leave a blank tab behind.
      className="mt-3 inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/55 transition-colors hover:text-terracotta"
    >
      <Download className="h-3.5 w-3.5" />
      {invoiceNumber ? `Invoice ${invoiceNumber}` : "Download invoice"}
    </a>
  );
}
