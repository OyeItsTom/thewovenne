"use client";

import ContentEditor from "@/components/admin/ContentEditor";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";

export default function ContentEditorSectionPage() {
  // onChange keeps the pending-changes bar honest: edits here are drafts, and
  // the bar is what says so.
  const { noteEdit } = useDashboard();

  return (
    <SectionShell id="content">
      <ContentEditor onChange={noteEdit} />
    </SectionShell>
  );
}
