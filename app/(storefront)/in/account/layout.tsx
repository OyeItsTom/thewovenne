import AccountNav from "@/components/account/AccountNav";
import AccountSignOut from "@/components/account/AccountSignOut";

/**
 * Shared frame for every account page.
 *
 * One layout rather than each page repeating the sidebar, so a new section
 * cannot arrive with the navigation subtly different.
 */
export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="container-wovenne section-padding">
      <div className="text-center">
        <p className="eyebrow">Your account</p>
      </div>

      <div className="mt-10 flex flex-col gap-8 lg:flex-row lg:gap-12">
        <aside className="lg:w-56 lg:shrink-0">
          <AccountNav />
          <div className="hidden lg:mt-6 lg:block lg:pl-5">
            <AccountSignOut />
          </div>
        </aside>

        <div className="min-w-0 flex-1">{children}</div>

        <div className="lg:hidden">
          <AccountSignOut />
        </div>
      </div>
    </div>
  );
}
