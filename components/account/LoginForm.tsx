"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import AuthShell from "./AuthShell";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import { GoogleSignInBlock } from "./GoogleSignInButton";
import { logIn, AFTER_LOGIN } from "@/lib/customerAuth";
import { safeNext } from "@/lib/safeRedirect";
import { OAUTH_FAILURE_COPY, type OAuthFailure } from "@/lib/oauthReturn";

export default function LoginForm({
  /** Set when the middleware turned someone away from a signed-in-only page,
      so they arrive knowing why rather than wondering what happened. */
  from,
  justVerified,
  /** Set when a Google sign-in came back without finishing. */
  oauthFailure = null,
}: {
  from: string | null;
  justVerified: boolean;
  oauthFailure?: OAuthFailure | null;
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
    // safeNext, not a startsWith("/") check: that let `//other-site` through,
    // which the browser reads as a different host.
    router.push(safeNext(from, AFTER_LOGIN));
    router.refresh();
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Log in"
      intro={
        // From the checkout, say so: "see this page" reads as if they were
        // locked out, when they chose to sign in and their basket is waiting.
        from?.startsWith("/in/checkout")
          ? "Log in to carry on to checkout. Your basket is saved."
          : from
            ? "Log in to see this page."
            : "Your orders, your wishlist, and a faster checkout."
      }
      footer={
        <>
          New here?{" "}
          <Link
            href={safeNext(from, "") ? `/in/signup?from=${encodeURIComponent(safeNext(from))}` : "/in/signup"}
            className="text-terracotta hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      {/* Google first, the email form below an "or". Both full-width and the
          same height, so neither reads as the lesser option. A Google return
          that did not finish is explained here, above both, because it is
          about the whole page rather than a field. */}
      {oauthFailure && (
        <div className="mb-5">
          <AuthMessage tone="error">{OAUTH_FAILURE_COPY[oauthFailure]}</AuthMessage>
        </div>
      )}
      <GoogleSignInBlock from={from} />

      <form onSubmit={submit} className="space-y-5">
        {justVerified && (
          <AuthMessage tone="success">
            Your email is verified. Log in to finish setting up.
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

        {/* Directly under the password, not above the email field. Nearly every
            error this shows is about the password, and at the top of the form
            it sat off-screen on a phone once the keyboard was up: the customer
            saw the button do nothing and tried the same password again. It
            belongs next to the field it is talking about. */}
        {error && (
          <AuthMessage tone="error">
            {error}
            {unverified && (
              <>
                {" "}
                <Link
                  href={`/in/verify?email=${encodeURIComponent(email)}`}
                  className="underline"
                >
                  Enter your code
                </Link>
                .
              </>
            )}
          </AuthMessage>
        )}

        <div className="text-right">
          <Link
            href="/in/forgot-password"
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
