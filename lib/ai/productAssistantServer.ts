/**
 * One press of "Suggest with AI", from rate limit to validated suggestions.
 *
 * ══ ORDER, AND WHY ══
 *
 *   1. the admin's hourly allowance   — a refused press costs nothing
 *   2. a hold on the day's AI budget  — the shared ceiling, reserved atomically (0059)
 *   3. the per-request ceiling        — unpriced model or exhausted budget: no call
 *   4. ONE model call                 — structured output, timeout, no loop
 *   5. settle the hold                — whichever way the call ended
 *   6. validate and check claims      — or discard the answer entirely
 *   7. one trace line and one summary line, metadata only
 *
 * Authentication is not here: the route establishes an aal2 admin before this
 * runs, and nothing in this file can be reached without that.
 *
 * ══ IT WRITES NOTHING ══
 *
 * The only database calls on this path are the quota counter and the budget
 * hold, both through their existing service-role RPCs. No product, draft or
 * image is read or written: the suggestions go back to the browser, and the
 * browser puts them in an unsaved form at most.
 *
 * Every dependency is injected so the whole path is testable without a
 * network, a database or a key.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { AI_LIMITS, type ProductAssistantLimits, type RequestLimits } from "./limits";
import { RequestBudget, type DailyReservation, type DailyReserveOutcome } from "./budget";
import { readUsage, costUsd, roundCost } from "./cost";
import { beginTrace, emitBudgetEvent, outcomeForBudgetStop, type AiTrace, type TraceOutcome } from "./observability";
import {
  ASSISTANT_MODEL,
  ASSISTANT_OUTPUT_SCHEMA,
  ASSISTANT_SYSTEM,
  buildAssistantContent,
  parseAssistantOutput,
  type AssistantRequest,
  type AssistantSuggestions,
} from "./productAssistant";
import type { QuotaResult } from "../chatQuota";

export type AssistantErrorCode =
  | "rate_limited"
  | "daily_budget"
  | "budget_unavailable"
  | "provider_busy"
  | "timeout"
  | "provider_error"
  | "image_unreadable"
  | "invalid_output";

export type AssistantOutcome =
  | { ok: true; suggestions: AssistantSuggestions; imagesDropped: number }
  | { ok: false; status: number; code: AssistantErrorCode; message: string; retryAfterSec?: number };

/** What the admin is told. Every one ends the same way: the form is untouched. */
const UNCHANGED = " Nothing in the form has changed.";

export function assistantMessage(code: AssistantErrorCode, resetAt?: string | null): string {
  switch (code) {
    case "rate_limited": {
      const mins = resetAt
        ? Math.max(1, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 60_000))
        : null;
      return (
        `You've asked for suggestions ${AI_LIMITS.productAssistant.maxRequestsPerHour} times in the last hour` +
        (mins ? ` — try again in about ${mins} minute${mins === 1 ? "" : "s"}.` : " — try again a little later.") +
        UNCHANGED
      );
    }
    case "daily_budget":
      return "Today's AI allowance has been used up. Suggestions will be available again tomorrow." + UNCHANGED;
    case "budget_unavailable":
      return "The AI allowance couldn't be checked just now, so nothing was sent. Try again in a moment." + UNCHANGED;
    case "provider_busy":
      return "The AI service is busy right now. Try again in a minute." + UNCHANGED;
    case "timeout":
      return "The AI took too long to answer, so the request was stopped." + UNCHANGED;
    case "image_unreadable":
      return "The AI couldn't open one of the photos. Check the photos have finished uploading, then try again." + UNCHANGED;
    case "invalid_output":
      return "The AI's answer couldn't be checked, so it was discarded. Try again." + UNCHANGED;
    case "provider_error":
      return "Suggestions aren't available right now. Try again shortly." + UNCHANGED;
  }
}

