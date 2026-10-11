import type { NextRequest } from "next/server";
import { handleEvents, type IngestResult } from "@/lib/analyticsIngest";
import { createServiceClient } from "@/lib/supabase";

/**
 * First-party analytics collector. See lib/analyticsIngest for the rules,
 * migration 0068 for what is stored and docs/analytics.md for the design.
 * Writes nothing outside the production deployment, and nothing at all while
 * the database switch (analytics_config) is off.
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
      text: () => request.text(),
    },
    {
      env: process.env,
      secret: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
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
