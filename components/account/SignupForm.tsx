"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import AuthShell from "./AuthShell";
import AuthField from "./AuthField";
import AuthMessage from "./AuthMessage";
import { signUp, passwordProblem } from "@/lib/customerAuth";

export default function SignupForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Checked here first so an obvious mismatch doesn't cost a round trip, and
    // doesn't burn one of Supabase's rate-limited signup attempts.
    const problem = passwordProblem(form.password, form.confirm);
    if (problem) return setError(problem);

    setBusy(true);
    const result = await signUp(form.email, form.password, form.fullName);
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    router.push(`/verify?email=${encodeURIComponent(form.email.trim().toLowerCase())}`);
  }

  return (
    <AuthShell
      eyebrow="Join us"
      title="Create an account"
      intro="Keep your orders and wishlist in one place. It takes a minute."
      footer={
        <>
          Already have one?{" "}
          <Link href="/login" className="text-terracotta hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}

        <AuthField
          label="Full name"
          required
          autoComplete="name"
          value={form.fullName}
          onChange={set("fullName")}
        />
        <AuthField
          label="Email"
          type="email"
          required
          autoComplete="email"
          value={form.email}
          onChange={set("email")}
          hint="We'll send a code here to confirm it's yours."
        />
        <AuthField
          label="Password"
          type="password"
          required
          autoComplete="new-password"
          value={form.password}
          onChange={set("password")}
          hint="At least 8 characters."
        />
        <AuthField
          label="Confirm password"
          type="password"
          required
          autoComplete="new-password"
          value={form.confirm}
          onChange={set("confirm")}
        />

        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Creating…
            </span>
          ) : (
            "Create account"
          )}
        </Button>

        {/* Guest checkout stays available, and this says so — an account should
            read as a convenience, not a toll gate. */}
        <p className="text-center text-xs text-ink/50">
          You can also{" "}
          <Link href="/shop" className="underline hover:text-terracotta">
            shop without an account
          </Link>
          .
        </p>
      </form>
    </AuthShell>
  );
}
