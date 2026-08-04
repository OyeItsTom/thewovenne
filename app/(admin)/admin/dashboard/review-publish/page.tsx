"use client";

import { useRouter } from "next/navigation";
import PublishQueue from "@/components/admin/PublishQueue";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";
import { sectionHref } from "@/lib/adminSections";

/**
 * Review & Publish.
 *
 * The queue's Edit links used to flip a tab; now they navigate. PublishQueue
 * still emits the old tab identifiers, and the section registry maps them to
 * routes — so the queue did not need to learn about routing, and a renamed URL
 * is a one-line change in one file.
 */
export default function ReviewPublishSectionPage() {
  const router = useRouter();
  const { noteEdit } = useDashboard();

  return (
    <SectionShell id="queue">
      <PublishQueue
        onChange={noteEdit}
        onEdit={(target) => {
          noteEdit();
          router.push(sectionHref(target));
        }}
      />
    </SectionShell>
  );
}
