"use client";

import AuditLog from "@/components/admin/AuditLog";
import SectionShell from "@/components/admin/SectionShell";

export default function AuditLogSectionPage() {
  return (
    <SectionShell id="activity">
      <AuditLog />
    </SectionShell>
  );
}
