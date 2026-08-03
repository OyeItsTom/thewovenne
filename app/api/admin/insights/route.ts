import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import Anthropic from "@anthropic-ai/sdk";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { chatConfigured, CHAT_MODEL, type ChatMessage } from "@/lib/chat";
import { gatherInsightsContext, INSIGHTS_SYSTEM } from "@/lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The admin's analytics chat.
 *
 * Separate from /api/chat by design, sharing only the Anthropic account. That
 * endpoint is public and capped; this one is admin-only and touches revenue.
 * Putting both behind one route would leave a prompt-injection surface one
 * mistake away from a customer-facing endpoint that can read takings.
 *
 * GATED HERE, not by middleware. The matcher covers /admin and /account, so
 * /api/admin/* is NOT intercepted — relying on it would have left this open to
 * anyone who guessed the path.
 *
 * The model receives a block of aggregates and nothing else: no database
 * handle, no query tool, no table names it can act on. It cannot be argued into
 * returning a customer row because it was never given the means to fetch one.
 */
export async function POST(req: NextRequest) {
  const store = cookies();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll() {},
    },
  });

  // getUser() revalidates against Supabase rather than trusting the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not found", { status: 404 });

  const { data: isAdmin, error: adminError } = await supabase.rpc("is_admin");
  if (adminError || isAdmin !== true) {
    // 404 rather than 403: a customer who guesses this path learns nothing
    // about what lives here.
    return new Response("Not found", { status: 404 });
  }

  // Same two-factor bar as the rest of /admin. A session that has not cleared
  // MFA should not be able to read revenue just because it skipped the pages
  // that enforce it.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const mfaSatisfied = aal?.nextLevel === "aal2" && aal.currentLevel === "aal2";
  if (!mfaSatisfied) {
    return new Response(
      "Finish two-factor verification before using the insights assistant.",
      { status: 403 }
    );
  }

  // Checked only once the caller is a verified admin. Ordering it before the
  // identity checks told an anonymous caller that this endpoint exists and what
  // state it is in — small, but it undoes the reason for answering 404 above.
  if (!chatConfigured()) {
    return new Response(
      "The insights assistant isn't configured — ANTHROPIC_API_KEY is missing.",
      { status: 503 }
    );
  }

  let body: { messages?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid request body.", { status: 400 });
  }

  const messages = (body.messages ?? []).filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
  );
  if (messages.length === 0) {
    return new Response("No messages provided.", { status: 400 });
  }

  try {
    const context = await gatherInsightsContext();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const stream = anthropic.messages.stream({
      model: CHAT_MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system: `${INSIGHTS_SYSTEM}\n\n${context}`,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let sent = false;
        try {
          stream.on("text", (delta: string) => {
            sent = true;
            controller.enqueue(encoder.encode(delta));
          });
          await stream.finalMessage();
          controller.close();
        } catch (err) {
          // The status line has already gone out, so an error here can only be
          // reported in-band. Saying nothing would look like a hung request.
          console.error("insights stream error:", err);
          if (!sent) {
            controller.enqueue(
              encoder.encode("Sorry — I couldn't read the numbers just now.")
            );
          }
          controller.close();
        }
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("insights route error:", err);
    return new Response("The insights assistant is unavailable right now.", {
      status: 500,
    });
  }
}
