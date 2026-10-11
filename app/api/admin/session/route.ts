import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import {
  ADMIN_ACTIVITY_COOKIE,
  activityCookieOptions,
  assessAdminActivity,
  isSupabaseAuthCookie,
  mintActivityCookie,
} from "@/lib/adminSession";

/**
 * The admin tab's line to the server-side idle record (lib/adminSession).
 *
 *   GET    — how the privileged session stands, without counting as activity.
 *            The countdown asks this before signing out, so an idle tab does not
 *            end a session the admin is actively using in another tab.
 *   POST   — "the admin is here": refreshes the record, at most once a minute.
 *   DELETE — sign-out. Revokes whatever session is left and clears the cookies
 *            the browser cannot clear itself (the record is httpOnly).
 *
 * Never cached: every answer is about one session at one moment.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function clientFor(request: NextRequest, response: { current: NextResponse }) {
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.current.cookies.set(name, value, options)
        );
      },
    },
  });
}

async function standing(request: NextRequest, response: { current: NextResponse }) {
  const supabase = clientFor(request, response);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, activity: null, facts: null, lastSeenMs: null };
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const verdict = await assessAdminActivity(
    session?.access_token,
    request.cookies.get(ADMIN_ACTIVITY_COOKIE)?.value
  );
  return { supabase, user, ...verdict };
}

export async function GET(request: NextRequest) {
  const response = { current: NextResponse.json({}, { headers: NO_STORE }) };
  const s = await standing(request, response);
  const body =
    !s.user || s.facts?.aal !== "aal2"
      ? { activity: "expired" as const, lastSeenMs: null }
      : { activity: s.activity, lastSeenMs: s.lastSeenMs };
  const res = NextResponse.json(body, { headers: NO_STORE });
  response.current.cookies.getAll().forEach((c) => res.cookies.set(c));
  return res;
}

export async function POST(request: NextRequest) {
  const response = { current: NextResponse.json({ ok: true }, { headers: NO_STORE }) };
  const s = await standing(request, response);

  if (!s.user || s.facts?.aal !== "aal2" || !s.facts.sessionId) {
    return NextResponse.json({ error: "Not signed in.", expired: true }, { status: 401, headers: NO_STORE });
  }

  // Only a real admin gets an activity record. is_admin() is the authority
  // check (staff AND aal2), the same one every admin policy uses.
  const { data: isAdmin } = await s.supabase.rpc("is_admin");
  if (isAdmin !== true) {
    return NextResponse.json({ error: "Not an admin." }, { status: 403, headers: NO_STORE });
  }

  if (s.activity === "expired") {
    // Too late to keep alive: end it properly rather than reviving it.
    await s.supabase.auth.signOut({ scope: "local" });
    const res = NextResponse.json(
      { error: "Your admin session has ended.", expired: true },
      { status: 401, headers: NO_STORE }
    );
    response.current.cookies.getAll().forEach((c) => res.cookies.set(c));
    res.cookies.set(ADMIN_ACTIVITY_COOKIE, "", { ...activityCookieOptions, maxAge: 0 });
    return res;
  }

  const value = await mintActivityCookie(s.facts.sessionId, Date.now());
  if (value) response.current.cookies.set(ADMIN_ACTIVITY_COOKIE, value, activityCookieOptions);
  return response.current;
}

export async function DELETE(request: NextRequest) {
  const response = { current: NextResponse.json({ ok: true }, { headers: NO_STORE }) };
  const supabase = clientFor(request, response);

  // Normally the browser has already signed out and there is nothing left. If
  // that call failed, this revokes the session from here instead.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) await supabase.auth.signOut({ scope: "local" });

  // Belt and braces: whatever session cookies arrived with this request are
  // expired, so a sign-out cannot leave a usable refresh token in the jar even
  // if Supabase was unreachable. Only Supabase's auth cookies and the activity
  // record — the cart, preferences and everything else are left alone.
  for (const { name } of request.cookies.getAll()) {
    if (isSupabaseAuthCookie(name)) {
      response.current.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
  }
  response.current.cookies.set(ADMIN_ACTIVITY_COOKIE, "", { ...activityCookieOptions, maxAge: 0 });
  return response.current;
}
