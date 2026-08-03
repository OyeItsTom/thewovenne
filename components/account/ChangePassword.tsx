"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { passwordProblem, setNewPassword } from "@/lib/customerAuth";
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
export default function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
