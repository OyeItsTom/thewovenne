"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import { getBrowserSupabase } from "@/lib/supabase";
import AuthShell from "./AuthShell";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import { setNewPassword, passwordProblem, logOut } from "@/lib/customerAuth";
import { PASSWORD_HINT } from "@/lib/passwordPolicy";
import { recoverySessionOpen } from "@/lib/signInMethods";

/**
 * Where the emailed reset link lands.
 *
 * The link carries a recovery token which Supabase exchanges for a session as
 * the page loads. Until that has happened there is nothing to update, so the
 * form waits rather than letting someone type a password into a page that
 * cannot save it.
 *
 * Only a session made BY that link opens the form (recoverySessionOpen). Any
 * other session, however it was signed in, gets "ask for a link" instead: this
 * page is the only place a password is set, and a signed-in browser on its own
 * is not proof of who is holding it. Settings, "Set a password" and "Forgot
 * password?" all send the same link here.
 *
 * ONE USE. The emailed code is single-use already, but the session it creates
 * is an ordinary, long-lived Supabase session, and Supabase keeps it when the
 * password changes (it signs out every OTHER session). Left alone, that browser
 * could come back here and change the password again. So once the new password
 * is saved, this session is signed out too, and another change needs another
 * email.
 */
export default function ResetPasswordForm() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = getBrowserSupabase();

    // Either the session is already established, or it arrives moments later
    // as the token in the URL is exchanged — so both are handled. The session
    // itself is checked rather than the PASSWORD_RECOVERY event, which the
    // shared client may have fired before this component subscribed.
    supabase.auth.getSession().then(({ data }) => {
      if (recoverySessionOpen(data.session?.access_token)) setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (recoverySessionOpen(session?.access_token)) setReady(true);
    });

    // If nothing has arrived by now the link was stale or already used.
    const timer = setTimeout(() => setReady((r) => (r === null ? false : r)), 2500);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = passwordProblem(password, confirm);
    if (problem) return setError(problem);

    setBusy(true);
    const result = await setNewPassword(password);
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    // End the recovery session (this device only; Supabase has already ended
    // the others). logOut also clears the persisted cart, as on any sign-out.
    await logOut();
    setBusy(false);
    setPassword("");
    setConfirm("");
    setSaved(true);
  }

  if (saved) {
    return (
      <AuthShell
        eyebrow="All set"
        title="Your password is saved"
        intro="For your security we've signed you out everywhere. Sign in again with your email and new password, or with Google if you use it."
        footer={
          <Link href="/in" className="text-terracotta hover:underline">
            Continue shopping
          </Link>
        }
      >
        <AuthMessage tone="success">
          Nothing else about your account has changed.
        </AuthMessage>
        <Link
          href="/in/login?from=%2Fin%2Faccount%2Fsettings"
          className="mt-5 block text-center text-sm text-ink hover:underline"
        >
          Sign in
        </Link>
      </AuthShell>
    );
  }

  if (ready === null) {
    return (
      <AuthShell title="Set a new password" intro="One moment…">
        <p className="text-center text-sm text-ink/50">Checking your link…</p>
      </AuthShell>
    );
  }

  if (!ready) {
    return (
      <AuthShell
        title="That link has expired"
        intro="Password links last an hour, work once, and must be opened in the browser you asked for them in."
        footer={
          <Link href="/in/forgot-password" className="text-terracotta hover:underline">
            Send a new link
          </Link>
        }
      >
        <AuthMessage tone="error">
          Ask for a fresh link and use it as soon as it arrives.
        </AuthMessage>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Almost done"
      title="Set a new password"
      intro="Choose something you'll remember. You'll be logged in straight away."
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}

        <AuthField
          label="New password"
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={PASSWORD_HINT}
        />
        <AuthField
          label="Confirm new password"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />

        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Saving…
            </span>
          ) : (
            "Save and continue"
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
