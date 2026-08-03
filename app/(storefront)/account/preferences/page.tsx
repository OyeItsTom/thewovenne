import type { Metadata } from "next";
import { createRSCClient } from "@/lib/supabaseRSC";
import MarketingPreference from "@/components/account/MarketingPreference";
import LoyaltyPanel from "@/components/account/LoyaltyPanel";

export const metadata: Metadata = {
  title: "Your preferences | THE WOVENNE",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Where a customer decides what we may send them.
 *
 * Its own page rather than a line buried in a settings list, because this is
 * also the route by which accounts created BEFORE consent existed can opt in.
 * Nobody was opted in on their behalf.
 */
export default async function PreferencesPage() {
  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = user
    ? await supabase
        .from("profiles")
        .select("marketing_consent")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null };

  const consent = (data as { marketing_consent?: boolean } | null)?.marketing_consent ?? false;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-display-sm text-ink">Preferences</h1>
        <p className="mt-2 text-sm text-ink/60">What we may send you.</p>
      </div>

      <div className="space-y-6">
        {/* Renders nothing while the scheme is off. */}
        <LoyaltyPanel />
        <MarketingPreference initial={consent} />
      </div>
    </div>
  );
}
