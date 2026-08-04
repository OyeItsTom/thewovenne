"use client";

import ReviewsManager from "@/components/admin/ReviewsManager";
import SectionShell from "@/components/admin/SectionShell";

export default function ReviewsManagerSectionPage() {
  return (
    <SectionShell id="reviews">
      <ReviewsManager />
    </SectionShell>
  );
}
