import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_COUNTRY, isCountry, isUnprefixed } from "./lib/country";
import {
  ADMIN_ACTIVITY_COOKIE,
  activityCookieOptions,
  assessAdminActivity,
  mintActivityCookie,
} from "./lib/adminSession";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

type AdminVerdict = "admin" | "not-admin" | "unknown";

/**
 * Ask the database whether this account is STAFF (is_staff, 0061).
 *
 * Deliberately not is_admin(): that means "may this session act as an admin",
 * which requires a two-factor-verified session (0062). Routing has to recognise
 * staff BEFORE the second factor — to send them to /admin/mfa, and to keep them
 * out of the customer area — so it asks the identity question. Authority is
 * still decided by is_admin() wherever data is read or written.
 *
 * Retried once: the common failure is transient — a token being refreshed, a
 * cold start, a dropped connection — and one blip should not look the same as a
 * revoked account.
 */
async function checkIsAdmin(
  supabase: ReturnType<typeof createServerClient>
): Promise<AdminVerdict> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc("is_staff");
    if (!error) return data === true ? "admin" : "not-admin";
    console.error(`middleware is_staff (attempt ${attempt + 1}):`, error.message);
    if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
  }
  return "unknown";
}

/**
 * How the privileged half of a session is doing — see lib/adminSession.
 * Only meaningful once getUser() has validated the token it reads.
 */
async function privilegedActivity(
  supabase: ReturnType<typeof createServerClient>,
  request: NextRequest
) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return assessAdminActivity(
    session?.access_token,
    request.cookies.get(ADMIN_ACTIVITY_COOKIE)?.value
  );
}

/** A background prefetch is not the admin doing anything, so it never counts as activity. */
function isPrefetch(request: NextRequest): boolean {
  return (
    request.headers.get("next-router-prefetch") === "1" ||
    request.headers.get("purpose") === "prefetch"
  );
}

/** Reachable without a session — everything else under /admin is gated. */
const PUBLIC_ADMIN_PATHS = ["/admin/login"];

/**
 * Requires a signed-in admin but is exempt from the aal2 requirement — it is
 * the page that grants aal2, so gating it on aal2 would be a closed loop.
 */
const MFA_PATH = "/admin/mfa";

