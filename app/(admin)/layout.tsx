import AdminHeader from "@/components/admin/AdminHeader";

/**
 * Admin chrome only. The storefront's navbar, cart, chat and WhatsApp button
 * live in the (storefront) group and never render here.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AdminHeader />
      <main className="flex-1">{children}</main>
    </>
  );
}
