import { createClient } from "@supabase/supabase-js";

// Fall back to placeholder values so the app can build/run before Supabase
// credentials are configured. Real queries will fail gracefully (handled by
// the callers in lib/products.ts) until valid env vars are provided.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

// Browser / general client — respects Row Level Security.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-only client using the service role key. Bypasses RLS.
// Only import this inside API routes / server components, never client components.
export function createServiceClient() {
  return createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}