/**
 * Gates /admin on the server, before any HTML is sent.
 *
 * Previously the guard was client-side only: /admin/dashboard returned 200 to
 * anyone, shipped its markup, then redirected once React hydrated. RLS meant no
 * data leaked, but the page shell did — and a guard that runs in the visitor's
 * browser is a guard the visitor controls.
 *
 * This also refreshes the auth cookie on every request, which is what keeps a
 * server-rendered session from silently expiring mid-visit.
 */
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // ── Country prefix ────────────────────────────
  // Anything storefront-shaped that is not already under a market is sent to
  // the default one. This covers the bare root AND every pre-launch URL that
  // may already be indexed or bookmarked — /shop, /women/sarees/kerala-kasavu
  // — so nothing 404s and rankings carry across instead of starting again.
  //
  // 308, not 307: this is permanent, and search engines only transfer ranking
  // signals for a permanent redirect.
  if (!isUnprefixed(path)) {
    const first = path.split("/")[1] ?? "";
    if (!isCountry(first)) {
      const url = request.nextUrl.clone();
      url.pathname = path === "/" ? `/${DEFAULT_COUNTRY}` : `/${DEFAULT_COUNTRY}${path}`;
      return NextResponse.redirect(url, 308);
    }
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // getUser() revalidates against Supabase rather than trusting the cookie's
  // contents. getSession() would read the cookie as-is, which is forgeable.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isAdminArea = pathname.startsWith("/admin");
  // /in/account/... — the gate moved with the routes. Matching "/account"
  // literally here would have silently stopped guarding anything.
  const accountPath = /^\/[a-z]{2}\/account(\/|$)/.test(pathname);
  const isPublicAdminPath = PUBLIC_ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  // Customer area: a session — any session, staff included. No MFA — a shopper is
  // not an operator, and demanding an authenticator app to open a wishlist
  // would be theatre rather than security. Kept as its own branch so the
  // customer gate can never be mistaken for the admin one.
  if (accountPath) {
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = `/${pathname.split("/")[1]}/login`;
      // Sends them back where they were headed once they log in, and tells the
      // login page to say why it appeared.
      url.searchParams.set("from", pathname);
      return NextResponse.redirect(url);
    }

    // Staff browsing the shop get the shop's account, like anyone else. The
    // person icon is a customer entry point; the way into admin is /admin, on
    // its own login and its own second factor.
    //
    // This used to send any staff account to /admin/dashboard, which made the
    // icon an admin shortcut. It was also standing in for a real problem: the
    // account pages leaned on RLS alone to mean "mine", and RLS lets a verified
    // admin read every order. Those reads are now filtered to the signed-in
    // person explicitly (lib/orders getMyOrders and friends), so an admin here
    // sees their own account and nobody else's.
    return response;
  }

  if (isAdminArea && !isPublicAdminPath) {
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin/login";
      return NextResponse.redirect(url);
    }

    // Authenticated is not the same as admin — customers will authenticate
    // against this same project. Ask the database, don't infer.
    //
    // "The answer was no" and "we couldn't ask" are different facts. Treating a
    // failed call as a denial is what made a refresh occasionally bounce a
    // legitimate admin to the login screen, so the two are separated and the
    // call is retried once — the usual cause is a token refreshing mid-flight.
    const verdict = await checkIsAdmin(supabase);

    if (verdict === "not-admin") {
      const url = request.nextUrl.clone();
      url.pathname = "/admin/login";
      url.searchParams.set("denied", "1");
      return NextResponse.redirect(url);
    }
    if (verdict === "unknown") {
      // Still fails closed — no access — but says what actually happened
      // instead of accusing a valid admin of not having permission.
      const url = request.nextUrl.clone();
      url.pathname = "/admin/login";
      url.searchParams.set("retry", "1");
      return NextResponse.redirect(url);
    }

    // Two-factor is mandatory. getUser() above already validated this token
    // against Supabase, so its assurance-level claim is authentic.
    //
    //   nextLevel aal2 + currentLevel aal1 → enrolled, needs this session verified
    //   nextLevel aal1                     → no factor at all, needs enrolment
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const needsMfa =
      aal?.nextLevel === "aal2" ? aal.currentLevel !== "aal2" : true;

    if (needsMfa && pathname !== MFA_PATH) {
      const url = request.nextUrl.clone();
      url.pathname = MFA_PATH;
      url.search = "";
      return NextResponse.redirect(url);
    }

    // Verified — but is the privileged session still alive? A refreshed token
    // keeps its aal2 claim indefinitely, so the claim alone cannot tell an admin
    // at the desk from a laptop opened the next morning. The activity record can.
    if (!needsMfa) {
      const { activity, facts } = await privilegedActivity(supabase, request);

      if (activity === "expired") {
        // Revoked at Supabase, not just forgotten here: signOut ends the session
        // server-side, so its refresh token can never mint another aal2 token.
        // The cleared cookies are written into `response` by setAll above and
        // copied onto the redirect, or the browser would keep them.
        await supabase.auth.signOut({ scope: "local" });
        const url = request.nextUrl.clone();
        url.pathname = "/admin/login";
        url.search = "?timeout=1";
        const redirect = NextResponse.redirect(url);
        response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
        redirect.cookies.set(ADMIN_ACTIVITY_COOKIE, "", { ...activityCookieOptions, maxAge: 0 });
        return redirect;
      }

      if (facts.sessionId && !isPrefetch(request)) {
        const value = await mintActivityCookie(facts.sessionId, Date.now());
        if (value) response.cookies.set(ADMIN_ACTIVITY_COOKIE, value, activityCookieOptions);
      }
    }

    // Fully verified admins have no reason to sit on the MFA page.
    if (!needsMfa && pathname === MFA_PATH) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  // The login page, with a session already attached.
  //
  // A FULLY VERIFIED admin has no reason to be here — send them to the
  // dashboard. But a session that stopped at the password step is a different
  // thing entirely, and treating the two alike is what made signing out feel
  // broken: the redirect sent a half-finished session to the dashboard, the
  // dashboard bounced it to /admin/mfa, and the admin arrived at a 2FA prompt
  // having typed nothing. It looked like the app had skipped the password step
  // and remembered a session they had just ended.
  //
  // Asking for the login page means "I want to log in". So an unverified
  // session is ended here and the form is shown. Local scope only — this
  // clears the cookies on this device without touching other sessions.
  //
  // "Verified" includes still being alive: an idle-expired session is ended
  // here like any other, rather than sent to a dashboard that would only end it.
  if (pathname === "/admin/login" && user) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const verified =
      aal?.nextLevel === "aal2" &&
      aal.currentLevel === "aal2" &&
      (await privilegedActivity(supabase, request)).activity !== "expired";

    if (verified && (await checkIsAdmin(supabase)) === "admin") {
      const url = request.nextUrl.clone();
      url.pathname = "/admin/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // signOut writes the cleared cookies through setAll above, which rebuilds
    // `response`. It must be returned as-is — a redirect here would be a
    // different response object and would drop the clearing.
    await supabase.auth.signOut({ scope: "local" });
    response.cookies.set(ADMIN_ACTIVITY_COOKIE, "", { ...activityCookieOptions, maxAge: 0 });
    return response;
  }

  return response;
}

export const config = {
  // Wider than before by necessity: the country prefix redirect must run on
  // paths that have no route (a bare /shop), which a tight matcher would never
  // see. /admin and /in/account are still gated inside.
  // Everything except static assets and API routes, because the country
  // redirect has to see paths that no longer have a route of their own.
  // Excluding _next and files with an extension keeps the cost off assets.
  matcher: ["/((?!api|_next/static|_next/image|.*\\.[\\w]+$).*)"],
};
