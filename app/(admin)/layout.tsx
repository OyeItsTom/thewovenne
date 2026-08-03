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
          it covers every admin screen, and opts itself out on the login page —
          it was NOT harmless there: it kept firing over the login form. */}
      <IdleTimeout />
    </>
  );
}
