"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase";
import { isCurrentUserAdmin } from "@/lib/auth";
import PublishBar from "@/components/admin/PublishBar";

/**
 * Everything every admin page needs, in one place: the session check, and the
 * pending-changes bar.
 *
 * IT LIVES IN THE LAYOUT ON PURPOSE. When the admin was one page with tabs,
 * both of these were written once and every tab inherited them. Splitting into
 * routes without this would have meant fourteen copies of the auth guard —
 * and the first section anyone forgot to copy it into would be a page that
 * renders for a signed-out visitor.
 *
 * A Next layout does not re-render on navigation, so this state survives
 * moving between sections rather than re-checking the session every click.
 */

interface DashboardCtx {
  /** Call after any edit so the pending-changes count re-reads. */
  noteEdit: () => void;
}

const Ctx = createContext<DashboardCtx>({ noteEdit: () => {} });

/**
 * Sections call this instead of being handed an onChange prop through four
 * levels of routing. Safe to call from anywhere under the dashboard layout.
 */
export function useDashboard() {
  return useContext(Ctx);
}

export default function DashboardChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  // Bumped whenever an edit lands, so the pending count re-reads without a
  // page refresh.
  const [publishKey, setPublishKey] = useState(0);
  const noteEdit = useCallback(() => setPublishKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;

    // A session alone is not enough — customers authenticate against the same
    // Supabase project. Admin access is decided by profiles.is_admin.
    //
    // Middleware already enforces this server-side before any HTML is sent;
    // this is the belt to its braces, and it also catches a session that dies
    // while the tab sits open.
    const verify = async () => {
      const { data } = await getBrowserSupabase().auth.getSession();
      if (!active) return;

      if (!data.session) {
        router.replace("/admin/login");
        return;
      }

      const admin = await isCurrentUserAdmin();
      if (!active) return;

      if (!admin) {
        // Signed in but not an admin: end the session rather than leave them
        // staring at a dashboard that RLS will render empty anyway.
        await getBrowserSupabase().auth.signOut();
        router.replace("/admin/login");
        return;
      }

      setCheckingAuth(false);
    };

    verify();

    const { data: listener } = getBrowserSupabase().auth.onAuthStateChange(
      (_e, session) => {
        if (!session) router.replace("/admin/login");
      }
    );
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [router]);

  if (checkingAuth) {
    return (
      <div className="container-wovenne section-padding text-center text-ink/60">
        Checking your session…
      </div>
    );
  }

  return (
    <Ctx.Provider value={{ noteEdit }}>
      <div className="container-wovenne section-padding">
        {/* Pending changes span every section, so the bar does too. Showing it
            only on the landing page would mean editing a price, walking away,
            and never seeing that it was still a draft. */}
        <PublishBar
          refreshKey={publishKey}
          onReview={() => router.push("/admin/dashboard/review-publish")}
        />
        <div className="mt-8">{children}</div>
      </div>
    </Ctx.Provider>
  );
}
