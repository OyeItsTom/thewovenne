import { cache } from "react";
import { cookies, draftMode } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase";
import { ANON_CTX, type ReadCtx } from "./readCtx";

/**
 * Preview mode — an admin viewing the real storefront rendered from DRAFTS,
 * so unpublished work can be checked in place before it goes live.
 *
 * Built on Next's draft mode rather than a query parameter, because the flag
 * lives in an httpOnly cookie: it cannot be linked to a customer, shared by
 * accident, or crawled. The cookie is only ever set by /api/preview, which
 * checks is_admin() first.
 *
 * draftMode() is treated specially by Next: at build time it reads false and
 * the page still generates statically, and only a request carrying the cookie
 * renders dynamically. So this costs the normal storefront nothing.
 *
 * SERVER ONLY. This module imports next/headers, so it must never be reachable
 * from a client component — that is why the read functions themselves take a
 * ReadCtx instead of calling in here.
 */

/**
 * The Supabase client for THIS request, built from its cookies.
 *
 * Memoised per request: a storefront page calls previewCtx() several times
 * (content, products, categories…) and each would otherwise build a client and
 * re-ask the database the same question.
 */
const requestClient = cache((): SupabaseClient => {
  const store = cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      // A read-only render cannot set cookies. Supabase only writes here to
      // persist a refreshed token, which the next admin request redoes anyway.
      setAll() {},
    },
  }) as unknown as SupabaseClient;
});

/**
 * Is this request previewing?
 *
 * The draft cookie ALONE is not enough, and treating it as enough is what let
 * preview leak. Next's draft cookie is independent of the Supabase session:
 * nothing clears it when an admin signs out, and /api/preview/exit only runs if
 * someone presses the button. So an admin who previewed and then logged out
 * left a browser that still claimed to be previewing — and the next person to
 * use it, guest or customer, got the banner.
 *
 * Preview is therefore DERIVED: the cookie says what was asked for, is_admin()
 * says whether it is still allowed. A stale cookie is now inert rather than
 * something to be cleaned up, which matters because the cookie cannot be
 * cleared from a render — only from a route handler or server action.
 *
 * Cost is paid only by requests that actually carry the cookie. A normal
 * visitor short-circuits on the first line and the page stays static, so the
 * caching work in #74 is untouched.
 */
export const previewEnabled = cache(async (): Promise<boolean> => {
  let flagged = false;
  try {
    flagged = draftMode().isEnabled;
  } catch {
    // Called outside a request scope (e.g. a script) — never preview.
    return false;
  }
  if (!flagged) return false;

  const { data, error } = await requestClient().rpc("is_admin");
  return !error && data === true;
});

/**
 * The context for this request.
 *
 * In preview the client must carry the admin's session, because RLS exposes
 * draft rows to admins only — the visibility rule is enforced by the database,
 * not by this choice.
 *
 * cookies() is only touched when previewing; calling it unconditionally would
 * make every storefront page dynamic and lose ISR for real visitors.
 */
export async function previewCtx(): Promise<ReadCtx> {
  if (!(await previewEnabled())) return ANON_CTX;
  return { client: requestClient(), preview: true };
}
