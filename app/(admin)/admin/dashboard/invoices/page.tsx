"use client";

import InvoiceManager from "@/components/admin/InvoiceManager";
import SectionShell from "@/components/admin/SectionShell";

export default function InvoicesSectionPage() {
  return (
    <SectionShell id="invoices">
      <InvoiceManager />
    </SectionShell>
  );
}
