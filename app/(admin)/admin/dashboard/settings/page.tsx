"use client";

import StoreSettingsEditor from "@/components/admin/StoreSettingsEditor";
import DeliverySettingsEditor from "@/components/admin/DeliverySettingsEditor";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";

export default function StoreSettingsEditorSectionPage() {
  // onChange keeps the pending-changes bar honest: edits here are drafts, and
  // the bar is what says so.
  const { noteEdit } = useDashboard();

  return (
    <SectionShell id="settings">
      <StoreSettingsEditor onChange={noteEdit} />

      {/* Delivery sits with the other operational settings rather than in a
          section of its own: an operator changing a courier price is doing the
          same kind of job as changing a VIP threshold, and should not have to
          go looking. */}
      <div className="mt-12">
        <DeliverySettingsEditor onChange={noteEdit} />
      </div>
    </SectionShell>
  );
}
