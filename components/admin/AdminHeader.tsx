"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { KeyRound, Lock, LogOut } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";

/**
 * Admin chrome. Deliberately not the storefront Navbar — no category links, no
 * cart, no wishlist, no chat widget. An admin shouldn't be one stray click from
 * the shopping basket while editing the catalogue.
 */
export default function AdminHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    getBrowserSupabase()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? null));
  }, [pathname]);

  const signOut = async () => {
    await getBrowserSupabase().auth.signOut();
    router.replace("/admin/login");
  };

  return (
    <header className="border-b border-ink/10 bg-cream">
      <div className="container-wovenne flex items-center justify-between gap-4 py-3">
        <Link
          href="/admin/dashboard"
          className="flex items-center gap-2.5 font-heading text-xl tracking-wide text-ink"
        >
          <Image
            src="/logo_emblem_transparent.png"
            alt=""
            width={3096}
            height={2792}
            priority
            sizes="32px"
            className="h-7 w-auto"
          />
          THE WOVENNE
          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[10px] uppercase tracking-widest text-cream">
            <Lock className="h-2.5 w-2.5" strokeWidth={2.5} /> Admin
          </span>
        </Link>

        {email && (
          <div className="flex items-center gap-4">
            <span className="hidden text-xs text-ink/50 sm:block">{email}</span>
            <Link
              href="/admin/account"
              aria-label="Account settings"
              className="text-ink/50 transition-colors hover:text-terracotta"
            >
              <KeyRound className="h-4 w-4" />
            </Link>
            <button
              onClick={signOut}
              aria-label="Sign out"
              className="text-ink/50 transition-colors hover:text-terracotta"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
