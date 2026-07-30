import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase";

/**
 * Session-aware client for server components and route handlers.
 *
 * Separate file from lib/supabase.ts because it imports next/headers, which
 * cannot be pulled into a client component — importing it there is a build
 * error, so the split keeps that mistake impossible.
 */
export function createServerSupabase() {
  const cookieStore = cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // Server components can't set cookies. Session refresh is handled by
        // middleware, which can — so swallowing this is correct rather than
        // lossy, and throwing here would break every read.
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          /* called from a server component — middleware owns the refresh */
        }
      },
    },
  });
}
