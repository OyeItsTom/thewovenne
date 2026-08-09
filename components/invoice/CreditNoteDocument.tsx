// Imported explicitly, for the same reason InvoiceDocument does it: this is
// rendered to a PDF canvas rather than by React-DOM, including from scripts that
// run outside Next's automatic JSX runtime.
import React from "react";
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import { BUSINESS, inr } from "@/lib/invoice";
import { EMBLEM_PNG } from "@/lib/invoiceEmblem";
import { creditNoteKindLabel, type CreditNoteData } from "@/lib/creditNote";

/**
 * The credit note, as a PDF.
 *
 * DELIBERATELY THE SAME TYPESETTING AS THE INVOICE. This is the second half of
 * a pair, and a customer holding both should be in no doubt they came from the
 * same shop — while being in no doubt which is which, hence the title, the
 * reversed sign on the total, and the line naming the invoice it credits.
 *
 * NOTHING HERE IS A REFUND CONFIRMATION. A credit note says what is owed back,
 * not that the money has moved: the refund itself happens in Razorpay or in
 * cash, on its own timetable. Saying "refunded" on this document would make a
 * claim the shop cannot see from here.
 *
 * SERVER ONLY — @react-pdf/renderer draws to a PDF canvas, not the DOM.
 */

const INK = "#1C1F3B";
const TERRACOTTA = "#C2714F";
const MUTED = "#6B6E85";
const RULE = "#E3E1E8";

const s = StyleSheet.create({
  page: { paddingTop: 56, paddingBottom: 56, paddingHorizontal: 56, fontSize: 9.5, color: INK, fontFamily: "Helvetica" },
  // Identical to the invoice's, deliberately — the two documents are a pair.
  emblem: { width: 44, height: 39.6, marginBottom: 12 },
  wordmark: { fontSize: 15, letterSpacing: 4, color: INK },
  tagline: { fontSize: 7.5, letterSpacing: 1.4, color: TERRACOTTA, marginTop: 5, textTransform: "uppercase" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  title: { fontSize: 10, letterSpacing: 2.4, color: TERRACOTTA, textTransform: "uppercase" },
  number: { fontSize: 13, marginTop: 5 },
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
  grand: { flexDirection: "row", justifyContent: "space-between", marginTop: 9, paddingTop: 9, borderTopWidth: 0.75, borderTopColor: INK },
  grandText: { fontSize: 12 },
  reason: { marginTop: 26, paddingTop: 14, borderTopWidth: 0.5, borderTopColor: RULE, lineHeight: 1.5 },
  footer: { position: "absolute", bottom: 40, left: 56, right: 56, fontSize: 7.5, color: MUTED, textAlign: "center", lineHeight: 1.6 },
});

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

export default function CreditNoteDocument({ data }: { data: CreditNoteData }) {
  const addr = data.address ?? {};
  const addressLines = [
    addr.line1,
    addr.line2,
    [addr.city, addr.state].filter(Boolean).join(", "),
    addr.postal_code,
  ].filter((l): l is string => Boolean(l && l.trim()));

  return (
    <Document
      title={`Credit note ${data.creditNoteNumber}`}
      author={BUSINESS.name}
      subject={
        data.invoiceNumber
          ? `Credit note against invoice ${data.invoiceNumber}`
          : `Credit note for order ${data.orderReference}`
      }
    >
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <View>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf's Image;
                see the same note in InvoiceDocument. */}
            <Image src={EMBLEM_PNG} style={s.emblem} />
            <Text style={s.wordmark}>{BUSINESS.name}</Text>
            <Text style={s.tagline}>Woven in India · Worn for life</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={s.title}>Credit note</Text>
            <Text style={s.number}>{data.creditNoteNumber}</Text>
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
            {BUSINESS.gstin && <Text style={[s.line, { marginTop: 4 }]}>GSTIN {BUSINESS.gstin}</Text>}
          </View>

          <View style={s.col}>
            <Text style={s.label}>Issued to</Text>
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
            {/* The whole point of the document: it names what it reverses, and
                that invoice stays exactly as it was issued. */}
            <Text style={s.label}>Credits invoice</Text>
            <Text style={s.line}>{data.invoiceNumber ?? "—"}</Text>
            {/* The reference prints on its own — the Razorpay id already reads
                as "order_…", and labelling it again gave "Order order_QxYz". */}
            <Text style={[s.line, s.muted]}>
              {data.orderReference}
              {data.orderDate ? ` · ${dateOf(data.orderDate)}` : ""}
            </Text>
          </View>
          <View style={s.col}>
            <Text style={s.label}>Reason</Text>
            <Text style={s.line}>{creditNoteKindLabel(data.kind)}</Text>
          </View>
        </View>

        <View style={{ height: 26 }} />

        {data.lines.length > 0 && (
          <>
            <View style={s.tableHead}>
              <Text style={[s.cItem, s.label, { marginBottom: 0 }]}>Item credited</Text>
              <Text style={[s.cQty, s.label, { marginBottom: 0 }]}>Qty</Text>
              <Text style={[s.cUnit, s.label, { marginBottom: 0 }]}>Unit</Text>
              <Text style={[s.cAmt, s.label, { marginBottom: 0 }]}>Amount</Text>
            </View>

            {data.lines.map((l, i) => (
              <View key={i} style={s.row} wrap={false}>
                <View style={s.cItem}>
                  <Text>{l.name}</Text>
                  <Text style={[s.muted, { fontSize: 8, marginTop: 2 }]}>
                    {l.size && l.size !== "One Size" ? `Size ${l.size}` : ""}
                    {l.hsn_code ? `${l.size && l.size !== "One Size" ? "  ·  " : ""}HSN ${l.hsn_code}` : ""}
                  </Text>
                </View>
                <Text style={s.cQty}>{l.quantity}</Text>
                <Text style={s.cUnit}>{inr(l.price_inr)}</Text>
                <Text style={s.cAmt}>{inr(l.price_inr * l.quantity)}</Text>
              </View>
            ))}
          </>
        )}

        <View style={s.totals}>
          {/* Minus signed, once, here. The row it was stored in is positive on
              purpose (0043) — a credit note's direction is what it is, not a
              negative number every reader has to remember the sign of. */}
          <View style={s.grand}>
            <Text style={s.grandText}>Total credited</Text>
            <Text style={[s.grandText, { color: TERRACOTTA }]}>- {inr(data.amount)}</Text>
          </View>
        </View>

        {data.reason && (
          <View style={s.reason}>
            <Text style={s.label}>Note</Text>
            <Text style={s.line}>{data.reason}</Text>
          </View>
        )}

        <Text style={s.footer} fixed>
          {BUSINESS.gstin
            ? `GSTIN ${BUSINESS.gstin}`
            : "Not registered for GST. This credit note does not carry a tax component."}
          {"\n"}
          This document credits the invoice named above; that invoice is not
          altered or cancelled. {BUSINESS.name} · {BUSINESS.lines.join(", ")}
        </Text>
      </Page>
    </Document>
  );
}
