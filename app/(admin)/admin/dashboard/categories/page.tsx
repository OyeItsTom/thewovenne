"use client";

import CategoryManager from "@/components/admin/CategoryManager";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";

export default function CategoryManagerSectionPage() {
  // onChange keeps the pending-changes bar honest: edits here are drafts, and
  // the bar is what says so.
  const { noteEdit } = useDashboard();

  return (
    <SectionShell id="categories">
      <CategoryManager onChange={noteEdit} />
    </SectionShell>
  );
}
