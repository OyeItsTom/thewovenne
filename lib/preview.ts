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

export function previewEnabled(): boolean {
  try {
    return draftMode().isEnabled;
  } catch {
    // Called outside a request scope (e.g. a script) — never preview.
    return false;
  }
}

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
export function previewCtx(): ReadCtx {
  if (!previewEnabled()) return ANON_CTX;

  const store = cookies();
  const client = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      // A read-only render cannot set cookies. Supabase only writes here to
      // persist a refreshed token, which the next admin request redoes anyway.
      setAll() {},
    },
  }) as unknown as SupabaseClient;

  return { client, preview: true };
}
