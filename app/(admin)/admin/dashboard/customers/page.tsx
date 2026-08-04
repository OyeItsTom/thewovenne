"use client";

import CustomersManager from "@/components/admin/CustomersManager";
import SectionShell from "@/components/admin/SectionShell";

export default function CustomersManagerSectionPage() {
  return (
    <SectionShell id="customers">
      <CustomersManager />
    </SectionShell>
  );
}
