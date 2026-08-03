"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import AuthShell from "./AuthShell";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import { logIn, AFTER_LOGIN } from "@/lib/customerAuth";

export default function LoginForm({
  /** Set when the middleware turned someone away from a signed-in-only page,
      so they arrive knowing why rather than wondering what happened. */
  from,
  justVerified,
}: {
  from: string | null;
  justVerified: boolean;
}) {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUnverified(false);

    const result = await logIn(email, password);
    if (!result.ok) {
      setError(result.error);
      setUnverified(!!result.needsVerification);
      setBusy(false);
      return;
    }
    router.push(from && from.startsWith("/") ? from : AFTER_LOGIN);
    router.refresh();
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Log in"
      intro={
        from
          ? "Log in to see this page."
          : "Your orders, your wishlist, and a faster checkout."
      }
      footer={
        <>
          New here?{" "}
          <Link href="/signup" className="text-terracotta hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {justVerified && (
          <AuthMessage tone="success">
            Your email is verified. Log in to finish setting up.
          </AuthMessage>
        )}
        {error && (
          <AuthMessage tone="error">
            {error}
            {unverified && (
              <>
                {" "}
                <Link
                  href={`/verify?email=${encodeURIComponent(email)}`}
                  className="underline"
                >
                  Enter your code
                </Link>
                .
              </>
            )}
          </AuthMessage>
        )}

        <AuthField
          label="Email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label="Password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <div className="text-right">
          <Link
            href="/forgot-password"
            className="text-xs uppercase tracking-wider text-ink/50 hover:text-terracotta"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Logging in…
            </span>
          ) : (
            "Log in"
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
