"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase";

/**
 * Signs an admin out after a spell of inactivity.
 *
 * The admin panel edits prices, reads customer addresses and moves orders, and
 * it is often left open on a shared desk. A session that lives until the tab
 * closes is a session anyone passing the machine inherits.
 *
 * Idle means no pointer, key, scroll or touch — not "no network activity", so a
 * page polling in the background does not keep it alive on nobody's behalf.
 *
 * NO CONFLICT WITH MFA. This ends the local session only; Supabase's own token
 * lifetimes are untouched. The next sign-in goes through password and the
 * authenticator again, because aal2 belongs to a session and this ends the
 * session. Sign-out is local scope — a global one would end it on every device
 * the admin is signed in on, which is not what a timeout should mean.
 *
 * IT MUST FIRE EXACTLY ONCE. A passed deadline stays passed, so the original
 * version re-ran the whole sign-out — network call, navigation and router
 * refresh — every second, indefinitely. Landing on the login page did not stop
 * it, and the next person to type their password had their brand-new session
 * signed out from under them about a second later. That is what made the Sign
 * In button look dead.
 */

const IDLE_MS = 15 * 60 * 1000;
const WARN_MS = 60 * 1000; // Warning appears with a minute left.
const ACTIVITY = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];

/**
 * There is nothing to time out on the login screen, and running there is
 * actively harmful: the timer used to keep firing after it had already signed
 * someone out, and every firing pushed a navigation over the login form while
 * they were trying to type into it.
 */
const NO_TIMEOUT_PATHS = ["/admin/login"];

export default function IdleTimeout() {
  const router = useRouter();
  const pathname = usePathname();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const deadline = useRef(Date.now() + IDLE_MS);
  // Signing out is a one-way door. Without this the interval re-fired every
  // second forever, because a passed deadline stays passed.
  const firedRef = useRef(false);

  const disabled = NO_TIMEOUT_PATHS.includes(pathname);

  const signOut = useCallback(async () => {
    if (firedRef.current) return;
    firedRef.current = true;
    await getBrowserSupabase().auth.signOut({ scope: "local" });
    router.replace("/admin/login?timeout=1");
    router.refresh();
  }, [router]);

  useEffect(() => {
    if (disabled) return;

    // A fresh mount on an admin page is a fresh 15 minutes — and re-arms the
    // timer for the next session if this component is reused after a sign-out.
    deadline.current = Date.now() + IDLE_MS;
    firedRef.current = false;

    const bump = () => {
      deadline.current = Date.now() + IDLE_MS;
      // Only clears the warning if one is showing; setState on every mousemove
      // would re-render the whole panel continuously.
      setSecondsLeft((s) => (s === null ? s : null));
    };

    // passive: these listeners must never delay scrolling.
    ACTIVITY.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const tick = setInterval(() => {
      const remaining = deadline.current - Date.now();
      if (remaining <= 0) {
        // Stop the clock before signing out, so a slow network response can't
        // let a second tick through.
        clearInterval(tick);
        setSecondsLeft(null);
        void signOut();
      } else if (remaining <= WARN_MS) {
        setSecondsLeft(Math.ceil(remaining / 1000));
      }
    }, 1000);

    return () => {
      ACTIVITY.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(tick);
    };
  }, [signOut, disabled]);

  if (disabled || secondsLeft === null) return null;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-terracotta/30 bg-ink text-cream"
    >
      <div className="container-wovenne flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <span>
          You&apos;ve been idle — signing out in{" "}
          <strong className="font-medium">{secondsLeft}s</strong>. Any unsaved
          edits will be lost.
        </span>
        <button
          onClick={() => {
            deadline.current = Date.now() + IDLE_MS;
            setSecondsLeft(null);
          }}
          className="rounded-full border border-cream/30 px-4 py-1.5 text-xs uppercase tracking-widest transition-colors hover:bg-cream hover:text-ink"
        >
          Stay signed in
        </button>
      </div>
    </div>
  );
}
