import { getBrowserSupabase } from "./supabase";

/**
 * The ONE way an admin session ends in the browser — the Sign out button, the
 * idle countdown and the MFA page all come through here.
 *
 *   1. Supabase sign-out: revokes the session at Supabase and removes the
 *      session cookies. "global" for a deliberate sign-out, as before — it ends
 *      the admin's sessions on every device. "local" for a timeout, which should
 *      only end the session that went idle.
 *   2. The session endpoint's DELETE: clears the httpOnly activity record, which
 *      no script can reach, and expires any session cookie step 1 left behind.
 *   3. A FULL page load to the login page — not router.replace(). That throws
 *      away React state, the client router's cache of admin pages and the
 *      in-memory Supabase client, so nothing from the session survives in the
 *      tab. replace() also takes the page off the history stack.
 *
 * Every step runs even if the one before failed: a sign-out must never stall
 * halfway with the admin still looking at the dashboard.
 */
export type AdminSessionEnd = "signed-out" | "timeout";

export async function endAdminSession(reason: AdminSessionEnd): Promise<void> {
  try {
    await getBrowserSupabase().auth.signOut({ scope: reason === "timeout" ? "local" : "global" });
  } catch {
    /* step 2 revokes from the server instead */
  }
  try {
    await fetch("/api/admin/session", { method: "DELETE", cache: "no-store", credentials: "same-origin" });
  } catch {
    /* the cookies have a short life of their own */
  }
  window.location.replace(reason === "timeout" ? "/admin/login?timeout=1" : "/admin/login?signedout=1");
}
