import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase";
import {
  ADMIN_ACTIVITY_COOKIE,
  activityCookieOptions,
  assessAdminActivity,
} from "./adminSession";

/**
 * The idle rule for /api/admin/*, which middleware never sees (its matcher
 * excludes /api).
 *
 * Each route still asks is_admin() itself — that is the authority check and it
 * stays where it was. This adds the two things is_admin() cannot know:
 *
 *   - whether the session still exists. getUser() asks Supabase, which refuses
 *     a token whose session was signed out; is_admin() only reads the token's
 *     claims, so on its own it would accept a signed-out admin's token until
 *     the token's natural expiry.
 *   - whether the privileged session has gone idle (lib/adminSession).
 *
 * Returns a response to send instead of running the route, or null to carry on.
 * No session at all is left to the route. Nor is a session below aal2: the
 * route's is_admin() refuses it, so a customer who wanders in here is refused
 * rather than signed out.
 */
export async function adminApiGate(request: NextRequest): Promise<NextResponse | null> {
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      // A route handler's request cookies are read-only; the browser keeps its
      // copy until middleware or the session endpoint clears it.
      setAll() {},
    },
  });

  // No session at all: nothing for this gate to judge. The route refuses an
  // anonymous caller its own way — some answer 404 so that a stranger cannot
  // tell "not allowed" from "not there", and this must not undo that.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  // A session that Supabase no longer recognises — signed out, revoked by the
  // idle rule — is refused HERE, because the route's is_admin() reads claims
  // only and would accept the token until it expired.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Your session has ended. Please sign in again.", expired: true },
      { status: 401 }
    );
  }
  const { activity, facts } = await assessAdminActivity(
    session.access_token,
    request.cookies.get(ADMIN_ACTIVITY_COOKIE)?.value
  );
  if (facts.aal !== "aal2") return null;

  if (activity === "expired") {
    // Revoke at Supabase so the refresh token in the browser is dead too.
    await supabase.auth.signOut({ scope: "local" });
    const res = NextResponse.json(
      { error: "Your admin session has ended. Please sign in again.", expired: true },
      { status: 401 }
    );
    res.cookies.set(ADMIN_ACTIVITY_COOKIE, "", { ...activityCookieOptions, maxAge: 0 });
    return res;
  }
  return null;
}
