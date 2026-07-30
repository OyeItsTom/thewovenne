"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound } from "lucide-react";
import { createClient } from "@supabase/supabase-js";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  getBrowserSupabase,
} from "@/lib/supabase";
import Button from "@/components/ui/Button";

const MIN_LENGTH = 12;

export default function AdminAccountPage() {
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getBrowserSupabase()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);

    if (next.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }
    if (next === current) {
      setError("The new password is the same as the current one.");
      return;
    }

    setBusy(true);

    // Supabase's updateUser() doesn't ask for the current password, so verify
    // it ourselves. This runs on a throwaway client with persistSession off:
    // signing in on the real one would replace the live session with a fresh
    // aal1 session and bounce you back through the MFA challenge.
    const verifier = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: wrongPassword } = await verifier.auth.signInWithPassword({
      email,
      password: current,
    });
    await verifier.auth.signOut();

    if (wrongPassword) {
      setBusy(false);
      setError("That current password isn't right.");
      return;
    }

    const { error: updateError } = await getBrowserSupabase().auth.updateUser({
      password: next,
    });
    setBusy(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setCurrent("");
    setNext("");
    setConfirm("");
    setDone(true);
  };

  return (
    <div className="container-wovenne section-padding">
      <Link
        href="/admin/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-ink/60 transition-colors hover:text-terracotta"
      >
        <ArrowLeft className="h-4 w-4" /> Back to dashboard
      </Link>

      <div className="mx-auto mt-8 w-full max-w-sm rounded-2xl bg-linen/60 p-8 sm:p-10">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink text-cream">
            <KeyRound className="h-5 w-5" strokeWidth={1.5} />
          </div>
          <h1 className="mt-4 font-heading text-3xl text-ink">Change password</h1>
          <p className="mt-1 text-sm text-ink/60">
            {email || "Loading…"}
          </p>
        </div>

        <form onSubmit={submit} className="mt-8 space-y-4">
          <Field
            label="Current password"
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
          />
          <Field
            label={`New password (${MIN_LENGTH}+ characters)`}
            autoComplete="new-password"
            value={next}
            onChange={setNext}
          />
          <Field
            label="Confirm new password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
          />

          {error && <p className="text-sm text-terracotta-dark">{error}</p>}
          {done && (
            <p className="rounded-lg bg-gold/15 px-3 py-2 text-sm text-ink">
              Password changed. Use the new one next time you sign in — your
              authenticator app is unaffected.
            </p>
          )}

          <Button
            type="submit"
            disabled={busy || !current || !next || !confirm}
            size="lg"
            className="w-full"
          >
            {busy ? "Updating…" : "Update Password"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      <input
        type="password"
        required
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
    </label>
  );
}
