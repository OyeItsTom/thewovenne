import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";

// Fall back to placeholder values so the app can build/run before Supabase
// credentials are configured. Real queries will fail gracefully (handled by
// the callers in lib/products.ts) until valid env vars are provided.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

export const SUPABASE_URL = supabaseUrl;
export const SUPABASE_ANON_KEY = supabaseAnonKey;

/**
 * Anonymous client for PUBLIC data — products, categories, journal, site
 * content. Carries no session, so it behaves identically whether it runs in a
 * server component, a route handler or the browser, and RLS treats it as anon.
 *
 * Use this for anything a logged-out visitor could see. For anything that
 * depends on WHO is asking, use getBrowserSupabase() or createServerSupabase().
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

/**
 * Browser client backed by COOKIES rather than localStorage. Cookies are what
 * makes the session visible to middleware and server components — localStorage
 * is invisible to the server, which is why /admin could only ever be gated
 * client-side before.
 *
 * Lazy and memoised: constructing it reads document.cookie, so it must not run
 * during server rendering of a module that merely imports this file.
 */
let browserClient: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient {
  if (!browserClient) {
    browserClient = createBrowserClient(supabaseUrl, supabaseAnonKey);
  }
  return browserClient;
}

// Server-only client using the service role key. Bypasses RLS.
// Only import this inside API routes / server components, never client components.
export function createServiceClient() {
  return createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}
