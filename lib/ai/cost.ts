/**
 * What a model call cost, from what the provider said it used.
 *
 * ══ WHY PRICING LIVES IN ONE FILE ══
 *
 * Prices change, and they change on Anthropic's schedule rather than ours. If a
 * rate is written into the tracing code — or worse, into the chat loop — then
 * updating it means editing logic that has nothing to do with money, and the
 * next person has to find every copy. This module is the only place a number
 * per token appears; `lib/ai/observability.ts` asks it a question and records
 * the answer.
 *
 * ══ NEVER GUESS ══
 *
 * An unknown model returns null, not an estimate. A cost that is quietly wrong
 * is worse than a cost that is missing: a missing one shows up as a gap in a
 * report and gets fixed, while a wrong one gets budgeted against. Every caller
 * therefore has to handle null, which is the point — `pricing_known: false` is
 * a fact worth carrying into the telemetry rather than papering over.
 *
 * ══ USD ONLY ══
 *
 * The shop prices in rupees and this module does not. Converting would mean
 * picking an exchange rate, and a rate baked into source is a guess with a
 * timestamp on it — exactly the thing the paragraph above refuses. Reports
 * convert at a rate they state; the stored figure stays in the currency the
 * provider bills in.
 */

/** Per-million-token rates, as published. */
export interface ModelPricing {
  /** Ordinary input tokens. */
  inputPerMTok: number;
  /** Generated tokens, thinking included — the provider bills them together. */
  outputPerMTok: number;
  /** Writing a prompt-cache entry. Charged above the input rate. */
  cacheWritePerMTok: number;
  /** Reading one back. Charged far below it. */
  cacheReadPerMTok: number;
}

/**
 * The rate card.
 *
 * Anthropic first-party API rates. Cache write is 1.25× input and cache read is
 * 0.1× input across the range, but both are written out rather than derived:
 * a multiplier that holds today is not a guarantee, and a table you can read
 * against the price page is easier to audit than arithmetic.
 *
 * Wovenne does not currently use prompt caching anywhere — the cache columns
 * are here so that turning it on later becomes a pricing question already
 * answered, rather than a silent under-count.
 *
 * Verified against the published rates on 25 August 2026.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // What Ask Wovenne actually runs on.
  "claude-sonnet-5": {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheWritePerMTok: 2.5,
    cacheReadPerMTok: 0.2,
  },
  "claude-opus-5": {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
  "claude-sonnet-4-6": {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
});

/** The date the table above was last checked, so a stale rate is visible. */
export const PRICING_AS_OF = "2026-08-25";

/** Rates for a model, or null if we have never been told what it costs. */
export function pricingFor(model: string): ModelPricing | null {
  return MODEL_PRICING[model] ?? null;
}

/** Whether a cost can be calculated at all for this model. */
export function isPriced(model: string): boolean {
  return pricingFor(model) != null;
}

/**
 * The four token counts a bill is made of.
 *
 * Separate fields rather than one total because they are charged at four
 * different rates, and because the provider reports them separately — folding
 * them together at the point of measurement would throw away the only chance to
 * price them correctly.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Read a usage block off a provider response.
 *
 * DEFENSIVE ON PURPOSE. `input_tokens` is typed nullable by the SDK, the cache
 * fields are nullable, and a future field could arrive as a string. This is
 * telemetry: a surprise in the shape of a usage object must not throw inside a
 * customer's reply, so anything unreadable becomes zero and the trace records a
 * turn that cost nothing rather than failing the turn.
 */
export function readUsage(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
  };
}

/** Add one call's usage to a running total. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * Every token that was charged as input.
 *
 * The provider bills cache reads and cache writes on top of `input_tokens`
 * rather than inside it, so a report that quotes `input_tokens` alone
 * under-states the input side the moment caching is switched on.
 */
export function totalInputTokens(u: TokenUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/** Input and output together — the headline number, not a billing figure. */
export function totalTokens(u: TokenUsage): number {
  return totalInputTokens(u) + u.outputTokens;
}

/**
 * What that usage cost, in US dollars.
 *
 * Returns null — never zero — for a model with no published rate. Zero is a
 * real cost and would be indistinguishable from a free call in any aggregate.
 */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const p = pricingFor(model);
  if (!p) return null;

  const perToken = (rate: number, tokens: number) => (tokens / 1_000_000) * rate;

  return (
    perToken(p.inputPerMTok, usage.inputTokens) +
    perToken(p.outputPerMTok, usage.outputTokens) +
    perToken(p.cacheReadPerMTok, usage.cacheReadTokens) +
    perToken(p.cacheWritePerMTok, usage.cacheWriteTokens)
  );
}

/**
 * The same figure, rounded for storage.
 *
 * Six decimal places is a ten-thousandth of a cent, which is finer than any
 * single call and coarse enough that a stored figure does not carry float
 * noise into a report. Null stays null.
 */
export function roundCost(cost: number | null): number | null {
  return cost == null ? null : Math.round(cost * 1e6) / 1e6;
}
