"use client";

import ProfitAndLoss from "@/components/admin/ProfitAndLoss";
import SectionShell from "@/components/admin/SectionShell";

export default function ProfitLossSectionPage() {
  return (
    <SectionShell id="profit-loss">
      <ProfitAndLoss />
    </SectionShell>
  );
}
