"use client";

import ExpenseManager from "@/components/admin/ExpenseManager";
import SectionShell from "@/components/admin/SectionShell";

export default function ExpensesSectionPage() {
  return (
    <SectionShell id="expenses">
      <ExpenseManager />
    </SectionShell>
  );
}
