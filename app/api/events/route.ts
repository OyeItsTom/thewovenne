import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import { handleEvents, type IngestResult } from "@/lib/analyticsIngest";
import { createServiceClient } from "@/lib/supabase";

/**
 * First-party analytics collector. See lib/analyticsIngest for the rules and
 * migration 0068 for what is stored. Writes nothing unless
 * NEXT_PUBLIC_ANALYTICS_ENABLED=1 on the production deployment.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleEvents(
    {
      method: request.method,
      url: request.url,
      headers: request.headers,
      cookie: (name) => request.cookies.get(name)?.value,
      hasAuthCookie: request.cookies.getAll().some((c) => /^sb-.+-auth-token/.test(c.name)),
      text: () => request.text(),
    },
    {
      env: process.env,
      secret: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      getUserId: async () => {
        const supabase = createServerClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          // Read-only: a refreshed token is the page's business, not a beacon's.
          { cookies: { getAll: () => request.cookies.getAll(), setAll: () => {} } }
        );
        const { data } = await supabase.auth.getUser();
        return data.user?.id ?? null;
      },
      ingest: async (rateKey, context, events) => {
        const { data, error } = await createServiceClient().rpc("analytics_ingest", {
          p_rate_key: rateKey,
          p_context: context,
          p_events: events,
        });
        if (error) throw new Error(error.message);
        return data as IngestResult;
      },
    }
  );
}