/** Sort a thrown provider error into something the admin can act on. Duck-typed. */
export function classifyAssistantError(err: unknown): AssistantErrorCode {
  const e = err as { status?: unknown; name?: unknown; message?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : null;
  const text = `${typeof e?.name === "string" ? e.name : ""} ${typeof e?.message === "string" ? e.message : ""}`.toLowerCase();
  if (text.includes("timeout") || text.includes("timed out") || text.includes("abort")) return "timeout";
  if (status === 429 || status === 529 || (status != null && status >= 500)) return "provider_busy";
  if (status === 400 && /image|url|fetch|download/.test(text)) return "image_unreadable";
  return "provider_error";
}

export interface AssistantDeps {
  /** One non-streaming model call. Production: the SDK with a timeout. */
  callModel: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  /** Spend one press from this admin's hourly allowance. */
  consumeQuota: () => Promise<QuotaResult>;
  reserve: (amountUsd: number) => Promise<DailyReserveOutcome>;
  finalize: (
    reservation: DailyReservation | null,
    actualUsd: number | null,
    usage: RequestBudget["usageForSettlement"]
  ) => Promise<boolean>;
  limits?: ProductAssistantLimits;
  /** Trace sink; stdout by default. */
  emitTrace?: (trace: AiTrace) => void;
  /** Summary sink; stdout by default. */
  log?: (line: Record<string, unknown>) => void;
}

/** The per-request limits for one press, derived from the assistant's own. */
export function assistantRequestLimits(l: ProductAssistantLimits): RequestLimits {
  return {
    ...AI_LIMITS.request,
    maxCostUsd: l.maxCostUsd,
    maxModelCalls: 1,
    // Unreadable usage is charged as if the call were as large as it can be.
    assumedInputTokensOnUnreadableUsage: 16_000,
    assumedOutputTokensOnUnreadableUsage: l.maxOutputTokens,
  };
}

export function assistantParams(req: AssistantRequest, l: ProductAssistantLimits): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: ASSISTANT_MODEL,
    max_tokens: l.maxOutputTokens,
    system: ASSISTANT_SYSTEM,
    messages: [{ role: "user", content: buildAssistantContent(req) }],
    output_config: { format: { type: "json_schema", schema: ASSISTANT_OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
  };
}

export async function runProductAssistant(
  req: AssistantRequest,
  imagesDropped: number,
  deps: AssistantDeps
): Promise<AssistantOutcome> {
  const limits = deps.limits ?? AI_LIMITS.productAssistant;
  const trace = beginTrace({ model: ASSISTANT_MODEL, surface: "product_assistant", caller: "admin", emit: deps.emitTrace });
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const started = Date.now();

  // The summary line. IDs and counts only — never a word of product copy, and
  // nothing about the admin beyond the fact that it was one.
  const summary = (outcome: string, extra: Record<string, unknown> = {}) => {
    try {
      log({
        evt: "ai_product_assistant",
        ts: new Date().toISOString(),
        trace_id: trace.traceId,
        product_id: req.productId,
        model: ASSISTANT_MODEL,
        outcome,
        latency_ms: Date.now() - started,
        images_sent: req.images.length,
        images_dropped: imagesDropped,
        ...extra,
      });
    } catch {
      // Telemetry must never break the answer.
    }
  };

  const fail = (
    traceOutcome: TraceOutcome,
    code: AssistantErrorCode,
    status: number,
    extra: Record<string, unknown> = {},
    message = assistantMessage(code)
  ): AssistantOutcome => {
    trace.finish(traceOutcome);
    summary(code, extra);
    return { ok: false, status, code, message };
  };

  // 1. The hourly allowance.
  const quota = await deps.consumeQuota();
  if (!quota.allowed) {
    const out = fail("rate_limited", "rate_limited", 429, {}, assistantMessage("rate_limited", quota.resetAt));
    return { ...out, retryAfterSec: 600 } as AssistantOutcome;
  }

  // 2. Hold the most this press could cost against today's shared ceiling.
  const daily = await deps.reserve(limits.maxCostUsd);
  if (!daily.allowed) {
    emitBudgetEvent(daily.reason === "daily_ceiling" ? "daily_budget_denied" : "daily_budget_unavailable", {
      traceId: trace.traceId,
      detail: daily.detail,
    });
    return fail(
      outcomeForBudgetStop(daily.reason),
      daily.reason === "daily_ceiling" ? "daily_budget" : "budget_unavailable",
      503
    );
  }
  const reservation = daily.reservation;

  // 3. The per-request ceiling: refuses an unpriced model before it is called.
  const budget = new RequestBudget(ASSISTANT_MODEL, assistantRequestLimits(limits));
  const settle = async () => {
    if (!reservation) return;
    const actual = budget.settlementCostUsd;
    const ok = await deps.finalize(reservation, actual, budget.usageForSettlement);
    emitBudgetEvent(ok ? "daily_budget_reconciled" : "reconciliation_failed", {
      traceId: trace.traceId,
      reservationId: reservation.id,
      amountUsd: reservation.amountUsd,
      actualUsd: actual,
    });
  };
  const verdict = budget.checkBeforeCall();
  if (!verdict.allowed) {
    await settle();
    return fail(outcomeForBudgetStop(verdict.reason), "budget_unavailable", 503);
  }

  // 4. One call.
  const endCall = trace.startModelCall(false);
  let message: Anthropic.Message;
  try {
    message = await deps.callModel(assistantParams(req, limits));
  } catch (err) {
    const code = classifyAssistantError(err);
    endCall({ error: code === "timeout" ? "model_timeout" : "model_provider_error" });
    // An error the API answered with (429, 529, a 400 about a photo) is not
    // billed, so it settles at nothing. A timeout or an unrecognised failure
    // may have been processed and billed with no usage to show for it: that is
    // charged as unknown — the whole hold — rather than assumed free.
    if (code === "timeout" || code === "provider_error") budget.recordCall(undefined);
    await settle();
    console.error(`product assistant: model call failed (${code}):`, (err as Error)?.message ?? err);
    return fail(code === "timeout" ? "model_timeout" : "model_provider_error", code, code === "timeout" ? 504 : 502);
  }

  endCall({ usage: message.usage, stopReason: message.stop_reason });
  budget.recordCall(message.usage);
  // 5. Settle — not awaited by the admin's answer in spirit, but awaited here so
  // a serverless instance does not freeze before the RPC lands.
  await settle();

  const usage = readUsage(message.usage);
  const tokenFields = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: roundCost(costUsd(ASSISTANT_MODEL, usage)),
    stop_reason: message.stop_reason,
  };

  // 6. Validate. A truncated or refused answer is not an answer.
  if (message.stop_reason !== "end_turn") {
    return fail("malformed_model_response", "invalid_output", 502, { ...tokenFields, validation: "stop_reason" });
  }
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = parseAssistantOutput(text, req);
  if (!parsed.ok) {
    return fail("malformed_model_response", "invalid_output", 502, { ...tokenFields, validation: parsed.reason });
  }

  const s = parsed.value;
  trace.finish("successful_no_tool");
  summary("ok", {
    ...tokenFields,
    validation: "ok",
    fields_offered: s.fields.length,
    fields_flagged: s.fields.filter((f) => f.issues.length).length,
    alts_offered: s.alts.length,
    alts_flagged: s.alts.filter((a) => a.issues.length).length,
    dropped: s.dropped,
  });
  return { ok: true, suggestions: s, imagesDropped };
}
