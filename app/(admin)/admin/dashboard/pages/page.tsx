"use client";

import PagesManager from "@/components/admin/PagesManager";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";

export default function PagesManagerSectionPage() {
  // onChange keeps the pending-changes bar honest: edits here are drafts, and
  // the bar is what says so.
  const { noteEdit } = useDashboard();

  return (
    <SectionShell id="pages">
      <PagesManager onChange={noteEdit} />
    </SectionShell>
  );
}
