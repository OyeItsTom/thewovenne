import AdminHeader from "@/components/admin/AdminHeader";
import IdleTimeout from "@/components/admin/IdleTimeout";

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
      {/* Renders nothing until the session is nearly idle. Sits in the layout so
          it covers every admin screen including the login page — harmless
          there, since a signed-out visitor has no session to end. */}
      <IdleTimeout />
    </>
  );
}
