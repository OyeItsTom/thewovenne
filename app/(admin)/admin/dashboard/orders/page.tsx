"use client";

import OrdersManager from "@/components/admin/OrdersManager";
import SectionShell from "@/components/admin/SectionShell";

export default function OrdersManagerSectionPage() {
  return (
    <SectionShell id="orders">
      <OrdersManager />
    </SectionShell>
  );
}
