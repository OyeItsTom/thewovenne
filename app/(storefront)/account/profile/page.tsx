import type { Metadata } from "next";
import { createRSCClient } from "@/lib/supabaseRSC";
import ProfileForm from "@/components/account/ProfileForm";
import ChangePassword from "@/components/account/ChangePassword";
import DangerZone from "@/components/account/DangerZone";

export const metadata: Metadata = {
  title: "Your profile | THE WOVENNE",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = user
    ? await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null };

  const profile = (data as { full_name?: string; email?: string } | null) ?? null;

  // Phone is not on the profile: it is captured per order at checkout, because
  // a delivery number can differ from order to order. The most recent one is
  // shown so the page is not silent about something we clearly hold.
  const { data: lastOrder } = user
    ? await supabase
        .from("orders")
        .select("customer_phone")
        .not("customer_phone", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-display-sm text-ink">Profile</h1>
        <p className="mt-2 text-sm text-ink/60">
          Your details, and how you sign in.
        </p>
      </div>

      <ProfileForm
        initialName={profile?.full_name ?? ""}
        email={profile?.email ?? user?.email ?? ""}
        lastPhone={(lastOrder as { customer_phone?: string } | null)?.customer_phone ?? null}
      />

      <ChangePassword />

      {/* Last, and visually separated. Genuinely reachable — data-deletion is a
          right, not a favour — but not something to hit while looking for
          something else. */}
      <DangerZone />
    </div>
  );
}
