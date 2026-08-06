import type { Metadata } from "next";
import { createRSCClient } from "@/lib/supabaseRSC";
import MarketingPreference from "@/components/account/MarketingPreference";
import LoyaltyPanel from "@/components/account/LoyaltyPanel";
import ChangePassword from "@/components/account/ChangePassword";
import DeliveryAddress from "@/components/account/DeliveryAddress";
import DangerZone from "@/components/account/DangerZone";

export const metadata: Metadata = {
  title: "Settings | THE WOVENNE",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Everything a customer occasionally needs to CHANGE, in one place.
 *
 * Previously these were scattered — password and account deletion sat under
 * the profile details, preferences had a tab of their own — which meant the
 * profile page was two unrelated things stacked on top of each other: who you
 * are, and levers you pull once a year.
 *
 * Order within the page is deliberate: the things people come for first
 * (password, address, what we may send them), then the loyalty panel, then
 * deletion last and visually separated.
 */
export default async function SettingsPage() {
  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = user
    ? await supabase
        .from("profiles")
        .select("marketing_consent, default_address, default_phone")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null };

  // The most recent order, used ONLY as a fallback below. RLS scopes this to
  // the customer's own orders.
  const { data: lastOrder } = user
    ? await supabase
        .from("orders")
        .select("shipping_address, customer_phone, created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const saved = profile as {
    marketing_consent?: boolean;
    default_address?: Record<string, string> | null;
    default_phone?: string | null;
  } | null;
  const consent = saved?.marketing_consent ?? false;

  // The SAVED address first — this panel writes to profiles.default_address
  // (migration 0035), and reading it back from the last order instead meant a
  // save was stored correctly and then never shown. With no orders yet the
  // form came back blank every time, which is indistinguishable from the
  // button not working, and is what it was reported as.
  //
  // The last order stays as a fallback, so a customer who ordered before this
  // field existed still sees something useful to confirm rather than retype.
  const lastOrderRow = lastOrder as {
    shipping_address?: Record<string, string> | null;
    customer_phone?: string | null;
  } | null;
  const addressForForm =
    saved?.default_address ?? lastOrderRow?.shipping_address ?? null;
  const phoneForForm = saved?.default_phone ?? lastOrderRow?.customer_phone ?? null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-display-sm text-ink">Settings</h1>
        <p className="mt-2 text-sm text-ink/60">
          How you sign in, where things are delivered, and what we may send you.
        </p>
      </div>

      <ChangePassword />

      <DeliveryAddress address={addressForForm} phone={phoneForForm} />

      <div className="space-y-6">
        {/* Renders nothing while the loyalty scheme is off. */}
        <LoyaltyPanel />
        <MarketingPreference initial={consent} />
      </div>

      {/* Last, and visually separated. Genuinely reachable — data deletion is a
          right, not a favour — but not something to hit while looking for
          something else. */}
      <DangerZone />
    </div>
  );
}
