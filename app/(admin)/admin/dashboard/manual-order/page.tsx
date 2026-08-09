"use client";

import ManualOrderForm from "@/components/admin/ManualOrderForm";
import SectionShell from "@/components/admin/SectionShell";

export default function ManualOrderSectionPage() {
  return (
    <SectionShell id="manual-order">
      <ManualOrderForm />
    </SectionShell>
  );
}
