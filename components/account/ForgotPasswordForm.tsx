"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import AuthShell from "./AuthShell";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import { requestPasswordReset } from "@/lib/customerAuth";

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await requestPasswordReset(email);
    setBusy(false);
    if (result.ok) setDone(true);
    else setError(result.error);
  }

  return (
    <AuthShell
      eyebrow="No trouble"
      title="Reset your password"
      intro={
        done
          ? undefined
          : "Tell us your email and we'll send a link to set a new password."
      }
      footer={
        <Link href="/in/login" className="text-terracotta hover:underline">
          Back to log in
        </Link>
      }
    >
      {done ? (
        // Deliberately the same message whether or not the address exists.
        // Saying "no account with that email" turns this form into a way to
        // find out who shops here.
        <AuthMessage tone="success">
          If there&apos;s an account for {email}, a reset link is on its way. It
          expires in an hour — check spam if it hasn&apos;t arrived in a few
          minutes.
        </AuthMessage>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {error && <AuthMessage tone="error">{error}</AuthMessage>}

          <AuthField
            label="Email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Sending…
              </span>
            ) : (
              "Send reset link"
            )}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
