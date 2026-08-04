"use client";

import JournalManager from "@/components/admin/JournalManager";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";

export default function JournalManagerSectionPage() {
  // onChange keeps the pending-changes bar honest: edits here are drafts, and
  // the bar is what says so.
  const { noteEdit } = useDashboard();

  return (
    <SectionShell id="journal">
      <JournalManager onChange={noteEdit} />
    </SectionShell>
  );
}
