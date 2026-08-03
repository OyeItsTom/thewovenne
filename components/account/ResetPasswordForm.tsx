"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import { getBrowserSupabase } from "@/lib/supabase";
import AuthShell from "./AuthShell";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import { setNewPassword, passwordProblem, AFTER_LOGIN } from "@/lib/customerAuth";

/**
 * Where the emailed reset link lands.
 *
 * The link carries a recovery token which Supabase exchanges for a session as
 * the page loads. Until that has happened there is nothing to update, so the
 * form waits rather than letting someone type a password into a page that
 * cannot save it.
 */
export default function ResetPasswordForm() {
  const router = useRouter();
  const [ready, setReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = getBrowserSupabase();

    // Either the session is already established, or it arrives moments later
    // as the token in the URL is exchanged — so both are handled.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setReady(true);
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
    router.push(AFTER_LOGIN);
    router.refresh();
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
        intro="Reset links last an hour, and can only be used once."
        footer={
          <Link href="/forgot-password" className="text-terracotta hover:underline">
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
