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
          <Link href="/signup" className="text-terracotta hover:underline">
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
      intro={`We've sent a code to ${email}. Enter it below to finish.`}
      footer={
        <>
          Wrong address?{" "}
          <Link href="/signup" className="text-terracotta hover:underline">
            Sign up again
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        {sent && (
          <AuthMessage tone="success">
            A new code is on its way. It can take a minute to arrive.
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
          hint="Six digits, from the email we just sent."
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
    </AuthShell>
  );
}
