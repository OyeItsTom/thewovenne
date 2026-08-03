import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

type AdminVerdict = "admin" | "not-admin" | "unknown";

/**
 * Ask the database whether this session is an admin.
 *
 * Retried once: the common failure is transient — a token being refreshed, a
 * cold start, a dropped connection — and one blip should not look the same as a
 * revoked account.
 */
async function checkIsAdmin(
  supabase: ReturnType<typeof createServerClient>
): Promise<AdminVerdict> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc("is_admin");
    if (!error) return data === true ? "admin" : "not-admin";
    console.error(`middleware is_admin (attempt ${attempt + 1}):`, error.message);
    if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
  }
  return "unknown";
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
  const isPublicAdminPath = PUBLIC_ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  // Customer area: a session is all it takes. No is_admin check and no MFA — a
  // shopper is not an operator, and demanding an authenticator app to open a
  // wishlist would be theatre rather than security. Kept as its own branch so
  // the customer gate can never be mistaken for the admin one.
  if (pathname.startsWith("/account")) {
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      // Sends them back where they were headed once they log in, and tells the
      // login page to say why it appeared.
      url.searchParams.set("from", pathname);
      return NextResponse.redirect(url);
    }
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

    // Fully verified admins have no reason to sit on the MFA page.
    if (!needsMfa && pathname === MFA_PATH) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  // A signed-in admin landing on the login page goes straight to the dashboard.
  if (pathname === "/admin/login" && user) {
    if ((await checkIsAdmin(supabase)) === "admin") {
      const url = request.nextUrl.clone();
      url.pathname = "/admin/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  // /account needs a session; /admin needs a session AND is_admin AND aal2.
  // Keeping the matcher tight means the rest of the storefront pays no
  // middleware cost, and static assets are never intercepted.
  matcher: ["/admin/:path*", "/account/:path*"],
};
