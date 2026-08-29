/**
 * Spend enforcement: per request, per day, and per evaluation run.
 *
 * ══ THE RULE THIS FILE EXISTS TO KEEP ══
 *
 * An unknown cost is never zero. Every path that cannot establish what
 * something cost — an unpriced model, a usage block that will not parse, a
 * daily counter that cannot be read — refuses rather than assumes. That is the
 * opposite of the default a naive implementation lands on, where a missing
 * number silently becomes 0 and the ceiling it was meant to defend never trips.
 *
 * ══ FAIL CLOSED, WITH ONE DELIBERATE DOOR ══
 *
 * `AI_BUDGET_FAIL_OPEN=true` is the only way to make an unreadable budget
 * permissive, and only the literal string works. Everything else denies.
 *
 * ══ WHAT IS NOT HERE ══
 *
 * A daily spend STORE. Enforcing a daily ceiling needs somewhere durable to add
 * up the day's spend, and Wovenne has nowhere safe to put it yet — see
 * `NO_DAILY_STORE_REASON` below. The interface is defined so that the store is
 * a drop-in when it exists; until then `readTodayUsd()` reports unavailable and
 * the policy above applies.
 */

import { AI_LIMITS, type EvalLimits, type RequestLimits } from "./limits";
import { addUsage, costUsd, isPriced, type TokenUsage, totalTokens, ZERO_USAGE } from "./cost";
import { createSupabaseDailySpendStore } from "./dailySpend";

// ══ Verdicts ══════════════════════════════════

/** Why a budget said no. Explicit, for the same reason the taxonomy is. */
export type BudgetStopReason =
  | "request_cost_ceiling"
  | "request_token_ceiling"
  | "request_call_ceiling"
  | "daily_ceiling"
  /** The model has no published price, so no ceiling can be enforced. */
  | "pricing_unknown"
  /** The daily counter could not be read, and fail-open is off. */
  | "budget_state_unavailable"
  | "eval_case_ceiling"
  | "eval_call_ceiling"
  | "eval_token_ceiling"
  | "eval_cost_ceiling";

export type BudgetVerdict =
  | { allowed: true }
  | { allowed: false; reason: BudgetStopReason; detail: string };

const OK: BudgetVerdict = { allowed: true };

function deny(reason: BudgetStopReason, detail: string): BudgetVerdict {
  return { allowed: false, reason, detail };
}

// ══ Usage plausibility ════════════════════════

/**
 * Whether a provider usage block can be believed.
 *
 * `output_tokens` is documented as non-zero even for an empty response, so a
 * completed call reporting zero — or reporting a string, or nothing at all — is
 * a usage object that did not survive the trip. Charging it as free is the
 * bypass this check closes.
 */
export function isUsableUsage(raw: unknown): boolean {
  const u = raw as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== "object") return false;
  const out = u.output_tokens;
  return typeof out === "number" && Number.isFinite(out) && out > 0;
}

