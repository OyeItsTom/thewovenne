"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
 */

const IDLE_MS = 15 * 60 * 1000;
const WARN_MS = 60 * 1000; // Warning appears with a minute left.
const ACTIVITY = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];

export default function IdleTimeout() {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const deadline = useRef(Date.now() + IDLE_MS);

  const signOut = useCallback(async () => {
    await getBrowserSupabase().auth.signOut({ scope: "local" });
    router.push("/admin/login?timeout=1");
    router.refresh();
  }, [router]);

  useEffect(() => {
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
        void signOut();
      } else if (remaining <= WARN_MS) {
        setSecondsLeft(Math.ceil(remaining / 1000));
      }
    }, 1000);

    return () => {
      ACTIVITY.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(tick);
    };
  }, [signOut]);

  if (secondsLeft === null) return null;

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
