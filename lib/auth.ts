import { getBrowserSupabase } from "./supabase";

/**
 * Whether the signed-in user is an admin, per profiles.is_admin.
 *
 * Calls the same SECURITY DEFINER `is_admin()` function the RLS policies use,
 * so the UI can't drift from what the database actually permits. RLS remains
 * the real boundary — this only decides what to render.
 *
 * THREE outcomes, not two. "We asked and the answer was no" and "we couldn't
 * ask" are different facts, and collapsing them into false was a bug: a network
 * blip or a token refreshing mid-flight looked identical to a revoked account,
 * so a legitimate admin got signed out and had to log in again.
 */
export type AdminCheck = "admin" | "not-admin" | "unknown";

export async function checkAdmin(): Promise<AdminCheck> {
  // One retry, because the common failure here is transient: a token being
  // refreshed, a cold start, a dropped connection. Two failures in a row is
  // more likely to be real.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await getBrowserSupabase().rpc("is_admin");
    if (!error) return data === true ? "admin" : "not-admin";
    console.error(`checkAdmin (attempt ${attempt + 1}):`, error.message);
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return "unknown";
}

/**
 * Convenience for callers that only render on a definite yes.
 *
 * Still fails closed — "unknown" is not admin — but callers that can act on the
 * distinction should use checkAdmin() and not throw the session away over it.
 */
export async function isCurrentUserAdmin(): Promise<boolean> {
  return (await checkAdmin()) === "admin";
}
