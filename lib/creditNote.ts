import { INVOICE_SNAPSHOT_EMBED, issuedParty, type InvoiceLine, type InvoiceSnapshotRow } from "./invoice";
import { orderRef } from "./orders";

/**
 * A credit note, shaped from its own row plus the order it reverses.
 *
 * SAME PRINCIPLE AS THE INVOICE: rendered on demand, never stored. The row
 * carries the number, the amount, the reason and a snapshot of what was
 * credited; the order carries who bought it and where it went. Neither moves
 * afterwards, so rendering the same note twice produces the same document.
 *
 * THE ORDER IS ONLY FOR THE NAME AND ADDRESS. Every figure on the document
 * comes from the credit note row — an amount read back off the order would
 * quietly become wrong the first time a partial return exists.
 *
 * AND THE NAME AND ADDRESS ARE THE INVOICE'S (OS-2b, 0079): the party the
 * reversed invoice was issued to, from its issue snapshot, not the order's
 * later-corrected delivery details. The two documents name the same party.
 */

export interface CreditNoteRow {
  id: string;
  credit_note_number: string;
  order_id: string | null;
  invoice_number: string | null;
  kind: string;
  amount_inr: number | string | null;
  reason: string | null;
  items: unknown;
  issued_at: string;
}

/** The columns buildCreditNote needs, so a route cannot drift from it. */
export const CREDIT_NOTE_SELECT =
  "id, credit_note_number, order_id, invoice_number, kind, amount_inr, reason, " +
  "items, issued_at";

/** What a credit note needs from the order it reverses. */
export interface CreditNoteOrderRow {
  id: string;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  shipping_address: Record<string, string> | null;
  payment_provider: string | null;
  payment_method: string | null;
  razorpay_order_id: string | null;
  /** OS-2b: the reversed invoice's issue snapshot. */
  invoice_snapshot?: InvoiceSnapshotRow | null;
}

/** The order columns a credit note needs. Nothing financial is among them. */
export const CREDIT_NOTE_ORDER_SELECT =
  "id, created_at, customer_name, customer_email, customer_phone, " +
  "shipping_address, payment_provider, payment_method, razorpay_order_id, " +
  INVOICE_SNAPSHOT_EMBED;

export interface CreditNoteData {
  creditNoteNumber: string;
  issuedAt: string;
  /** "cancellation" or "return" — the document says which. */
  kind: string;
  reason: string | null;
  /** Positive. A credit note's sign is what it IS, not a negative number. */
  amount: number;
  /** The invoice this reverses. Copied onto the row at issue — see 0043. */
  invoiceNumber: string | null;
  orderReference: string;
  orderDate: string | null;
  customer: { name: string; email: string; phone: string | null };
  address: Record<string, string> | null;
  /** What was credited. Empty is legitimate for a note issued against a total. */
  lines: InvoiceLine[];
}

export function buildCreditNote(
  note: CreditNoteRow,
  order: CreditNoteOrderRow | null
): CreditNoteData | null {
  if (!note.credit_note_number) return null;

  const rawItems = Array.isArray(note.items) ? note.items : [];
  const lines: InvoiceLine[] = rawItems.map((i) => {
    const item = i as Partial<InvoiceLine>;
    return {
      name: String(item.name ?? "Item"),
      size: String(item.size ?? ""),
      quantity: Number(item.quantity ?? 0),
      price_inr: Number(item.price_inr ?? 0),
      hsn_code: item.hsn_code ?? null,
    };
  });

  return {
    creditNoteNumber: note.credit_note_number,
    issuedAt: note.issued_at,
    kind: note.kind,
    reason: note.reason,
    amount: Number(note.amount_inr ?? 0),
    invoiceNumber: note.invoice_number,
    // The short reference for an in-person order, for the reason given in
    // buildInvoice: the raw uuid matched nothing the customer had been shown.
    //
    // An anonymised order (0033) leaves the note able to name the invoice but
    // not the person, which is the intended outcome of a deletion request — and
    // a note whose order row is gone entirely still has its own order_id to
    // quote.
    orderReference:
      order?.razorpay_order_id ??
      (order?.id ? orderRef(order.id) : null) ??
      (note.order_id ? orderRef(note.order_id) : null) ??
      "—",
    orderDate: order?.created_at ?? null,
    ...(order
      ? (({ customer, address }) => ({ customer, address }))(issuedParty(order))
      : { customer: { name: "", email: "", phone: null }, address: null }),
    lines,
  };
}

/** "Cancellation" / "Return", for the document and the email. */
export function creditNoteKindLabel(kind: string): string {
  if (kind === "cancellation") return "Cancellation";
  if (kind === "return") return "Return";
  return kind;
}
