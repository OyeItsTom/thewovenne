import { NextRequest } from "next/server";
import { streamChat, chatConfigured, CHAT_MODEL, type ChatMessage } from "@/lib/chat";
import {
  anonymousCaller,
  consumeChatQuota,
  quotaMessage,
  signedInCaller,
} from "@/lib/chatQuota";
import {
  beginTrace,
  classifyModelError,
  emitBudgetEvent,
  outcomeForBudgetStop,
} from "@/lib/ai/observability";
import {
  finalizeDailyBudget,
  RequestBudget,
  reserveDailyBudget,
  type DailyReservation,
} from "@/lib/ai/budget";
import { createRSCClient } from "@/lib/supabaseRSC";
import { getStoreSettings } from "@/lib/storeSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Ask Wovenne" web chat endpoint. Streams the assistant's reply back as plain
 * text tokens so the widget can render it live. Order tracking is gated on an
 * exact orderId + email match (handled in lib/chat).
 */
export async function POST(req: NextRequest) {
  // Opened first so that every way this request can end — including the ones
  // that never reach the model — leaves exactly one trace behind. A refusal
  // that logs nothing is indistinguishable from a request that never arrived,
  // and "how often are we turning people away?" is a question worth being able
  // to answer.
  //
  // The id stays server-side. It is not returned in a header or a body: it
  // correlates our own logs, and handing it to a caller would only invite it to
  // be quoted back at us as if it meant something.
  const trace = beginTrace({ model: CHAT_MODEL });

  // Checked before anything streams: once the response has started the status
  // code is already sent, and a key problem can only be reported in-band.
  if (!chatConfigured()) {
    console.error(
      "chat: ANTHROPIC_API_KEY is missing or not a real key — the concierge is disabled."
    );
    trace.finish("not_configured");
    return new Response(
      "Ask Wovenne isn't set up yet. Please message us on WhatsApp and we'll help straight away.",
      { status: 503 }
    );
  }

  let body: {
    messages?: ChatMessage[];
    orderId?: string | null;
    email?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    trace.finish("bad_request");
    return new Response("Invalid request body.", { status: 400 });
  }

  const messages = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
  );
  if (messages.length === 0) {
    trace.finish("bad_request");
    return new Response("No messages provided.", { status: 400 });
  }

  // The admin switch is checked on the server, not just by hiding the widget:
  // this endpoint is public, and a hidden widget still leaves it answering
  // anyone who calls it directly.
  const settings = await getStoreSettings();
  trace.setFeatureEnabled(Boolean(settings.ask_wovenne_enabled));
  if (!settings.ask_wovenne_enabled) {
    trace.finish("feature_disabled");
    return new Response(
      "Ask Wovenne is unavailable at the moment. Please message us on WhatsApp and we'll help straight away.",
      { status: 503 }
    );
  }

  // Enforced HERE rather than in the widget. A cap the browser applies is a
  // suggestion — this endpoint is public, and anything worth rate-limiting
  // against will call it directly rather than through the UI.
  //
  // Checked after validation but before the model call, so a rejected request
  // costs nothing, and a malformed one doesn't spend the caller's allowance.
  //
  // WHO IS ASKING IS DECIDED FROM THE SESSION COOKIE, NOT FROM THE BODY. A
  // signed-in customer gets the larger allowance; the browser cannot claim it by
  // sending a user id, because nothing here reads one. A failed session read is
  // treated as anonymous — the cautious direction, and the same conflation the
  // admin middleware was fixed for is not a risk here, since the consequence is
  // a smaller allowance rather than a denial.
  //
  // ONE MESSAGE COSTS ONE MESSAGE, whatever the concierge does next. A reply that
  // needs three lookups is three model calls and still a single spend — the cap
  // is on what the customer asked for, not on how hard the answer was to find.
  let caller = anonymousCaller(req);
  // The email is kept for the concierge as well as the quota: it is what turns
  // order tracking on. Verified here and passed down, never read from the body —
  // an email in a request body is a claim, and the concierge would be looking up
  // orders against it.
  let verifiedEmail: string | null = null;
  try {
    const {
      data: { user },
    } = await createRSCClient().auth.getUser();
    if (user) {
      caller = signedInCaller(user.id);
      verifiedEmail = user.email ?? null;
    }
  } catch (err) {
    console.error("chat: session read failed, treating as anonymous:", err);
  }

  // A classification, not an identity. The quota's own key is a stable hash of
  // the customer id and is deliberately NOT recorded — see lib/ai/observability.
  trace.setCaller(caller.signedIn ? "customer" : "guest");

  const quota = await consumeChatQuota(caller);
  if (!quota.allowed) {
    trace.finish("rate_limited");
    return new Response(quotaMessage(quota.resetAt), {
      status: 429,
      headers: { "Retry-After": "600" },
    });
  }

  // THE DAY'S ALLOWANCE — RESERVED, NOT CHECKED, BEFORE ANYTHING IS SPENT.
  //
  // Reading the total and then deciding would be a check-then-act: two requests
  // arriving together would both see room and both spend. This holds the
  // request's MAXIMUM possible cost in one atomic database statement, and gives
  // the difference back at settlement.
  //
  // Fails CLOSED on an unreachable store — "we could not check, so we assumed
  // it was fine" is how an outage becomes an invoice.
  //
  // The customer is told exactly what they are told for every other kind of
  // unavailability. What our ceiling is, and how close to it we are, is not
  // something a public endpoint should narrate.
  const daily = await reserveDailyBudget();
  if (!daily.allowed) {
    console.error(`chat: refusing to spend — ${daily.reason}: ${daily.detail}`);
    emitBudgetEvent(
      daily.reason === "daily_ceiling" ? "daily_budget_denied" : "daily_budget_unavailable",
      { traceId: trace.traceId, detail: daily.detail }
    );
    trace.finish(outcomeForBudgetStop(daily.reason));
    return new Response(
      "Ask Wovenne is unavailable at the moment. Please message us on WhatsApp and we'll help straight away.",
      { status: 503 }
    );
  }
  const reservation: DailyReservation | null = daily.reservation;
  if (reservation) {
    emitBudgetEvent("daily_budget_reserved", {
      traceId: trace.traceId,
      reservationId: reservation.id,
      amountUsd: reservation.amountUsd,
    });
  }

  // One allowance per turn, from the central config — no magic numbers here.
  const budget = new RequestBudget(CHAT_MODEL);
  let budgetStop: string | null = null;

  /**
   * Give back the difference between what was reserved and what was spent.
   *
   * Runs whichever way the turn ends, including a provider failure — a request
   * that errored after two model calls still cost what those two calls cost.
   * Never awaited on the customer's path and never allowed to throw: they
   * already have their answer, and reconciliation is our bookkeeping, not their
   * problem. A settlement that does not land is swept in full after its TTL,
   * which errs toward overcharging rather than losing track.
   */
  let settled = false;
  const settle = async () => {
    if (settled || !reservation) return;
    settled = true;
    const actual = budget.settlementCostUsd;
    const ok = await finalizeDailyBudget(reservation, actual, budget.usageForSettlement);
    if (ok) {
      emitBudgetEvent("daily_budget_reconciled", {
        traceId: trace.traceId,
        reservationId: reservation.id,
        amountUsd: reservation.amountUsd,
        actualUsd: actual,
      });
    } else {
      console.error(
        `chat: daily budget not reconciled for reservation ${reservation.id} — ` +
          "it will be swept at its full reserved amount."
      );
      emitBudgetEvent("reconciliation_failed", {
        traceId: trace.traceId,
        reservationId: reservation.id,
        amountUsd: reservation.amountUsd,
      });
    }
  };

  try {
    const replyStream = streamChat(messages, {
      orderId: body.orderId,
      // The session's address wins over anything the browser sent. The body form
      // still works for a caller that supplies both an id and an email (the
      // WhatsApp path, one day), but a signed-in customer never has to type
      // theirs — and cannot be talked into typing somebody else's.
      email: verifiedEmail ?? body.email,
      // Only the misses are logged. A tool that found what it was asked for is
      // the system working; a tool that found nothing is either a gap in the
      // catalogue or a piece whose story nobody has written yet, and both are
      // worth seeing without reading every transcript.
      onTool: (name, found) => {
        if (!found) console.warn(`concierge: ${name} found nothing`);
      },
      // Timings, tokens and tool names for this turn. The loop writes into it;
      // the stream below closes it exactly once, whichever way the turn ends.
      recorder: trace,
      // This turn's spend allowance, consulted before every model call.
      budget,
      onBudgetStop: (reason, detail) => {
        budgetStop = reason;
        console.warn(`chat: turn stopped on budget (${reason}) — ${detail}`);
      },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let sentAnything = false;
        try {
          // A generator now, not one Anthropic stream: a single customer message
          // can become several model calls with lookups between them, and this
          // side neither knows nor cares how many. Text arrives in order.
          for await (const delta of replyStream) {
            sentAnything = true;
            controller.enqueue(encoder.encode(delta));
          }
          // A tool that erred still produced an answer, so the turn succeeded —
          // but the outcome says which kind of success it was, and a tool error
          // is recorded in preference to "it worked" so a degraded reply is not
          // counted as a clean one.
          // A budget stop outranks both — the turn ended because we stopped it,
          // and recording that as an ordinary success would hide the one event
          // a spend dashboard most needs to see.
          trace.finish(
            budgetStop
              ? outcomeForBudgetStop(budgetStop)
              : trace.firstToolError() ??
                  (trace.toolCallCount > 0 ? "successful_with_tools" : "successful_no_tool")
          );
          void settle();
          controller.close();
        } catch (err) {
          // The status line has already gone out, so erroring the stream just
          // drops the connection and the widget shows nothing. Say something
          // useful instead and close cleanly; the log is what raises the alarm.
          console.error("chat stream error:", err);
          trace.finish(classifyModelError(err));
          // Settled on the failure path too: the calls that completed before
          // the error were still billed by the provider.
          void settle();
          if (!sentAnything) {
            controller.enqueue(
              encoder.encode(
                "Sorry — I can't reach my notes just now. Please try again, or message us on WhatsApp and we'll help straight away."
              )
            );
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (err) {
    console.error("chat route error:", err);
    trace.finish(classifyModelError(err));
    // The stream never started, so nothing was spent — but the reservation is
    // outstanding and must be released rather than left for the sweep.
    void settle();
    return new Response("Sorry — Ask Wovenne is unavailable right now.", {
      status: 500,
    });
  }
}
