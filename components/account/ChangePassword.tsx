"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { requestPasswordReset } from "@/lib/customerAuth";
import AuthMessage from "./AuthMessage";
import Button from "@/components/ui/Button";

/**
 * Settings → Password, for every kind of account: one button that emails
 * Supabase's own recovery link to the account's address.
 *
 * There is no password field here, current or new. The link proves the inbox
 * is theirs, which an open session alone does not: a borrowed or shared
 * browser is signed in too. The new password is chosen on /in/reset-password,
 * which only accepts a session that came from that link (recoverySessionOpen).
 * It is the same link "Forgot password?" sends, so there is one way to set a
 * password, not two.
 *
 * `hasPassword` (account_has_password, 0072) only picks the words: "Set a
 * password" for an account that signs in with Google only, "Change password"
 * for everyone else. The account stays the same user, with Google still linked.
 */
export default function ChangePassword({
  hasPassword = true,
  email = "",
}: {
  /** False for an account that signs in with Google only. */
  hasPassword?: boolean;
  email?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    const result = await requestPasswordReset(email);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSent(true);
  }

  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h2 className="font-heading text-xl text-ink">Password</h2>
      <p className="mt-3 text-sm leading-relaxed text-ink/70">
        {hasPassword
          ? "Use a secure email link to change your password."
          : "You currently sign in with Google. You can also create a password for this account."}
      </p>

      <div className="mt-4 space-y-4">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        {sent ? (
          <AuthMessage tone="success">
            We&apos;ve emailed a link to <span className="text-ink">{email}</span>. Open it in
            this browser within the hour to {hasPassword ? "choose a new password" : "set your password"}.
          </AuthMessage>
        ) : (
          <Button type="button" onClick={send} disabled={busy || !email}>
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Sending…
              </span>
            ) : hasPassword ? (
              "Change password"
            ) : (
              "Set a password"
            )}
          </Button>
        )}
      </div>
    </section>
  );
}
