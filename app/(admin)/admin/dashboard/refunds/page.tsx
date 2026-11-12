"use client";

import RefundsManager from "@/components/admin/RefundsManager";
import SectionShell from "@/components/admin/SectionShell";

export default function RefundsSectionPage() {
  return (
    <SectionShell id="refunds">
      <RefundsManager />
    </SectionShell>
  );
}
