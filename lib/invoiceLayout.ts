/**
 * Which layout an invoice is drawn in (Invoice V2).
 *
 * Invoices are rendered on demand from the order, not stored (see lib/invoice).
 * A layout change would therefore silently redraw every invoice a customer has
 * already been sent, the next time they download it. The figures would not move,
 * because they come from the order, but the document in their records would no
 * longer look like the one they were given.
 *
 * So the layout is chosen by the invoice's own issue date. An invoice issued
 * before INVOICE_V2_FROM is always drawn in V1, exactly as it was issued, and
 * one issued at or after it is drawn in V2. The cutoff is a release decision, made
 * once and never moved backwards:
 *
 *   null        V2 is off and every invoice is V1. Merging this changes nothing.
 *   ISO string  the moment V2 starts, set to the deploy time, WITH a zone
 *               (e.g. "2026-11-10T09:00:00Z"). A zoneless value leaves V2 off.
 *
 * Moving it EARLIER would redraw invoices that were already issued, which is the
 * thing this file exists to prevent.
 *
 * The date used is the invoice's issue date (orders.invoice_issued_at, set with
 * the number by assign_invoice_number), not the order date. An order placed
 * before the cutoff but paid and invoiced after it was first issued in V2, so V2
 * is what it is re-drawn in. lib/invoice falls back to created_at only when
 * invoice_issued_at is null, which assign_invoice_number never leaves it.
 */

export type InvoiceLayout = "v1" | "v2";

export const INVOICE_V2_FROM: string | null = null;

/**
 * A timestamp with an explicit time zone, as milliseconds since the epoch, or
 * null if it is not one.
 *
 * THE ZONE IS REQUIRED. JavaScript reads "2026-11-03T00:00" in the machine's
 * own time zone. That is UTC on Vercel and IST on a laptop, so a cutoff written
 * without a zone would put the same invoice on different layouts in different
 * places. Both values must carry Z or an offset. PostgREST's timestamptz
 * ("2026-11-02T06:30:00.123456+00:00") and Postgres text ("2026-11-02
 * 06:30:00+00") are accepted. Fractions beyond milliseconds are dropped, so
 * two instants inside the same millisecond count as equal.
 */
export function zonedInstant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(value.trim());
  if (!m) return null;
  const frac = m[3] ? m[3].slice(0, 4).padEnd(4, "0") : "";
  let zone = m[4].toUpperCase();
  if (zone !== "Z") zone = zone.length === 3 ? `${zone}:00` : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${frac}${zone}`);
  return Number.isNaN(ms) ? null : ms;
}

export function invoiceLayoutFor(issuedAt: string, from: string | null = INVOICE_V2_FROM): InvoiceLayout {
  if (!from) return "v1";
  const cutoff = zonedInstant(from);
  const issued = zonedInstant(issuedAt);
  // An unreadable or zoneless date stays on V1, the layout every invoice
  // issued before V2 was drawn in.
  if (cutoff === null || issued === null) return "v1";
  return issued >= cutoff ? "v2" : "v1";
}
