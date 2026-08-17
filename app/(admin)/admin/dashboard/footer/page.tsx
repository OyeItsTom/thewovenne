"use client";

import FooterEditor from "@/components/admin/FooterEditor";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";

export default function FooterEditorSectionPage() {
  // onChange keeps the pending-changes bar honest: edits here are drafts, and
  // the bar is what says so.
  const { noteEdit } = useDashboard();

  return (
    <SectionShell id="footer">
      <FooterEditor onChange={noteEdit} />
    </SectionShell>
  );
}
