// Imported explicitly, unlike every other component here. This one is not
// rendered by React-DOM inside Next — it is rendered to a PDF canvas, including
// from scripts/invoice-preview.ts, which runs outside Next's automatic JSX
// runtime and fails with "React is not defined" without this.
import React from "react";
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import { BUSINESS, inr, type InvoiceData } from "@/lib/invoice";
import { EMBLEM_PNG } from "@/lib/invoiceEmblem";

/**
 * The invoice, as a PDF.
 *
 * Typeset rather than templated: generous margins, one hairline rule, the
 * wordmark letterspaced, and no boxes or shaded table headers. A default
 * invoice template would look like every other invoice, which is exactly what
 * a document carrying the brand's name into someone's records should not do.
 *
 * SERVER ONLY — @react-pdf/renderer draws to a PDF canvas, not the DOM, so this
 * never reaches the browser bundle.
 */

const INK = "#1C1F3B";
const TERRACOTTA = "#C2714F";
const MUTED = "#6B6E85";
const RULE = "#E3E1E8";

const s = StyleSheet.create({
  page: { paddingTop: 56, paddingBottom: 56, paddingHorizontal: 56, fontSize: 9.5, color: INK, fontFamily: "Helvetica" },
  // Sized in points and never stretched: the emblem is 180×162, and any pair of
  // numbers that is not that ratio squashes a mark people recognise.
  emblem: { width: 44, height: 39.6, marginBottom: 12 },
  wordmark: { fontSize: 15, letterSpacing: 4, color: INK },
  tagline: { fontSize: 7.5, letterSpacing: 1.4, color: TERRACOTTA, marginTop: 5, textTransform: "uppercase" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  invoiceTitle: { fontSize: 10, letterSpacing: 2.4, color: MUTED, textTransform: "uppercase" },
  invoiceNo: { fontSize: 13, marginTop: 5 },
  rule: { borderBottomWidth: 0.75, borderBottomColor: RULE, marginVertical: 22 },
  columns: { flexDirection: "row", justifyContent: "space-between" },
  col: { width: "47%" },
  label: { fontSize: 7.5, letterSpacing: 1.2, color: MUTED, textTransform: "uppercase", marginBottom: 6 },
  line: { lineHeight: 1.35, marginBottom: 1 },
  muted: { color: MUTED },
  tableHead: { flexDirection: "row", paddingBottom: 7, borderBottomWidth: 0.75, borderBottomColor: RULE },
  row: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: "#F2F1F5" },
  cItem: { width: "50%" },
  cQty: { width: "12%", textAlign: "right" },
  cUnit: { width: "19%", textAlign: "right" },
  cAmt: { width: "19%", textAlign: "right" },
  totals: { marginTop: 18, alignSelf: "flex-end", width: "52%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3.5 },
  grand: { flexDirection: "row", justifyContent: "space-between", marginTop: 9, paddingTop: 9, borderTopWidth: 0.75, borderTopColor: INK },
  grandText: { fontSize: 12 },
  footer: { position: "absolute", bottom: 40, left: 56, right: 56, fontSize: 7.5, color: MUTED, textAlign: "center", lineHeight: 1.6 },
});

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

export default function InvoiceDocument({ data }: { data: InvoiceData }) {
  const addr = data.address ?? {};
  const addressLines = [
    addr.line1,
    addr.line2,
    [addr.city, addr.state].filter(Boolean).join(", "),
    addr.postal_code,
  ].filter((l): l is string => Boolean(l && l.trim()));

  return (
    <Document
      title={`Invoice ${data.invoiceNumber}`}
      author={BUSINESS.name}
      subject={`Invoice for order ${data.orderReference}`}
    >
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <View>
            {/* The mark above the wordmark, as it is on the site — the header
                carried the name letterspaced and nothing else, so the one thing
                a customer recognises at a glance was missing from the document
                that ends up in their records. */}
            {/* eslint-disable-next-line jsx-a11y/alt-text -- this is
                @react-pdf's Image, drawn onto a PDF canvas. It takes no alt
                prop, and a PDF has no accessibility tree for one to land in. */}
            <Image src={EMBLEM_PNG} style={s.emblem} />
            <Text style={s.wordmark}>{BUSINESS.name}</Text>
            <Text style={s.tagline}>Woven in India · Worn for life</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={s.invoiceTitle}>Invoice</Text>
            <Text style={s.invoiceNo}>{data.invoiceNumber}</Text>
            <Text style={[s.muted, { marginTop: 4, fontSize: 8.5 }]}>{dateOf(data.issuedAt)}</Text>
          </View>
        </View>

        <View style={s.rule} />

        <View style={s.columns}>
          <View style={s.col}>
            <Text style={s.label}>From</Text>
            <Text style={s.line}>{BUSINESS.name}</Text>
            {BUSINESS.lines.map((l) => (
              <Text key={l} style={[s.line, s.muted]}>{l}</Text>
            ))}
            {/* Printed only once there is one to print. */}
            {BUSINESS.gstin && <Text style={[s.line, { marginTop: 4 }]}>GSTIN {BUSINESS.gstin}</Text>}
          </View>

          <View style={s.col}>
            <Text style={s.label}>Delivered to</Text>
            <Text style={s.line}>{data.customer.name}</Text>
            {addressLines.map((l, i) => (
              <Text key={i} style={[s.line, s.muted]}>{l}</Text>
            ))}
            {data.customer.phone && <Text style={[s.line, s.muted]}>{data.customer.phone}</Text>}
            <Text style={[s.line, s.muted]}>{data.customer.email}</Text>
          </View>
        </View>

        <View style={{ height: 26 }} />

        <View style={s.columns}>
          <View style={s.col}>
            <Text style={s.label}>Order</Text>
            <Text style={s.line}>{data.orderReference}</Text>
            <Text style={[s.line, s.muted]}>Placed {dateOf(data.orderDate)}</Text>
          </View>
          <View style={s.col}>
            <Text style={s.label}>Payment</Text>
            <Text style={[s.line, { textTransform: "capitalize" }]}>
              {data.payment.provider} · {data.payment.status}
            </Text>
            {data.payment.reference && (
              <Text style={[s.line, s.muted]}>{data.payment.reference}</Text>
            )}
          </View>
        </View>

        <View style={{ height: 26 }} />

        <View style={s.tableHead}>
          <Text style={[s.cItem, s.label, { marginBottom: 0 }]}>Item</Text>
          <Text style={[s.cQty, s.label, { marginBottom: 0 }]}>Qty</Text>
          <Text style={[s.cUnit, s.label, { marginBottom: 0 }]}>Unit</Text>
          <Text style={[s.cAmt, s.label, { marginBottom: 0 }]}>Amount</Text>
        </View>

        {data.lines.map((l, i) => (
          <View key={i} style={s.row} wrap={false}>
            <View style={s.cItem}>
              <Text>{l.name}</Text>
              <Text style={[s.muted, { fontSize: 8, marginTop: 2 }]}>
                {l.size ? `Size ${l.size}` : ""}
                {/* Prints itself once HSN codes are populated; absent until then. */}
                {l.hsn_code ? `${l.size ? "  ·  " : ""}HSN ${l.hsn_code}` : ""}
              </Text>
            </View>
            <Text style={s.cQty}>{l.quantity}</Text>
            <Text style={s.cUnit}>{inr(l.price_inr)}</Text>
            <Text style={s.cAmt}>{inr(l.price_inr * l.quantity)}</Text>
          </View>
        ))}

        <View style={s.totals}>
          <View style={s.totalRow}>
            <Text style={s.muted}>Subtotal</Text>
            <Text>{inr(data.subtotal)}</Text>
          </View>

          {data.couponDiscount > 0 && (
            <View style={s.totalRow}>
              <Text style={s.muted}>
                Discount{data.couponCode ? ` · ${data.couponCode}` : ""}
              </Text>
              <Text style={{ color: TERRACOTTA }}>- {inr(data.couponDiscount)}</Text>
            </View>
          )}

          {data.loyaltyDiscount > 0 && (
            <View style={s.totalRow}>
              <Text style={s.muted}>
                Loyalty{data.loyaltyPoints ? ` · ${data.loyaltyPoints} points` : ""}
              </Text>
              <Text style={{ color: TERRACOTTA }}>- {inr(data.loyaltyDiscount)}</Text>
            </View>
          )}

          <View style={s.totalRow}>
            <Text style={s.muted}>Delivery</Text>
            <Text>{data.shipping > 0 ? inr(data.shipping) : "Free"}</Text>
          </View>

          {/* Nothing is printed while the shop is unregistered — see BUSINESS.gstin. */}
          {data.tax?.map((t) => (
            <View key={t.label} style={s.totalRow}>
              <Text style={s.muted}>{t.label}</Text>
              <Text>{inr(t.amount)}</Text>
            </View>
          ))}

          <View style={s.grand}>
            <Text style={s.grandText}>Total paid</Text>
            <Text style={s.grandText}>{inr(data.total)}</Text>
          </View>
        </View>

        <Text style={s.footer} fixed>
          {BUSINESS.gstin
            ? `GSTIN ${BUSINESS.gstin}`
            : "Not registered for GST. This invoice does not carry a tax component."}
          {"\n"}
          Thank you for choosing handloom. {BUSINESS.name} · {BUSINESS.lines.join(", ")}
        </Text>
      </Page>
    </Document>
  );
}
