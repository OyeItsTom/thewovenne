"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import Button from "@/components/ui/Button";

/**
 * Name, email and the delivery phone we last saw.
 *
 * Only the name is editable here. Changing the email means re-verifying it —
 * Supabase sends a confirmation to both addresses — and quietly letting someone
 * type over it would leave the account signing in with an address that was never
 * proven. That belongs in its own flow, not a text field on a profile page.
 */
export default function ProfileForm({
  initialName,
  email,
  lastPhone,
}: {
  initialName: string;
  email: string;
  lastPhone: string | null;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const supabase = getBrowserSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      return setError("You need to be logged in.");
    }

    // 0004 grants UPDATE on (email, full_name, marketing_consent) only, so this
    // cannot reach is_admin however the request is shaped.
    const { error: saveError } = await supabase
      .from("profiles")
      .update({ full_name: name.trim() })
      .eq("id", user.id);

    setBusy(false);
    if (saveError) return setError(saveError.message);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h2 className="font-heading text-xl text-ink">Your details</h2>

      <form onSubmit={save} className="mt-4 space-y-4">
        <AuthField
          label="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
        />

        <div>
          <span className="text-sm font-medium text-ink/70">Email</span>
          <p className="mt-1 rounded-lg border border-ink/10 bg-linen/40 px-3 py-2.5 text-sm text-ink/70">
            {email}
          </p>
          <p className="mt-1 text-xs text-ink/50">
            This is how you sign in. To change it, email us and we&apos;ll move
            your account across — it needs verifying at both addresses.
          </p>
        </div>

        <div>
          <span className="text-sm font-medium text-ink/70">Delivery phone</span>
          <p className="mt-1 rounded-lg border border-ink/10 bg-linen/40 px-3 py-2.5 text-sm text-ink/70">
            {lastPhone || "Not given yet"}
          </p>
          <p className="mt-1 text-xs text-ink/50">
            Taken from your most recent order. You can enter a different number
            at checkout each time.
          </p>
        </div>

        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        {saved && <AuthMessage tone="success">Saved.</AuthMessage>}

        <Button type="submit" disabled={busy || name.trim() === initialName}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Saving…
            </span>
          ) : (
            "Save changes"
          )}
        </Button>
      </form>
    </section>
  );
}
