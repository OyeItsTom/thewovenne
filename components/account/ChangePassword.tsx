"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { passwordProblem, requestPasswordReset, setNewPassword } from "@/lib/customerAuth";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import Button from "@/components/ui/Button";

/**
 * Change the password, current one required.
 *
 * Supabase's updateUser does not ask for the current password — an open session
 * is enough. That is too weak for a shared or borrowed machine, so it is
 * re-verified here by signing in with it first. Without that, anyone who found
 * a logged-in browser could lock the owner out of their own account.
 */
export default function ChangePassword({
  hasPassword = true,
  email = "",
}: {
  /** False for an account that signs in with Google only. */
  hasPassword?: boolean;
  email?: string;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A Google-only account has no current password to confirm, so it gets the
  // one thing it can do instead: have a set-a-password link emailed.
  if (!hasPassword) return <SetPasswordByEmail email={email} />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);

    const problem = passwordProblem(next, confirm);
    if (problem) return setError(problem);

    setBusy(true);
    const supabase = getBrowserSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) {
      setBusy(false);
      return setError("You need to be logged in.");
    }

    // Re-authenticate. This refreshes the session rather than replacing it, so
    // it does not sign the customer out mid-change.
    const { error: checkError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: current,
    });
    if (checkError) {
      setBusy(false);
      return setError("That current password isn't right.");
    }

    const result = await setNewPassword(next);
    setBusy(false);
    if (!result.ok) return setError(result.error);

    setCurrent("");
    setNext("");
    setConfirm("");
    setDone(true);
  }

  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h2 className="font-heading text-xl text-ink">Password</h2>

      <form onSubmit={submit} className="mt-4 space-y-4">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        {done && <AuthMessage tone="success">Your password is changed.</AuthMessage>}

        <AuthField
          label="Current password"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <AuthField
          label="New password"
          type="password"
          required
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint="At least 8 characters."
        />
        <AuthField
          label="Confirm new password"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />

        <Button type="submit" disabled={busy}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Changing…
            </span>
          ) : (
            "Change password"
          )}
        </Button>
      </form>
    </section>
  );
}

/**
 * The Password panel for an account that signs in with Google only.
 *
 * Adding a password goes through Supabase's own emailed recovery link, which
 * proves the inbox is theirs (the same proof Google gave) rather than trusting
 * an open session alone. The link opens /in/reset-password, where the new
 * password is set without an old one; the account stays the same user, with
 * Google still linked.
 *
 * One action, sent to the account's own address: no second "forgot password"
 * link, and no retyping an email the page already knows.
 */
function SetPasswordByEmail({ email }: { email: string }) {
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
        You currently sign in with Google.
      </p>
      <p className="mt-1 text-sm leading-relaxed text-ink/60">
        Want to also sign in with email and password?
      </p>

      <div className="mt-4 space-y-4">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        {sent ? (
          <AuthMessage tone="success">
            We&apos;ve emailed a link to <span className="text-ink">{email}</span>. Open it in
            this browser to set your password.
          </AuthMessage>
        ) : (
          <Button type="button" onClick={send} disabled={busy || !email}>
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Sending…
              </span>
            ) : (
              "Set a password"
            )}
          </Button>
        )}
      </div>
    </section>
  );
}
