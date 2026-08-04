import DashboardChrome from "@/components/admin/DashboardChrome";

/**
 * Wraps the dashboard landing page and every section beneath it.
 *
 * The session check and the pending-changes bar live in DashboardChrome, so a
 * new section inherits both by existing — there is no step where someone has
 * to remember to add them.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardChrome>{children}</DashboardChrome>;
}
