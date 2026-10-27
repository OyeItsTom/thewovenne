"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import { getBrowserSupabase } from "@/lib/supabase";
import AuthShell from "./AuthShell";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import { setNewPassword, passwordProblem, logOut } from "@/lib/customerAuth";
import { PASSWORD_HINT } from "@/lib/passwordPolicy";
import {
  INITIAL_RECOVERY_VIEW,
  createRecoveryFlow,
  type RecoveryFlow,
  type RecoveryView,
} from "@/lib/passwordRecoveryFlow";

/** After this long, a check still running gets a note — never a verdict. */
const SLOW_MS = 10_000;

/**
 * Where the emailed reset link lands.
 *
 * Two kinds of link arrive here (see lib/passwordRecovery.ts):
 *
 *   NEW: `#token_hash=…&type=recovery`. Works on any device. Nothing is checked
 *   until the customer presses Continue — opening the page, a link preview or a
 *   mail scanner spends nothing — and the fragment leaves the address bar at
 *   once. Continue calls verifyOtp; the proof it yields is held in memory,
 *   bound to that user and session.
 *
 *   OLD: Supabase's own link, which returns with `?code=` and is exchanged by
 *   the browser client as the page loads. That only works in the browser that
 *   asked for it, and its session is stamped amr `recovery`. Still accepted, so
 *   links already in inboxes keep working where they always did.
 *
 * Only one of those opens the form. Any other session, however it was signed
 * in, gets "ask for a link" instead: this page is the only place a password is
 * set, and a signed-in browser on its own is not proof of who is holding it.
 * Settings, "Set a password" and "Forgot password?" all send the same link
 * here.
 *
 * What happens when — Continue, the checks, saving, and signing out a link's
 * session when the reset is abandoned — is lib/passwordRecoveryFlow.ts. This
 * component renders it.
 *
 * ONE USE. The emailed token is single-use already, but the session it creates
 * is an ordinary, long-lived Supabase session, and Supabase keeps it when the
 * password changes (it signs out every OTHER session). Left alone, that browser
 * could come back here and change the password again. So once the new password
 * is saved, this session is signed out too, and another change needs another
 * email.
 */
export default function ResetPasswordForm() {
  const [view, setView] = useState<RecoveryView>(INITIAL_RECOVERY_VIEW);
  const [slow, setSlow] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const flowRef = useRef<RecoveryFlow | null>(null);
  const { phase } = view;

  useEffect(() => {
    // Made once and kept across Strict Mode's second mount.
    flowRef.current ??= createRecoveryFlow(
      {
        auth: getBrowserSupabase().auth,
        savePassword: setNewPassword,
        signOutLocal: logOut,
        location: {
          href: () => window.location.href,
          replace: (path) => window.history.replaceState(window.history.state, "", path),
        },
      },
      setView
    );
    return flowRef.current.mount();
  }, []);

  useEffect(() => {
    setSlow(false);
    if (phase !== "checking" && phase !== "verifying") return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "saved") return;
    setPassword("");
    setConfirm("");
  }, [phase]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = passwordProblem(password, confirm);
    setProblem(found);
    if (found) return;
    await flowRef.current?.save(password);
  }

  const newLink = (
    <Link href="/in/forgot-password" className="text-terracotta hover:underline">
      Send a new link
    </Link>
  );
  const slowNote = slow && (
    <p className="mt-3 text-center text-sm text-ink/50">
      This is taking longer than usual. Check your connection; the page will carry on when it can.
    </p>
  );

  if (phase === "saved") {
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

  if (phase === "checking") {
    return (
      <AuthShell title="Set a new password" intro="One moment…">
        <p className="text-center text-sm text-ink/50">Checking your link…</p>
        {slowNote}
      </AuthShell>
    );
  }

  if (phase === "confirm" || phase === "verifying") {
    const verifying = phase === "verifying";
    return (
      <AuthShell
        eyebrow="Password reset"
        title="Set a new password"
        intro="Continue to confirm your link, then choose a new password. Each link works once."
        footer={newLink}
      >
        <div className="space-y-5">
          {view.notice && <AuthMessage tone="error">{view.notice}</AuthMessage>}
          {view.signedIn && (
            <p className="text-sm text-ink/70">
              Someone is already signed in on this browser. If you continue, this browser will switch to the account this link was sent to.
            </p>
          )}
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={verifying}
            onClick={() => void flowRef.current?.continueWithLink()}
          >
            {verifying ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking…
              </span>
            ) : (
              "Continue"
            )}
          </Button>
        </div>
        {slowNote}
      </AuthShell>
    );
  }

  if (phase === "invalid") {
    return (
      <AuthShell
        title="This link can't be used"
        intro="It may have expired, already been used, or been cut short when it was copied. Password links last an hour and work once."
        footer={newLink}
      >
        <AuthMessage tone="error">
          Ask for a fresh link and open it from the newest email.
        </AuthMessage>
      </AuthShell>
    );
  }

  if (phase === "otherBrowser") {
    return (
      <AuthShell
        title="Open this link where you asked for it"
        intro="This reset link only works once, in the browser it was requested from. To reset your password on this device, ask for a new link here."
        footer={newLink}
      >
        <AuthMessage tone="error">
          If you did open it in the same browser, it has already been used or has expired.
        </AuthMessage>
      </AuthShell>
    );
  }

  if (phase === "noLink" || phase === "closed") {
    return (
      <AuthShell
        title={phase === "closed" ? "This reset has ended" : "Open the link from your email"}
        intro={
          phase === "closed"
            ? "15 minutes have passed, or the account on this browser has changed, so we've closed this reset. For your security, ask for a new link."
            : "To set a new password, use the link in our password email. Being signed in isn't enough on its own. If you've just refreshed this page, that link has been used."
        }
        footer={newLink}
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
      intro="Choose a password you'll remember. Once it's saved, we'll sign you out so you can sign in again with your new password."
    >
      <form onSubmit={submit} className="space-y-5">
        {(problem ?? view.saveError) && <AuthMessage tone="error">{problem ?? view.saveError}</AuthMessage>}

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

        <Button type="submit" size="lg" className="w-full" disabled={view.saving}>
          {view.saving ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Saving…
            </span>
          ) : (
            "Save new password"
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
