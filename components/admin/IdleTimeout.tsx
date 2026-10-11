"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ADMIN_IDLE_MS, HEARTBEAT_MS } from "@/lib/adminSession";
import { endAdminSession } from "@/lib/adminSessionClient";

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
 * THIS IS THE VISIBLE HALF. The rule itself is enforced on the server
 * (lib/adminSession): the tab reports activity at most once a minute, and a
 * session the server has not heard from in time is revoked the next time it
 * asks for anything — page or API. So a closed tab, a sleeping laptop or a
 * detour to the storefront no longer leaves a session that wakes up as admin.
 * This component gives the warning, ends the session on time when the tab IS
 * open, and keeps the server's record current while the admin works.
 *
 * NO CONFLICT WITH MFA. aal2 belongs to a session and this ends the session —
 * revoked at Supabase, not just forgotten — so the next sign-in goes through
 * password and the authenticator again. Local scope: a timeout ends this
 * session, not the admin's sessions on other devices.
 *
 * ONE SESSION, SEVERAL TABS. Every admin tab shares one session, so an idle tab
 * signing out would end the work in a busy one. Before signing out, the tab
 * asks the server when the admin was last active anywhere, and waits on if
 * that was recently.
 *
 * IT MUST FIRE EXACTLY ONCE. A passed deadline stays passed, so the original
 * version re-ran the whole sign-out — network call, navigation and router
 * refresh — every second, indefinitely. Landing on the login page did not stop
 * it, and the next person to type their password had their brand-new session
 * signed out from under them about a second later. That is what made the Sign
 * In button look dead.
 */

const IDLE_MS = ADMIN_IDLE_MS;
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
  const pathname = usePathname();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const deadline = useRef(Date.now() + IDLE_MS);
  // Signing out is a one-way door. Without this the interval re-fired every
  // second forever, because a passed deadline stays passed.
  const firedRef = useRef(false);
  // When the server last heard from this tab. Mounting counts: the page load
  // that mounted it went through middleware, which refreshed the record.
  const lastPing = useRef(Date.now());
  const checking = useRef(false);

  const disabled = NO_TIMEOUT_PATHS.includes(pathname);

  const signOut = useCallback(async () => {
    if (firedRef.current) return;
    firedRef.current = true;
    await endAdminSession("timeout");
  }, []);

  /** Tell the server the admin is here. A 401 means it has already ended the session. */
  const heartbeat = useCallback(async () => {
    lastPing.current = Date.now();
    try {
      const res = await fetch("/api/admin/session", { method: "POST", cache: "no-store" });
      if (res.status === 401) void signOut();
    } catch {
      // Offline for a moment: the next movement tries again.
      lastPing.current = 0;
    }
  }, [signOut]);

  /**
   * The countdown has run out HERE — but perhaps not everywhere. Returns true
   * if another tab has kept the session in use, having moved the deadline.
   */
  const activeElsewhere = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/admin/session", { cache: "no-store" });
      const body = (await res.json()) as { activity?: string; lastSeenMs?: number | null };
      if (body.activity === "expired" || typeof body.lastSeenMs !== "number") return false;
      const until = body.lastSeenMs + IDLE_MS;
      if (until - Date.now() <= 1000) return false;
      deadline.current = until;
      return true;
    } catch {
      // Can't ask: end it. Leaving an unattended admin session open because the
      // network was down is the wrong way to fail.
      return false;
    }
  }, []);

  // Back after signing out can restore an admin page from the browser's
  // back-forward cache without asking the server. A persisted pageshow is
  // exactly that, so reload: middleware then decides, and sends a signed-out
  // visitor to the login page.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  useEffect(() => {
    if (disabled) return;

    // A fresh mount on an admin page is a fresh 15 minutes — and re-arms the
    // timer for the next session if this component is reused after a sign-out.
    deadline.current = Date.now() + IDLE_MS;
    firedRef.current = false;
    lastPing.current = Date.now();

    const bump = () => {
      deadline.current = Date.now() + IDLE_MS;
      // Leading edge, at most once a minute: the first movement after a quiet
      // minute is reported straight away, so the server never trails by more.
      if (Date.now() - lastPing.current >= HEARTBEAT_MS) void heartbeat();
      // Only clears the warning if one is showing; setState on every mousemove
      // would re-render the whole panel continuously.
      setSecondsLeft((s) => (s === null ? s : null));
    };

    // passive: these listeners must never delay scrolling.
    ACTIVITY.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const tick = setInterval(() => {
      if (checking.current || firedRef.current) return;
      const remaining = deadline.current - Date.now();
      if (remaining <= 0) {
        // Hold the clock while the server is asked, so a slow response can't
        // let a second tick through.
        checking.current = true;
        void activeElsewhere().then((elsewhere) => {
          checking.current = false;
          if (elsewhere) {
            setSecondsLeft(null);
            return;
          }
          clearInterval(tick);
          setSecondsLeft(null);
          void signOut();
        });
      } else if (remaining <= WARN_MS) {
        setSecondsLeft(Math.ceil(remaining / 1000));
      }
    }, 1000);

    return () => {
      ACTIVITY.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(tick);
    };
  }, [signOut, heartbeat, activeElsewhere, disabled]);

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
