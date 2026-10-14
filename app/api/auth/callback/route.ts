import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase";
import { resolveOAuthReturn } from "@/lib/oauthReturn";

/**
 * Where Google sends a customer back, via Supabase.
 *
 * Under /api on purpose: middleware does not run here (its matcher excludes
 * /api), so the country-prefix redirect cannot bounce this URL and drop the
 * one-time code on the way.
 *
 *   1. Supabase redirects here with ?code= (PKCE). The code verifier is in a
 *      cookie the browser client wrote when the customer pressed the button.
 *   2. The code is exchanged for a session, whose cookies are written onto the
 *      redirect this returns.
 *   3. The account is checked the way the password form checks it, and the
 *      customer goes on to `next` once safeNext() has made sure it is a
 *      customer page on this site. The decisions live in resolveOAuthReturn,
 *      where they are tested; this file only connects them to Supabase.
 *
 * IDENTITY IS SUPABASE'S, NOT OURS. Supabase links a Google sign-in to an
 * existing account with the same VERIFIED email automatically, so a returning
 * customer arrives as the same auth user — same orders, wishlist, cart and
 * address. Nothing here merges, creates or looks up accounts.
 *
 * Every failure lands on the login page with a reason code, never on an error
 * page: the customer can always carry on with email and password.
 */
export async function GET(request: NextRequest) {
  // Cookies the exchange or a sign-out wants written, applied to the final
  // response once it is known which response that is.
  const pending: { name: string; value: string; options: Record<string, unknown> }[] = [];

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          pending.push({ name, value, options: options ?? {} })
        );
      },
    },
  });

  const target = await resolveOAuthReturn(request.nextUrl.searchParams, {
    async exchange(code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      // The error's name only — its message can echo request details.
      if (error) console.error("google callback: exchange failed:", error.name);
      return { ok: !error };
    },
    async getUser() {
      // Validated against Supabase, not read back from the cookie just made.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user
        ? { email: user.email ?? null, emailConfirmed: !!user.email_confirmed_at }
        : null;
    },
    async isStaff() {
      // Asked twice before giving up, as middleware does: the usual failure is
      // a blip. Unanswered is null, which the caller treats as "refuse".
      for (let attempt = 0; attempt < 2; attempt++) {
        const { data, error } = await supabase.rpc("is_staff");
        if (!error) return data === true;
      }
      return null;
    },
    async signOut() {
      await supabase.auth.signOut({ scope: "local" });
    },
  });

  const res = NextResponse.redirect(new URL(target, request.nextUrl.origin), 303);
  for (const c of pending) res.cookies.set(c.name, c.value, c.options);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
