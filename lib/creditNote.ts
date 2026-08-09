import type { InvoiceLine } from "./invoice";

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
}

/** The order columns a credit note needs. Nothing financial is among them. */
export const CREDIT_NOTE_ORDER_SELECT =
  "id, created_at, customer_name, customer_email, customer_phone, " +
  "shipping_address, payment_provider, payment_method, razorpay_order_id";

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
    // An anonymised order (0033) leaves the note able to name the invoice but
    // not the person, which is the intended outcome of a deletion request.
    orderReference: order?.razorpay_order_id ?? order?.id ?? note.order_id ?? "—",
    orderDate: order?.created_at ?? null,
    customer: {
      name: order?.customer_name ?? "",
      email: order?.customer_email ?? "",
      phone: order?.customer_phone ?? null,
    },
    address: order?.shipping_address ?? null,
    lines,
  };
}

/** "Cancellation" / "Return", for the document and the email. */
export function creditNoteKindLabel(kind: string): string {
  if (kind === "cancellation") return "Cancellation";
  if (kind === "return") return "Return";
  return kind;
}
