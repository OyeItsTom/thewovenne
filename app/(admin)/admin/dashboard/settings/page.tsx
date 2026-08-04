"use client";

import StoreSettingsEditor from "@/components/admin/StoreSettingsEditor";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";

export default function StoreSettingsEditorSectionPage() {
  // onChange keeps the pending-changes bar honest: edits here are drafts, and
  // the bar is what says so.
  const { noteEdit } = useDashboard();

  return (
    <SectionShell id="settings">
      <StoreSettingsEditor onChange={noteEdit} />
    </SectionShell>
  );
}
