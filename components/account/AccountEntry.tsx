"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { User } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import GuestAccountModal from "./GuestAccountModal";

/**
 * The person icon in the nav, which behaves differently depending on who is
 * holding it.
 *
 * Signed in  → a plain link straight to the account.
 * Guest      → opens the choice modal.
 * Not known yet → still a link. Until the session check comes back it renders
 *   as it always did, and middleware sends a guest who clicks it to the login
 *   page. Rendering nothing would make the icon flicker into existence on
 *   every page load; guessing "guest" would flash the modal at signed-in
 *   customers.
 *
 * The session is read in the browser rather than passed down from the server,
 * because the navbar is shared by statically rendered pages — asking the
 * server would make every one of them dynamic to decide the behaviour of one
 * icon.
 */
export default function AccountEntry({ href }: { href: string }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const supabase = getBrowserSupabase();

    supabase.auth.getUser().then(({ data }) => {
      if (active) setSignedIn(Boolean(data.user));
    });

    // Keeps the icon honest after a sign-in or sign-out in another tab.
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!active) return;
      setSignedIn(Boolean(session));
      if (session) setModalOpen(false);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  if (signedIn === false) {
    return (
      <>
        <button
          onClick={() => setModalOpen(true)}
          aria-label="Account"
          aria-haspopup="dialog"
          className="text-ink transition-colors hover:text-terracotta"
        >
          <User className="h-6 w-6" strokeWidth={1.5} />
        </button>
        <GuestAccountModal open={modalOpen} onClose={() => setModalOpen(false)} />
      </>
    );
  }

  return (
    <Link
      href={href}
      aria-label="Your account"
      className="text-ink transition-colors hover:text-terracotta"
    >
      <User className="h-6 w-6" strokeWidth={1.5} />
    </Link>
  );
}
