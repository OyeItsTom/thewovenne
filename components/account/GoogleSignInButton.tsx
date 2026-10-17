"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { startGoogleSignIn } from "@/lib/customerAuth";
import AuthMessage from "./AuthMessage";

/**
 * "Continue with Google", in Google's own neutral style: white, a thin grey
 * border, the four-colour G and Google's wording. Their branding rules ask for
 * exactly this, and a button dressed in the shop's terracotta would read as the
 * shop's own action rather than a different sign-in.
 *
 * Full width and the height of a large Button, matching the email one, so on
 * a phone both choices are the same size and neither looks secondary.
 *
 * Busy from the press until the browser leaves for Google. If the customer
 * comes BACK without finishing (the Back button restores this page from the
 * back/forward cache with its old state), `pageshow` clears the spinner, or
 * the button would sit disabled forever.
 */
export default function GoogleSignInButton({ from }: { from?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reset = () => setBusy(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  async function go() {
    setBusy(true);
    setError(null);
    const result = await startGoogleSignIn(from);
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="flex min-h-[56px] w-full items-center justify-center gap-3 rounded-full border border-[#747775] bg-white px-5 font-body text-base font-medium text-[#1f1f1f] transition-colors hover:bg-[#f8f9fa] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? (
          <Loader2 aria-hidden className="h-[18px] w-[18px] animate-spin" />
        ) : (
          <GoogleMark />
        )}
        <span>{busy ? "Opening Google…" : "Continue with Google"}</span>
      </button>
      {error && <AuthMessage tone="error">{error}</AuthMessage>}
      {/* Google skips the signup checkboxes, and a first Google sign-in from
          either page creates an account — so the terms are stated here, once,
          for both. "Use", not "receive": Google's basic profile also carries a
          picture link, which nothing here reads. */}
      <p className="text-center text-xs leading-relaxed text-ink/50">
        By continuing with Google you agree to our{" "}
        <Link href="/in/policies" className="underline underline-offset-2 hover:text-terracotta">
          Terms &amp; Privacy Policy
        </Link>
        . We use only your name and email address.
      </p>
    </div>
  );
}

/**
 * Off until the Google provider is configured in Supabase. With the provider
 * disabled, Supabase answers the button with a bare JSON error page — so the
 * button is not shown until NEXT_PUBLIC_GOOGLE_SIGN_IN is "true", set after the
 * dashboard steps are done. Inlined at build time, so changing it needs a
 * redeploy.
 */
export const GOOGLE_SIGN_IN_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN === "true";

/** The Google button and the "or" under it — or nothing, while switched off. */
export function GoogleSignInBlock({ from }: { from?: string | null }) {
  if (!GOOGLE_SIGN_IN_ENABLED) return null;
  return (
    <div className="mb-5 space-y-5">
      <GoogleSignInButton from={from} />
      <AuthDivider />
    </div>
  );
}

/** "or", between the two ways in. */
export function AuthDivider() {
  return (
    <div className="flex items-center gap-4 text-xs uppercase tracking-wider text-ink/40">
      <span className="h-px flex-1 bg-ink/10" />
      or
      <span className="h-px flex-1 bg-ink/10" />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" className="h-[18px] w-[18px]">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