/** What to charge when the real numbers are unavailable. Deliberately generous. */
export function assumedUsage(limits: RequestLimits): TokenUsage {
  return {
    inputTokens: limits.assumedInputTokensOnUnreadableUsage,
    outputTokens: limits.assumedOutputTokensOnUnreadableUsage,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Read a usage block, substituting the conservative estimate when it will not parse. */
export function chargeableUsage(raw: unknown, limits: RequestLimits): {
  usage: TokenUsage;
  assumed: boolean;
} {
  if (!isUsableUsage(raw)) return { usage: assumedUsage(limits), assumed: true };

  const u = raw as Record<string, unknown>;
  const n = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

  return {
    usage: {
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens),
      cacheReadTokens: n(u.cache_read_input_tokens),
      cacheWriteTokens: n(u.cache_creation_input_tokens),
    },
    assumed: false,
  };
}

// ══ Per request ═══════════════════════════════

/**
 * One customer turn's allowance.
 *
 * Checked BEFORE each model call, not after — a ceiling enforced after the
 * spend has happened is an audit trail, not a limit. The check is deliberately
 * pessimistic about the call it is about to authorise: it asks whether the
 * budget would still hold if that call turned out to be an expensive one, which
 * is the only way a ceiling can be honoured rather than merely observed being
 * crossed.
 */
export class RequestBudget {
  private readonly limits: RequestLimits;
  private readonly model: string;
  private usage: TokenUsage = ZERO_USAGE;
  private calls = 0;
  private assumedCalls = 0;
  private stopped: BudgetStopReason | null = null;

  constructor(model: string, limits: RequestLimits = AI_LIMITS.request) {
    this.model = model;
    this.limits = limits;
  }

  /** Ask permission for the next model call. */
  checkBeforeCall(): BudgetVerdict {
    if (this.stopped) {
      return deny(this.stopped, "budget already exhausted this request");
    }

    // Unknown pricing is refused outright rather than counted as free. A model
    // with no published rate cannot be held to a dollar ceiling at all, so the
    // honest options are "refuse" or "spend without a limit" — and the second
    // is not a limit.
    if (!isPriced(this.model) && !AI_LIMITS.daily.failOpen) {
      return this.stop(
        "pricing_unknown",
        `no published price for "${this.model}" — cannot enforce a cost ceiling`
      );
    }

    if (this.calls >= this.limits.maxModelCalls) {
      return this.stop(
        "request_call_ceiling",
        `${this.calls} model calls reaches the per-request cap of ${this.limits.maxModelCalls}`
      );
    }

    const tokens = totalTokens(this.usage);
    if (tokens >= this.limits.maxTokens) {
      return this.stop(
        "request_token_ceiling",
        `${tokens} tokens reaches the per-request cap of ${this.limits.maxTokens}`
      );
    }

    const spent = costUsd(this.model, this.usage);
    if (spent == null) {
      // Priced above, so this is unreachable in practice — but a null slipping
      // through must not become "0 <= ceiling, carry on".
      return this.stop("pricing_unknown", "cost could not be computed");
    }
    if (spent >= this.limits.maxCostUsd) {
      return this.stop(
        "request_cost_ceiling",
        `$${spent.toFixed(5)} reaches the per-request cap of $${this.limits.maxCostUsd}`
      );
    }

    return OK;
  }

  /**
   * Record what a completed call actually used.
   *
   * Returns whether the figures had to be assumed, so a caller can log the
   * difference — an assumed charge is a real signal about the provider, not
   * just an accounting detail.
   */
  recordCall(rawUsage: unknown): { assumed: boolean } {
    const { usage, assumed } = chargeableUsage(rawUsage, this.limits);
    this.usage = addUsage(this.usage, usage);
    this.calls += 1;
    if (assumed) this.assumedCalls += 1;
    return { assumed };
  }

  private stop(reason: BudgetStopReason, detail: string): BudgetVerdict {
    this.stopped = reason;
    return deny(reason, detail);
  }

  get spent(): {
    calls: number;
    tokens: number;
    costUsd: number | null;
    assumedCalls: number;
    stopReason: BudgetStopReason | null;
  } {
    return {
      calls: this.calls,
      tokens: totalTokens(this.usage),
      costUsd: costUsd(this.model, this.usage),
      assumedCalls: this.assumedCalls,
      stopReason: this.stopped,
    };
  }

  /**
   * The token breakdown, for settling a daily reservation.
   *
   * Separate from `spent` because the daily account keeps the four token
   * classes apart — they are billed at four different rates, and folding them
   * together at the point of settlement would throw away the only chance to
   * report them correctly.
   */
  get usageForSettlement(): {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } {
    return {
      modelCalls: this.calls,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens,
    };
  }

  /**
   * What to settle for, in dollars — or null when it cannot be established.
   *
   * Null when the model has no published price, or when EVERY call had to be
   * charged an assumed figure. In both cases the honest answer is "we do not
   * know", and the store charges the full reservation for it rather than making
   * an unmeasurable request free.
   */
  get settlementCostUsd(): number | null {
    if (!isPriced(this.model)) return null;
    if (this.calls > 0 && this.assumedCalls === this.calls) return null;
    return costUsd(this.model, this.usage);
  }
}

// ══ Per day ═══════════════════════════════════

/**
 * Somewhere durable that can hold budget against a request, and settle it.
 *
 * ══ WHY RESERVE, AND NOT "READ THE TOTAL" ══
 *
 * The obvious interface is `readTodayUsd()` and `addUsd()`. It is also a
 * check-then-act: two requests arriving together both read $4.96, both decide
 * there is room, and both spend. The ceiling is crossed by exactly the
 * concurrency it exists to survive, and no amount of care on this side fixes
 * it — the two instances cannot see each other.
 *
 * So the unit of the interface is a RESERVATION. A request asks for room for
 * its maximum possible cost before the provider is called, and settles down to
 * the real figure afterwards. The check and the hold happen in one database
 * statement; see migration 0059.
 *
 * `reserve` returns null — not a refusal — when the store cannot be reached.
 * The distinction matters: "no" is the system working, "I could not ask" is
 * not, and they get different outcomes in the telemetry.
 */
export interface ReserveResult {
  allowed: boolean;
  /** Present when allowed. Required to settle. */
  reservationId?: string;
  committedUsd?: number | null;
  limitUsd?: number | null;
}

export interface DailySpendStore {
  /** Hold `amountUsd` against today's ceiling. null means unreachable. */
  reserve(amountUsd: number, limitUsd: number): Promise<ReserveResult | null>;
  /**
   * Settle a reservation against what was really spent.
   *
   * `actualUsd` of null means "we could not establish the cost" and the store
   * charges the full reservation for it. It must never be coerced to 0.
   * Returns false if the settlement did not land — the reservation then stays
   * outstanding and is swept, in full, after its TTL.
   */
  finalize(
    reservationId: string,
    actualUsd: number | null,
    usage: {
      modelCalls: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  ): Promise<boolean>;
}

/**
 * WHY `chat_usage` IS NOT THE STORE.
 *
 * Reusing migration 0019's table looked like a free win: an atomic, row-locked
 * counter with a window, and `chat_consume()` takes an arbitrary text key, so a
 * row keyed "global:daily" would have needed no migration at all.
 *
 * It does not work, because of one line of 0019:
 *
 *     delete from chat_usage where window_start < now() - (p_window * 3);
 *
 * That cleanup uses the CALLING invocation's window, not the row's. Every
 * ordinary chat request passes '1 hour', so every ordinary chat request deletes
 * any row whose window_start is more than three hours old — including a daily
 * row, which by design holds a window_start at the start of the day. The
 * ceiling would silently reset itself roughly every three hours without
 * erroring: the counter would simply be gone and the next read would report
 * zero spent. A budget that resets itself eight times a day is worse than no
 * budget, because it looks like one.
 *
 * Migration 0059 gives daily accounting its own tables and its own sweep, keyed
 * on each reservation's own age rather than on the caller's window.
 */
export const NO_DAILY_STORE_REASON =
  "no daily spend store is configured; chat_usage cannot be reused because " +
  "0019's cleanup deletes rows using the caller's window";

/** Injectable for tests. Null disables the store entirely (and therefore denies). */
let dailyStoreOverride: DailySpendStore | null | undefined;

/** Test seam. Pass undefined to restore the real store. */
export function __setDailySpendStoreForTests(
  store: DailySpendStore | null | undefined
): void {
  dailyStoreOverride = store;
}

/**
 * The store in force.
 *
 * The import of `./dailySpend` is static and the reverse direction is
 * `import type` only, so the cycle is erased at compile time and there is no
 * load-order hazard. The CLIENT is still built lazily — inside
 * createSupabaseDailySpendStore's methods — so importing this module never
 * requires the service key to be present.
 *
 * Wrapped anyway: a store that cannot be constructed is a store that is
 * unavailable, and unavailable means denied rather than thrown.
 */
export function getDailySpendStore(): DailySpendStore | null {
  if (dailyStoreOverride !== undefined) return dailyStoreOverride;
  try {
    return createSupabaseDailySpendStore();
  } catch (e) {
    console.error("ai budget: daily spend store unavailable:", (e as Error).message);
    return null;
  }
}

/** A granted hold, to be settled once the request is done. */
export interface DailyReservation {
  id: string;
  /** What was held. Charged in full if the real figure is never established. */
  amountUsd: number;
}

export type DailyReserveOutcome =
  | { allowed: true; reservation: DailyReservation | null }
  | { allowed: false; reason: BudgetStopReason; detail: string };

/**
 * Hold budget for one request, before the provider is called.
 *
 * `amountUsd` should be the MAXIMUM the request could cost — the per-request
 * ceiling — not a guess at what it will cost. Reserving the maximum is what
 * makes the guarantee hold: a request cannot be granted room it might then
 * exceed, and the difference is given back at settlement.
 *
 * Three refusals, deliberately distinguished:
 *   - the ceiling is reached          → daily_ceiling
 *   - the store could not be reached  → budget_state_unavailable
 *   - fail-open is on                 → allowed, with nothing to settle
 */
export async function reserveDailyBudget(
  amountUsd: number = AI_LIMITS.request.maxCostUsd,
  store: DailySpendStore | null = getDailySpendStore(),
  limits = AI_LIMITS.daily
): Promise<DailyReserveOutcome> {
  const unavailable = (detail: string): DailyReserveOutcome =>
    limits.failOpen
      ? { allowed: true, reservation: null }
      : { allowed: false, reason: "budget_state_unavailable", detail };

  if (!store) return unavailable(NO_DAILY_STORE_REASON);

  // A reservation amount we cannot trust is not a reservation. NaN in
  // particular: every comparison against it is false, so a NaN request would
  // sail past a ceiling written the obvious way.
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    return unavailable(`refusing to reserve an unusable amount (${amountUsd})`);
  }

  let result: ReserveResult | null;
  try {
    result = await store.reserve(amountUsd, limits.maxCostUsd);
  } catch (e) {
    return unavailable(`daily spend store threw: ${(e as Error).message}`);
  }

  if (result == null) return unavailable("daily spend store returned no usable verdict");

  if (!result.allowed) {
    const spent = result.committedUsd;
    return {
      allowed: false,
      reason: "daily_ceiling",
      detail:
        spent == null
          ? `today's spend reaches the daily cap of $${limits.maxCostUsd}`
          : `$${spent.toFixed(4)} committed today reaches the daily cap of $${limits.maxCostUsd}`,
    };
  }

  if (!result.reservationId) {
    // Allowed with nothing to settle would leak the hold for its whole TTL.
    return unavailable("daily spend store allowed a request without a reservation id");
  }

  return {
    allowed: true,
    reservation: { id: result.reservationId, amountUsd },
  };
}

/**
 * Settle a reservation against what the request really spent.
 *
 * NEVER THROWS. This runs after the customer already has their answer, and a
 * failure here must not turn a completed reply into an error. An unsettled
 * reservation is not lost — it is swept, at its full amount, once its TTL
 * passes, which is the conservative direction.
 */
export async function finalizeDailyBudget(
  reservation: DailyReservation | null,
  actualUsd: number | null,
  usage: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
  store: DailySpendStore | null = getDailySpendStore()
): Promise<boolean> {
  if (!reservation || !store) return false;
  try {
    // A non-finite actual is treated as unknown rather than passed through: the
    // store charges the full reservation for null, which is what an
    // unestablishable cost should cost.
    const safeActual =
      actualUsd == null || !Number.isFinite(actualUsd) || actualUsd < 0 ? null : actualUsd;
    return await store.finalize(reservation.id, safeActual, usage);
  } catch (e) {
    console.error(`ai budget: finalize threw for ${reservation.id}:`, (e as Error).message);
    return false;
  }
}

// ══ Per evaluation run ════════════════════════

/**
 * An eval run's allowance.
 *
 * Separate from the production budget on purpose: an eval is supposed to make
 * many calls quickly, and letting it draw down the same pot customers use would
 * mean a thorough test run degrades the shop.
 *
 * The contract is that a runner asks `canStartCase()` before each case and
 * stops the moment it is refused — no `for (const case of all)` that discovers
 * the ceiling afterwards.
 */
export class EvalBudget {
  private readonly limits: EvalLimits;
  private readonly model: string;
  private usage: TokenUsage = ZERO_USAGE;
  private cases = 0;
  private calls = 0;
  private assumedCalls = 0;
  private stopped: BudgetStopReason | null = null;

  constructor(model: string, limits: EvalLimits = AI_LIMITS.evaluation) {
    this.model = model;
    this.limits = limits;
  }

  /** Ask before starting another case. */
  canStartCase(): BudgetVerdict {
    if (this.stopped) return deny(this.stopped, "eval budget already exhausted");

    if (!isPriced(this.model)) {
      return this.stop(
        "eval_cost_ceiling",
        `no published price for "${this.model}" — an eval run cannot be cost-bounded`
      );
    }
    if (this.cases >= this.limits.maxCases) {
      return this.stop("eval_case_ceiling", `${this.cases}/${this.limits.maxCases} cases`);
    }
    if (this.calls >= this.limits.maxModelCalls) {
      return this.stop("eval_call_ceiling", `${this.calls}/${this.limits.maxModelCalls} model calls`);
    }

    const tokens = totalTokens(this.usage);
    if (tokens >= this.limits.maxTokens) {
      return this.stop("eval_token_ceiling", `${tokens}/${this.limits.maxTokens} tokens`);
    }

    const spent = costUsd(this.model, this.usage) ?? Number.POSITIVE_INFINITY;
    if (spent >= this.limits.maxCostUsd) {
      return this.stop(
        "eval_cost_ceiling",
        `$${spent.toFixed(4)}/$${this.limits.maxCostUsd}`
      );
    }

    return OK;
  }

  recordCase(): void {
    this.cases += 1;
  }

  recordCall(rawUsage: unknown): { assumed: boolean } {
    const { usage, assumed } = chargeableUsage(rawUsage, AI_LIMITS.request);
    this.usage = addUsage(this.usage, usage);
    this.calls += 1;
    if (assumed) this.assumedCalls += 1;
    return { assumed };
  }

  private stop(reason: BudgetStopReason, detail: string): BudgetVerdict {
    this.stopped = reason;
    return deny(reason, detail);
  }

  get spent(): {
    cases: number;
    calls: number;
    tokens: number;
    costUsd: number | null;
    assumedCalls: number;
    stopReason: BudgetStopReason | null;
  } {
    return {
      cases: this.cases,
      calls: this.calls,
      tokens: totalTokens(this.usage),
      costUsd: costUsd(this.model, this.usage),
      assumedCalls: this.assumedCalls,
      stopReason: this.stopped,
    };
  }
}
