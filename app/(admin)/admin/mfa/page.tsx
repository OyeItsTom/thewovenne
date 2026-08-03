"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import Button from "@/components/ui/Button";

type Mode = "loading" | "enroll" | "challenge" | "failed";

/**
 * Two-factor for admin. One page, two modes:
 *  - no verified factor yet  → enrol (QR + confirm with a code)
 *  - verified factor exists  → challenge (code only)
 *
 * Middleware decides who lands here; this page only asks the database what
 * factors exist and renders accordingly.
 */
export default function AdminMfaPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("loading");
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    const supabase = getBrowserSupabase();
    setError(null);
    setMode("loading");

    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      // Leaving mode at "loading" here left the page reading "Preparing…"
      // under a "Set up two-factor" heading with no control on it at all —
      // no retry, no explanation, and no clue that anything had failed.
      setError(listError.message);
      setMode("failed");
      return;
    }

    const verified = data.totp.find((f) => f.status === "verified");
    if (verified) {
      setFactorId(verified.id);
      setMode("challenge");
      return;
    }

    // Abandoned enrolments pile up otherwise — every visit that doesn't finish
    // would leave another unverified factor behind, against the project cap.
    for (const stale of data.all.filter((f) => f.status === "unverified")) {
      await supabase.auth.mfa.unenroll({ factorId: stale.id });
    }

    const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Authenticator",
    });
    if (enrollError) {
      setError(enrollError.message);
      setMode("failed");
      return;
    }

    setFactorId(enrolled.id);
    setQr(enrolled.totp.qr_code);
    setSecret(enrolled.totp.secret);
    setMode("enroll");
  }, []);

  useEffect(() => {
    start();
  }, [start]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const { error: verifyError } = await getBrowserSupabase().auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });
    if (verifyError) {
      setBusy(false);
      setError(
        verifyError.message.toLowerCase().includes("invalid")
          ? "That code didn't match. Codes change every 30 seconds — try the current one."
          : verifyError.message
      );
      setCode("");
      return;
    }

    // A full page load, for the same reason as the login page: it guarantees
    // middleware re-evaluates against the now-aal2 cookie, and it cannot serve
    // a dashboard cached under the old assurance level. router.replace() left
    // the address bar reading /admin/mfa when a refresh() raced it, and busy
    // stays true so the button does not flick back to "Verify" on the way out.
    window.location.assign("/admin/dashboard");
  };

  const signOut = async () => {
    await getBrowserSupabase().auth.signOut();
    router.replace("/admin/login");
  };

  return (
    <div className="container-wovenne section-padding flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl bg-linen/60 p-8 sm:p-10">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink text-cream">
            <ShieldCheck className="h-5 w-5" strokeWidth={1.5} />
          </div>
          {/* The heading has to wait for listFactors. Announcing "Set up
              two-factor" while still loading told admins who already have an
              authenticator that they were about to enrol a new one. */}
          <h1 className="mt-4 font-heading text-3xl text-ink">
            {mode === "challenge"
              ? "Enter your code"
              : mode === "enroll"
                ? "Set up two-factor"
                : "Two-factor"}
          </h1>
          <p className="mt-1 text-sm text-ink/60">
            {mode === "challenge"
              ? "Open your authenticator app and enter the current 6-digit code."
              : mode === "enroll"
                ? "Scan this with Microsoft Authenticator, Google Authenticator, or any TOTP app."
                : "Checking how this account is set up."}
          </p>
        </div>

        {mode === "loading" && (
          <p className="mt-8 text-center text-sm text-ink/50">Preparing…</p>
        )}

        {mode === "failed" && (
          <div className="mt-8 text-center">
            <p className="text-sm text-terracotta-dark">{error}</p>
            <p className="mt-2 text-xs text-ink/50">
              Your sign-in is still valid — this is only the two-factor check.
            </p>
            <Button
              type="button"
              onClick={start}
              size="lg"
              className="mt-4 w-full"
            >
              Try again
            </Button>
          </div>
        )}

        {mode === "enroll" && qr && (
          <div className="mt-6 flex flex-col items-center">
            <div className="rounded-xl bg-cream p-3">
              {/* qr_code is an SVG data URI — nothing for the optimizer to do. */}
              <Image src={qr} alt="" width={200} height={200} unoptimized />
            </div>
            <details className="mt-3 text-xs text-ink/50">
              <summary className="cursor-pointer">Can&apos;t scan it?</summary>
              <p className="mt-2 break-all font-mono text-[11px] text-ink/70">
                {secret}
              </p>
            </details>
          </div>
        )}

        {(mode === "enroll" || mode === "challenge") && (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <label className="block text-sm">
              <span className="font-medium text-ink/70">6-digit code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-center font-mono text-lg tracking-[0.4em] text-ink focus:border-terracotta focus:outline-none"
              />
            </label>

            {error && <p className="text-sm text-terracotta-dark">{error}</p>}

            <Button
              type="submit"
              disabled={busy || code.length !== 6}
              size="lg"
              className="w-full"
            >
              {busy
                ? "Checking…"
                : mode === "enroll"
                  ? "Confirm & Continue"
                  : "Verify"}
            </Button>
          </form>
        )}

        {mode === "enroll" && (
          <p className="mt-4 text-center text-xs text-ink/50">
            Keep this authenticator safe. Losing it locks you out of the admin —
            recovery needs the service role key.
          </p>
        )}

        {/* Without this a half-finished enrolment traps you on this page. */}
        <button
          onClick={signOut}
          className="mt-6 w-full text-center text-xs text-ink/40 transition-colors hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
