"use client";

import CouponManager from "@/components/admin/CouponManager";
import SectionShell from "@/components/admin/SectionShell";

export default function CouponsSectionPage() {
  return (
    <SectionShell id="coupons">
      <CouponManager />
    </SectionShell>
  );
}
