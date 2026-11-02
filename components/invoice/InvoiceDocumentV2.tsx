// Imported explicitly: rendered to a PDF canvas, including from scripts that run
// outside Next's automatic JSX runtime.
import React from "react";
import { Document, Page, Text, View, Image, Link, StyleSheet } from "@react-pdf/renderer";
import { BUSINESS, inr, type InvoiceData } from "@/lib/invoice";
import { paymentMethodLabel } from "@/lib/paymentMethods";
import { EMBLEM_HEIGHT, EMBLEM_PNG, EMBLEM_WIDTH } from "@/lib/invoiceEmblem";

/**
 * The invoice, V2: black and white, set like a statement rather than a letter.
 *
 * WHAT IS PRINTED IS WHAT THE ORDER RECORDS, NOTHING MORE.
 *  - "Billed to" carries the customer's name and contact details only. No
 *    billing address is collected at checkout, and printing the delivery
 *    address under a billing heading would state something nobody told us.
 *  - Taxes appear only when lib/invoice gives a tax block, which it does only
 *    once BUSINESS.gstin is set.
 *  - Amounts are the builder's figures. The one product here, price × quantity
 *    for a line, is the same expression the V1 layout prints.
 *
 * ISSUED INVOICES KEEP THEIR LAYOUT. Which layout an invoice is drawn in is
 * decided in lib/invoiceLayout, by issue date. V1 is kept unchanged beside this.
 *
 * BLACK AND WHITE, WITH ONE EXCEPTION. The emblem, in its own maroon, at the
 * top left above the name is the only colour. Everything else is black, white
 * or grey: this document is printed, photocopied and filed, and it should read
 * the same in all three. The seller's name and address live in the centred
 * footer, on every page, with the GST statement. The website is in the header.
 */

const BLACK = "#000000";
const TEXT = "#1A1A1A";
const GREY = "#5F5F5F";
const HAIRLINE = "#E2E2E2";

const s = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 72, // room for the fixed footer
    paddingHorizontal: 48,
    fontSize: 9,
    lineHeight: 1.35,
    color: TEXT,
    fontFamily: "Helvetica",
  },

  // Header
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  // Brand block, top left: emblem, name, website, one left edge. The emblem is
  // 40pt wide in the artwork's own 180:162 ratio (36pt tall). lib/invoiceEmblem
  // found the weave stops reading below about 44pt tall at print size; 36pt
  // was checked and still reads.
  brand: { alignItems: "flex-start" },
  emblem: { width: 40, height: (40 * EMBLEM_HEIGHT) / EMBLEM_WIDTH, marginBottom: 8 },
  wordmark: { fontSize: 13, lineHeight: 1.1, letterSpacing: 0.4, fontFamily: "Helvetica-Bold", color: BLACK },
  // A real link annotation, grey and not underlined rather than the default
  // blue: the emblem is the only colour on the page.
  site: { fontSize: 7.5, color: GREY, textDecoration: "none", marginTop: 3 },
  title: { fontSize: 20, lineHeight: 1.1, fontFamily: "Helvetica-Bold", color: BLACK, textAlign: "right", marginBottom: 6 },
  // A fixed-width block, so the title and both values share the right margin
  // with the Amount column below.
  headerRight: { width: 230 },
  metaRow: { flexDirection: "row", marginTop: 3 },
  metaLabel: { color: GREY, width: 110, textAlign: "right", paddingRight: 8 },
  metaValue: { width: 120, textAlign: "right" },


  rule: { borderBottomWidth: 0.75, borderBottomColor: BLACK, marginTop: 16, marginBottom: 16 },

  // Parties
  columns: { flexDirection: "row", justifyContent: "space-between" },
  col: { width: "48%" },
  label: {
    fontSize: 7,
    letterSpacing: 1,
    color: GREY,
    textTransform: "uppercase",
    marginBottom: 4,
    fontFamily: "Helvetica-Bold",
  },
  strong: { fontFamily: "Helvetica-Bold", color: BLACK },
  muted: { color: GREY },

  // Order and payment
  facts: {
    flexDirection: "row",
    marginTop: 18,
    paddingVertical: 8,
    borderTopWidth: 0.5,
    borderTopColor: HAIRLINE,
    borderBottomWidth: 0.5,
    borderBottomColor: HAIRLINE,
  },
  fact: { width: "25%", paddingRight: 8 },

  // Items
  table: { marginTop: 20 },
  tableHead: { flexDirection: "row", paddingBottom: 5, borderBottomWidth: 0.75, borderBottomColor: BLACK },
  th: { fontSize: 7, letterSpacing: 0.8, color: GREY, textTransform: "uppercase", fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: HAIRLINE },
  cDesc: { width: "46%", paddingRight: 8 },
  cSize: { width: "12%", paddingRight: 6 },
  cQty: { width: "8%", textAlign: "right" },
  cUnit: { width: "17%", textAlign: "right" },
  cAmt: { width: "17%", textAlign: "right" },
  hsn: { color: GREY, fontSize: 7.5, marginTop: 1 },

  // Totals
  totals: { marginTop: 12, marginLeft: "auto", width: "42%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5 },
  grand: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 0.75,
    borderTopColor: BLACK,
  },
  grandText: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: BLACK },

  // Footer, on every page. Absolutely placed Text, not a View: @react-pdf
  // drops an absolutely placed, fixed View that has no explicit height (checked
  // 2 Nov 2026 — it rendered nothing), so each piece is placed on its own.
  footerText: { position: "absolute", bottom: 30, left: 48, right: 48, fontSize: 7, lineHeight: 1.6, color: GREY, textAlign: "center" },
});

