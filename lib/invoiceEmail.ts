/**
 * Sending an invoice email, and deciding whether a resend is allowed
 * (WP-EMAIL-E4).
 *
 * Both routes that email an invoice, the manual order and the admin resend,
 * go through `deliverInvoiceEmail`, so they report the same outcomes in the
 * same words. Its collaborators are passed in, so the tests can drive every
 * branch without Resend, React-PDF or a database.
 *
 * WHAT "SENT" MEANS HERE. Resend accepting an email is the most this code can
 * know. It is not proof the customer received it, and no message here says it
 * is. When the provider gives no clear answer (a timeout, a network failure, a
 * 5xx), the outcome is "unknown", not "failed". The email may still arrive, so
 * the admin is told to check before sending another.
 *
 * Nothing here writes to the database. Invoice numbers, credit notes and
 * totals are read, never created or changed.
 */
import { invoiceEmail, invoiceEmailData, type InvoiceEmailKind } from "./emails/invoice";
import type { InvoiceData } from "./invoice";

export type InvoiceEmailStatus =
  | "accepted" // the provider took it; delivery is not confirmed
  | "no_address" // the order has no email address
  | "no_invoice" // the order has no invoice number
  | "not_prepared" // the PDF or the email could not be built; nothing was sent
  | "rejected" // the provider refused it; nothing was sent
  | "unknown"; // no clear answer; it may or may not have been sent

export interface InvoiceEmailOutcome {
  status: InvoiceEmailStatus;
  /** Admin-facing, one or two sentences, never shown to the customer. */
  message: string;
  /** The provider's own error, for logs. */
  detail: string | null;
}

/** The subset of lib/email's sendEmail used here (unchanged on main and after R1). */
export type SendFn = (msg: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; content: string }[];
}) => Promise<{ ok: boolean; error: string | null }>;

export interface DeliverDeps {
  send: SendFn;
  renderPdf: (invoice: InvoiceData) => Promise<Uint8Array>;
  /** How long to wait for the provider before reporting "unknown". */
  timeoutMs?: number;
}

export const INVOICE_EMAIL_TIMEOUT_MS = 10_000;

/**
 * Is a provider error a definite refusal, or an answer we never got?
 *
 * lib/email on main reports "Resend <status>", "Send failed." (the request
 * threw) or "Email is not configured.". A 4xx is a refusal. A 5xx, a throw
 * or anything unrecognised may have been accepted.
 */
export function providerErrorIsDefinite(error: string | null): boolean {
  if (!error) return false;
  if (error === "Email is not configured.") return true;
  const m = /^Resend (\d{3})$/.exec(error);
  return !!m && Number(m[1]) >= 400 && Number(m[1]) < 500;
}

class Timeout extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout()), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const RESEND_HINT = "You can send it again from Invoices.";

/**
 * Build and send one invoice email. Never throws: the caller is usually in the
 * middle of something more important (recording a sale).
 */
