"use client";

import { FormEvent, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { isCurrentUserAdmin } from "@/lib/auth";
import Button from "@/components/ui/Button";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    const admin = await isCurrentUserAdmin();
    if (!admin) {
      await getBrowserSupabase().auth.signOut();
      setLoading(false);
      setError("This account doesn't have admin access.");
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
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
            />
          </label>

          {error && <p className="text-sm text-terracotta-dark">{error}</p>}

          <Button type="submit" disabled={loading} size="lg" className="w-full">
            {loading ? "Signing in…" : "Sign In"}
          </Button>
        </form>
      </div>
    </div>
  );
}