/** The brand as the owner asked it set on the invoice (2 Nov 2026): lowercase, one word. */
const WORDMARK = "thewovenne";
const SITE_URL = "https://www.thewovenne.com";
const SITE_LABEL = "www.thewovenne.com";

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

const titleCase = (v: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);

/** How the money arrived, in words, from what the order records. */
function paymentMethodText(p: InvoiceData["payment"]): string {
  if (p.method) return paymentMethodLabel(p.method);
  // Rows from before 0044 carry only the provider.
  return p.provider === "razorpay" ? "Razorpay (online)" : titleCase(p.provider);
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.fact}>
      <Text style={s.label}>{label}</Text>
      <Text>{children}</Text>
    </View>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.totalRow}>
      <Text style={s.muted}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

export default function InvoiceDocumentV2({ data }: { data: InvoiceData }) {
  const addr = data.address ?? {};
  const addressLines = [
    addr.line1,
    addr.line2,
    [addr.city, addr.state].filter(Boolean).join(", "),
    addr.postal_code,
    addr.country,
  ].filter((l): l is string => Boolean(l && String(l).trim()));

  // Online orders already use the gateway's order id as their reference (see
  // lib/invoice), so it is printed once, not twice.
  const reference =
    data.payment.reference && data.payment.reference !== data.orderReference ? data.payment.reference : null;

  return (
    <Document
      title={`Invoice ${data.invoiceNumber}`}
      author={BUSINESS.name}
      subject={`Invoice for order ${data.orderReference}`}
    >
      <Page size="A4" style={s.page}>
        {/* ── Header ───────────────────────────────────────────── */}
        <View style={s.header}>
          <View style={s.brand}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image,
                drawn onto a PDF canvas; it takes no alt prop. */}
            <Image src={EMBLEM_PNG} style={s.emblem} />
            <Text style={s.wordmark}>{WORDMARK}</Text>
            <Link src={SITE_URL} style={s.site}>
              {SITE_LABEL}
            </Link>
          </View>
          <View style={s.headerRight}>
            <Text style={s.title}>INVOICE</Text>
            <View style={s.metaRow}>
              <Text style={s.metaLabel}>Invoice no.</Text>
              <Text style={[s.metaValue, s.strong]}>{data.invoiceNumber}</Text>
            </View>
            <View style={s.metaRow}>
              <Text style={s.metaLabel}>Issue date</Text>
              <Text style={s.metaValue}>{dateOf(data.issuedAt)}</Text>
            </View>
          </View>
        </View>

        <View style={s.rule} />

        {/* ── Parties ──────────────────────────────────────────── */}
        <View style={s.columns} wrap={false}>
          <View style={s.col}>
            <Text style={s.label}>Billed to</Text>
            {data.customer.name ? <Text style={s.strong}>{data.customer.name}</Text> : null}
            {data.customer.email ? <Text style={s.muted}>{data.customer.email}</Text> : null}
            {data.customer.phone ? <Text style={s.muted}>{data.customer.phone}</Text> : null}
          </View>
          <View style={s.col}>
            <Text style={s.label}>Delivery address</Text>
            {addressLines.length > 0 ? (
              <>
                {data.customer.name ? <Text style={s.strong}>{data.customer.name}</Text> : null}
                {addressLines.map((l, i) => (
                  <Text key={i} style={s.muted}>{l}</Text>
                ))}
              </>
            ) : (
              <Text style={s.muted}>No delivery address recorded for this order.</Text>
            )}
          </View>
        </View>

        {/* ── Order and payment ────────────────────────────────── */}
        <View style={s.facts} wrap={false}>
          <Fact label="Order reference">{data.orderReference}</Fact>
          <Fact label="Order date">{dateOf(data.orderDate)}</Fact>
          <Fact label="Payment method">{paymentMethodText(data.payment)}</Fact>
          <Fact label={reference ? "Payment reference" : "Payment status"}>
            {reference ?? titleCase(data.payment.status)}
          </Fact>
        </View>

        {/* ── Items ────────────────────────────────────────────── */}
        <View style={s.table}>
          {/* Repeated at the top of each page the table runs onto. */}
          <View style={s.tableHead} fixed>
            <Text style={[s.th, s.cDesc]}>Description</Text>
            <Text style={[s.th, s.cSize]}>Size</Text>
            <Text style={[s.th, s.cQty]}>Qty</Text>
            <Text style={[s.th, s.cUnit]}>Unit price</Text>
            <Text style={[s.th, s.cAmt]}>Amount</Text>
          </View>

          {data.lines.map((l, i) => (
            <View key={i} style={s.row} wrap={false}>
              <View style={s.cDesc}>
                <Text>{l.name}</Text>
                {/* Prints itself once HSN codes are populated; absent until then. */}
                {l.hsn_code ? <Text style={s.hsn}>HSN {l.hsn_code}</Text> : null}
              </View>
              <Text style={s.cSize}>{l.size || "—"}</Text>
              <Text style={s.cQty}>{l.quantity}</Text>
              <Text style={s.cUnit}>{inr(l.price_inr)}</Text>
              <Text style={s.cAmt}>{inr(l.price_inr * l.quantity)}</Text>
            </View>
          ))}
        </View>

        {/* ── Totals ───────────────────────────────────────────── */}
        <View style={s.totals} wrap={false}>
          <TotalRow label="Subtotal" value={inr(data.subtotal)} />
          {data.couponDiscount > 0 && (
            <TotalRow
              label={`Discount${data.couponCode ? ` (${data.couponCode})` : ""}`}
              value={`- ${inr(data.couponDiscount)}`}
            />
          )}
          {data.loyaltyDiscount > 0 && (
            <TotalRow
              label={`Loyalty points${data.loyaltyPoints ? ` (${data.loyaltyPoints})` : ""}`}
              value={`- ${inr(data.loyaltyDiscount)}`}
            />
          )}
          <TotalRow label="Delivery" value={inr(data.shipping)} />
          {/* Present only once the shop is GST-registered — see BUSINESS.gstin. */}
          {data.tax?.map((t) => <TotalRow key={t.label} label={t.label} value={inr(t.amount)} />)}
          <View style={s.grand}>
            <Text style={s.grandText}>Total paid</Text>
            <Text style={s.grandText}>{inr(data.total)}</Text>
          </View>
        </View>

        {/* ── Footer ───────────────────────────────────────────── */}
        {/* Centred, on every page. The business name and address are the
            seller's identification; the first line is its tax position. */}
        <Text style={s.footerText} fixed>
          {BUSINESS.gstin
            ? `GSTIN ${BUSINESS.gstin}`
            : "Not registered for GST. This invoice does not carry a tax component."}
          {"\n"}
          Thank you for choosing us. The Wovenne · {BUSINESS.lines.join(", ")}
        </Text>
      </Page>
    </Document>
  );
}
