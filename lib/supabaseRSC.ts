import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase";

/**
 * A Supabase client carrying the signed-in visitor's session.
 *
 * SERVER ONLY — it imports next/headers, so it must never end up in a client
 * component's import graph or the build fails. Reads go through RLS as that
 * user, which is the point: a customer's own rows come back and nothing else,
 * enforced by the database rather than by the query.
 */
export function createRSCClient(): SupabaseClient {
  const store = cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      // A render cannot set cookies; Supabase only writes here to persist a
      // refreshed token, which the next request redoes anyway.
      setAll() {},
    },
  }) as unknown as SupabaseClient;
}
