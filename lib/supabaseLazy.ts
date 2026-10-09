import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The browser session client, fetched on first use instead of shipped in the
 * page's initial JavaScript.
 *
 * supabase-js with its auth client is ~70 KB gzipped, and it was in the bundle
 * of every storefront page because components the layout always mounts — the
 * account icon, the cart sync, the wishlist heart on every card — imported
 * lib/supabase statically. Every one of them only touches the client inside an
 * effect or an event handler, after the page is already on screen, so none of
 * them needs it before hydration. Importing it here instead puts it in its own
 * chunk that loads after the page is interactive, and off the path to first
 * paint and first input.
 *
 * Same memoised client as getBrowserSupabase(): the dynamic import resolves to
 * the one module instance, so there is still exactly one session client.
 *
 * Use getBrowserSupabase() directly only where the code is already on a route
 * that needs the client up front (account forms, admin).
 */
export function loadBrowserSupabase(): Promise<SupabaseClient> {
  return import("./supabase").then((m) => m.getBrowserSupabase());
}
