"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import AuthShell from "./AuthShell";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import { verifySignupCode, resendSignupCode, AFTER_LOGIN } from "@/lib/customerAuth";
import { VERIFY_COPY, VERIFY_RESET_HREF, verifyLoginHref } from "@/lib/signupVerifyCopy";

/**
 * A typed code rather than a clicked link, for signup only.
 *
 * The customer is already here with the tab open. A link opens a second tab —
 * often a mail-app webview that does not share this session — and they end up
 * half-signed-up in two places. A code keeps them in one flow, which matters
 * most on a phone.
 *
 * Password reset uses a link instead: that token establishes a session when
 * clicked, and the user is usually on a different device by then anyway.
 *
 * This page cannot know whether a code was sent: Supabase answers a signup for
 * an already-registered address as if it were new, and sends nothing. So it
 * never claims one was, and it always offers the way back to logging in. See
 * lib/signupVerifyCopy for the wording rules.
 */
export default function VerifyForm({
  email,
  from,
}: {
  email: string;
  from?: string | null;
}) {
  const router = useRouter();

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSent(false);

    const result = await verifySignupCode(email, code);
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    // verifyOtp signs the customer in, so go straight where they were headed —
    // the checkout, if that is where they started. Relative paths only: an
    // absolute one would make this an open redirect.
    const onward =
      from && from.startsWith("/") && !from.startsWith("//") ? from : AFTER_LOGIN;
    router.push(onward);
    router.refresh();
  }

  async function resend() {
    setBusy(true);
    setError(null);
    const result = await resendSignupCode(email);
    setBusy(false);
    if (result.ok) setSent(true);
    else setError(result.error);
  }

  if (!email) {
    return (
      <AuthShell
        title="Verify your email"
        intro="We need to know which account to verify."
        footer={
          <Link href="/in/signup" className="text-terracotta hover:underline">
            Start again
          </Link>
        }
      >
        <AuthMessage tone="error">
          This link is missing its email address. Sign up again, or log in if you
          already have an account.
        </AuthMessage>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="One more step"
      title="Check your email"
      intro={VERIFY_COPY.intro(email)}
      footer={
        <>
          Wrong address?{" "}
          <Link href="/in/signup" className="text-terracotta hover:underline">
            Sign up again
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        {sent && (
          <AuthMessage tone="success">
            {VERIFY_COPY.resent}
          </AuthMessage>
        )}

        <AuthField
          label="Verification code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          hint={VERIFY_COPY.codeHint}
        />

        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking…
            </span>
          ) : (
            "Verify and continue"
          )}
        </Button>

        <button
          type="button"
          onClick={resend}
          disabled={busy}
          className="w-full text-center text-xs uppercase tracking-wider text-ink/50 transition-colors hover:text-terracotta disabled:opacity-40"
        >
          Send another code
        </button>
      </form>

      <div className="mt-8 border-t border-ink/10 pt-6 text-sm text-ink/70">
        <p>{VERIFY_COPY.existingAccount}</p>
        <p className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <Link href={verifyLoginHref(from)} className="text-terracotta hover:underline">
            Log in
          </Link>
          <Link href={VERIFY_RESET_HREF} className="text-terracotta hover:underline">
            Reset your password
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
