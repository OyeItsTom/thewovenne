"use client";

import { FormEvent, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Lock, Eye, EyeOff } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { checkAdmin } from "@/lib/auth";
import Button from "@/components/ui/Button";

export default function AdminLoginPage() {
  const router = useRouter();
  // Read from the URL rather than useSearchParams: that hook forces the page
  // behind a Suspense boundary that renders nothing on the server.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("timeout")) setNotice("You were signed out after 15 minutes of inactivity.");
    else if (p.get("retry")) setNotice("We couldn't verify your session just then. Please sign in again.");
    else if (p.get("denied")) setNotice("That account doesn't have admin access.");
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await getBrowserSupabase().auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setLoading(false);
      setError(signInError.message);
      return;
    }

    // Authenticating is not the same as being an admin — customers sign in to
    // the same Supabase project. Reject non-admins here instead of handing
    // them a dashboard that RLS would render empty.
    const admin = await checkAdmin();

    // Only sign out on a DEFINITE no. Signing out when the check merely failed
    // threw away a valid session over a network blip — which is what made a
    // refresh sometimes demand a second login.
    if (admin === "not-admin") {
      await getBrowserSupabase().auth.signOut({ scope: "local" });
      setLoading(false);
      setError("This account doesn't have admin access.");
      return;
    }
    if (admin === "unknown") {
      setLoading(false);
      setError(
        "We couldn't verify your access just then — you're still signed in. Please try again."
      );
      return;
    }

    setLoading(false);
    router.push("/admin/dashboard");
  };

  return (
    <div className="container-wovenne section-padding flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl bg-linen/60 p-8 sm:p-10">
        <div className="flex flex-col items-center">
          {/* Emblem + "Admin" label — deliberately plainer than the storefront,
              so it reads as a functional back-office screen. */}
          <div className="flex items-center gap-3">
            <Image
              src="/logo_emblem_transparent.png"
              alt=""
              width={3096}
              height={2792}
              priority
              sizes="48px"
              className="h-10 w-auto"
            />
            <span className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-xs uppercase tracking-widest text-cream">
              <Lock className="h-3 w-3" strokeWidth={2} /> Admin
            </span>
          </div>
          <h1 className="mt-4 font-heading text-3xl text-ink">Admin Login</h1>
          <p className="mt-1 text-sm text-ink/60">
            Sign in to manage THE WOVENNE catalogue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4">
          <label className="block text-sm">
            <span className="font-medium text-ink/70">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink/70">Password</span>
            <span className="relative mt-1 block">
              <input
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 pr-11 text-sm text-ink focus:border-terracotta focus:outline-none"
              />
              {/* Without this, a password mistyped unseen comes back as
                  "invalid credentials", which reads as "wrong account". */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-ink/40 transition-colors hover:text-ink"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </span>
          </label>

          {notice && !error && (
            <p className="rounded-lg bg-linen px-3 py-2 text-sm text-ink/70">
              {notice}
            </p>
          )}
          {error && <p className="text-sm text-terracotta-dark">{error}</p>}

          <Button type="submit" disabled={loading} size="lg" className="w-full">
            {loading ? "Signing in…" : "Sign In"}
          </Button>
        </form>
      </div>
    </div>
  );
}
