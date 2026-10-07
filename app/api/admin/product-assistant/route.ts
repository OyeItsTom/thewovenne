import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SUPABASE_URL } from "@/lib/supabase";
import { createRSCClient } from "@/lib/supabaseRSC";
import { chatConfigured } from "@/lib/chat";
import { consumeChatQuota } from "@/lib/chatQuota";
import { AI_LIMITS } from "@/lib/ai/limits";
import { finalizeDailyBudget, reserveDailyBudget } from "@/lib/ai/budget";
import { productImagePrefix, sanitiseAssistantRequest } from "@/lib/ai/productAssistant";
import { runProductAssistant } from "@/lib/ai/productAssistantServer";
import { decideGate } from "@/lib/ai/productAssistantGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One call with a 25 s timeout and at most one SDK retry.
export const maxDuration = 60;

/**
 * The admin's AI Product Assistant: copy suggestions for one product, from the
 * unsaved form's facts.
 *
 * Admin + aal2 only, checked here — the middleware matcher does not cover
 * /api/admin/*. The response is suggestions and nothing else: this route reads
 * no product row and writes none. The quota counter and the AI budget hold are
 * the only database calls it makes, and both happen after the gate.
 */
export async function POST(req: NextRequest) {
  const supabase = createRSCClient();

  // getUser() revalidates against Supabase rather than trusting the cookie.
  let userId: string | null = null;
  try {
    userId = (await supabase.auth.getUser()).data.user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) return new NextResponse("Not found", { status: 404 });
  const { data: isAdmin, error: isAdminError } = await supabase.rpc("is_admin");
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const gate = decideGate({ userId, isAdmin, isAdminError, aal });
  if (!gate.ok) return new NextResponse(gate.message, { status: gate.status });

  // After the gate, so an anonymous caller cannot learn the feature's state.
  if (!chatConfigured()) {
    return NextResponse.json(
      { error: "AI suggestions aren't configured — the Anthropic key is missing. Nothing in the form has changed." },
      { status: 503 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "The request was not understood." }, { status: 400 });
  }

  const limits = AI_LIMITS.productAssistant;
  const input = sanitiseAssistantRequest(raw, {
    imagePrefix: productImagePrefix(SUPABASE_URL),
    maxImages: limits.maxImages,
  });
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: limits.timeoutMs,
    maxRetries: 1,
  });

  // The admin's own allowance, keyed on a digest of their id — the same
  // counter as Ask Wovenne (0019), under a prefix of its own.
  const key = `assistant:${crypto.createHash("sha256").update(`wovenne:product-assistant:v1${gate.userId}`).digest("hex")}`;

  const result = await runProductAssistant(input.value, input.imagesDropped, {
    callModel: (params) => client.messages.create(params),
    consumeQuota: () => consumeChatQuota({ key, limit: limits.maxRequestsPerHour, signedIn: true }),
    reserve: (amount) => reserveDailyBudget(amount),
    finalize: (reservation, actual, usage) => finalizeDailyBudget(reservation, actual, usage),
    limits,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      {
        status: result.status,
        headers: result.retryAfterSec ? { "Retry-After": String(result.retryAfterSec) } : undefined,
      }
    );
  }
  return NextResponse.json(
    { suggestions: result.suggestions, imagesDropped: result.imagesDropped },
    { headers: { "Cache-Control": "no-store" } }
  );
}