export async function deliverInvoiceEmail(
  input: {
    invoice: InvoiceData | null;
    kind: InvoiceEmailKind;
    cancelled?: boolean;
    creditNoteNumbers?: readonly string[];
  },
  deps: DeliverDeps
): Promise<InvoiceEmailOutcome> {
  const { invoice } = input;
  if (!invoice) {
    return {
      status: "no_invoice",
      message: "No invoice email was sent: this order has no invoice number yet.",
      detail: null,
    };
  }
  const to = invoice.customer.email.trim();
  if (!to) {
    return {
      status: "no_address",
      message: "No invoice email was sent: there is no email address on this order.",
      detail: null,
    };
  }

  let built: ReturnType<typeof invoiceEmail>;
  let pdf: Uint8Array;
  try {
    built = invoiceEmail(
      invoiceEmailData(invoice, {
        kind: input.kind,
        cancelled: input.cancelled,
        creditNoteNumbers: input.creditNoteNumbers,
      })
    );
    pdf = await deps.renderPdf(invoice);
  } catch (e) {
    console.error(`invoice email ${invoice.invoiceNumber}: could not be prepared`, e);
    return {
      status: "not_prepared",
      message: "No invoice email was sent: the invoice PDF or email could not be prepared.",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  const ms = deps.timeoutMs ?? INVOICE_EMAIL_TIMEOUT_MS;
  let result: { ok: boolean; error: string | null };
  try {
    result = await withDeadline(
      deps.send({
        to,
        subject: built.subject,
        html: built.html,
        text: built.text,
        attachments: [
          // Same filename and bytes as before E4.
          { filename: `${invoice.invoiceNumber}.pdf`, content: Buffer.from(pdf).toString("base64") },
        ],
      }),
      ms
    );
  } catch (e) {
    const timedOut = e instanceof Timeout;
    console.error(`invoice email ${invoice.invoiceNumber}: ${timedOut ? `no answer after ${ms} ms` : "send threw"}`, timedOut ? "" : e);
    return {
      status: "unknown",
      message: timedOut
        ? `The email provider did not answer within ${Math.round(ms / 1000)} seconds, so it is not known whether the invoice email was sent. Check with the customer before sending it again.`
        : "It is not known whether the invoice email was sent: the request to the email provider failed. Check with the customer before sending it again.",
      detail: timedOut ? "timeout" : e instanceof Error ? e.message : String(e),
    };
  }

  if (result.ok) {
    return {
      status: "accepted",
      message: `The invoice email to ${to} was accepted by the email provider. That does not confirm it reached their inbox.`,
      detail: null,
    };
  }
  if (result.error === "Email is not configured.") {
    return {
      status: "rejected",
      message: `The invoice email was not sent: email is not configured on this server. ${RESEND_HINT}`,
      detail: result.error,
    };
  }
  if (providerErrorIsDefinite(result.error)) {
    return {
      status: "rejected",
      message: `The invoice email was not sent: the email provider refused it (${result.error}). ${RESEND_HINT}`,
      detail: result.error,
    };
  }
  return {
    status: "unknown",
    message: `It is not known whether the invoice email was sent: the email provider did not give a clear answer (${result.error ?? "no detail"}). Check with the customer before sending it again.`,
    detail: result.error,
  };
}

/** HTTP status for a resend outcome. */
export function resendHttpStatus(status: InvoiceEmailStatus): number {
  switch (status) {
    case "accepted":
      return 200;
    case "no_address":
      return 400;
    case "no_invoice":
      return 409;
    case "not_prepared":
      return 500;
    case "rejected":
      return 502;
    case "unknown":
      return 504;
  }
}

// ── Resend eligibility ─────────────────────────────────────────────────────

export interface ResendOrderRow {
  invoice_number: string | null;
  payment_status: string | null;
  status: string | null;
  customer_email: string | null;
}

export type ResendDecision =
  | { ok: true; cancelled: boolean; creditNoteNumbers: string[] }
  | { ok: false; httpStatus: number; error: string };

/**
 * May this order's invoice be emailed again, and what must the email say?
 *
 * `creditNotes` is the list read from credit_notes for this order, or null if
 * that read failed. A failed read refuses the resend rather than guessing,
 * because the answer decides whether the email must say "cancelled".
 */
export function resendDecision(order: ResendOrderRow, creditNotes: readonly string[] | null): ResendDecision {
  if (!order.invoice_number) {
    return { ok: false, httpStatus: 409, error: "That order has no invoice number yet." };
  }
  // The same rule as the customer's own download (/api/invoice/[orderId]).
  if (order.payment_status !== "paid") {
    return {
      ok: false,
      httpStatus: 409,
      error: "That order is not marked paid, so its invoice is not sent. Nothing was emailed.",
    };
  }
  if (!order.customer_email?.trim()) {
    return { ok: false, httpStatus: 400, error: "That order has no email address to send to." };
  }
  if (creditNotes === null) {
    return {
      ok: false,
      httpStatus: 503,
      error: "Could not check this invoice's credit notes, so nothing was emailed. Try again in a moment.",
    };
  }
  const numbers = [...new Set(creditNotes.map((n) => String(n ?? "").trim()).filter(Boolean))];
  const cancelled = order.status === "cancelled";
  if (cancelled && numbers.length === 0) {
    return {
      ok: false,
      httpStatus: 409,
      error:
        "This order is cancelled but has no credit note against its invoice, so the invoice was not emailed. " +
        "On its own it would read as a live sale. Nothing was sent and no records were changed.",
    };
  }
  return { ok: true, cancelled, creditNoteNumbers: numbers };
}
