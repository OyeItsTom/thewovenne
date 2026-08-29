/**
 * Every number that bounds AI spend, in one place.
 *
 * ══ WHY A CONFIG MODULE AND NOT CONSTANTS AT THE CALL SITE ══
 *
 * A ceiling written into the route is a ceiling nobody can find, and two
 * ceilings written into two places are a contradiction waiting to be
 * discovered in a bill. Everything that decides how much may be spent lives
 * here; `lib/ai/budget.ts` enforces it and neither the chat route nor an eval
 * runner contains a magic number.
 *
 * ══ ENVIRONMENT OVERRIDES ARE VALIDATED, NOT TRUSTED ══
 *
 * `AI_DAILY_BUDGET_USD="ten dollars"` must not silently become NaN, because
 * every comparison against NaN is false and a NaN ceiling is an absent ceiling.
 * Anything unparseable falls back to the documented default and says so once at
 * load. Nothing here throws: a bad env var must not take the site down, and a
 * config module that can fail at import would do exactly that.
 *
 * ══ NO SECRETS ══
 *
 * These are limits, not credentials. Nothing in this file is sensitive and
 * nothing in it should ever become sensitive.
 */

/** Parse a positive finite number from the environment, or fall back loudly. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `ai/limits: ${name}="${raw}" is not a positive number — using the default ${fallback}.`
    );
    return fallback;
  }
  return parsed;
}

/** Parse an integer the same way. */
function int(name: string, fallback: number): number {
  const parsed = num(name, fallback);
  if (!Number.isInteger(parsed)) {
    console.error(`ai/limits: ${name} must be a whole number — using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/**
 * A boolean that only the exact string "true" can turn on.
 *
 * Deliberately strict. This flag decides whether spend enforcement gives up and
 * allows the call, so "1", "yes" and "TRUE" are all refused — an escape hatch
 * that can be opened by accident is not an escape hatch, it is a hole.
 */
function strictTrue(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  console.error(
    `ai/limits: ${name}="${raw}" must be exactly "true" or "false" — using ${fallback}.`
  );
  return fallback;
}

export interface RequestLimits {
  /** Hard ceiling on estimated spend for one customer turn. */
  maxCostUsd: number;
  /** Hard ceiling on tokens (input + output, cache included) for one turn. */
  maxTokens: number;
  /**
   * Backstop on model calls per turn.
   *
   * MAX_TOOL_ROUNDS in lib/chat.ts stays authoritative — it is the thing that
   * shapes the conversation, and this must never be the reason a turn stops
   * under normal operation. The default equals the loop's own structural
   * maximum (4 rounds + 1 forced tool-free round) so it can only ever bind if
   * that loop changes without this being reconsidered.
   */
  maxModelCalls: number;
  /**
   * What to charge a call whose usage block could not be read.
   *
   * NOT ZERO, WHICH IS THE POINT. A malformed or absent usage object would
   * otherwise cost nothing, and a provider returning junk usage would be a way
   * to walk straight through a spend ceiling. These are deliberately generous:
   * the output figure is the request's own max_tokens, and the input figure is
   * comfortably above a late round of a long conversation.
   */
  assumedInputTokensOnUnreadableUsage: number;
  assumedOutputTokensOnUnreadableUsage: number;
}

export interface DailyLimits {
  /** Ceiling on total estimated AI spend per calendar day, in USD. */
  maxCostUsd: number;
  /**
   * Whether to ALLOW a call when the daily spend state cannot be read.
   *
   * Defaults to false — fail closed. An unreadable budget is not a licence to
   * spend, and the alternative ("we could not check, so we assumed it was
   * fine") is how an outage becomes an invoice. It exists as an env var because
   * there are legitimate moments to open it deliberately; there are none to
   * open it by accident, which is why only the literal "true" does.
   */
  failOpen: boolean;
}

export interface EvalLimits {
  maxCases: number;
  maxModelCalls: number;
  maxTokens: number;
  maxCostUsd: number;
}

export interface AiLimits {
  request: RequestLimits;
  daily: DailyLimits;
  evaluation: EvalLimits;
}

/**
 * The limits in force.
 *
 * Defaults are set against the Phase 1 cost baseline, where the worst observed
 * shape — five model calls, four lookups — is roughly $0.032 per request.
 *
 * PRODUCTION AND EVALUATION ARE SEPARATE BUDGETS ON PURPOSE. An eval run is
 * meant to make many calls quickly; a customer turn is not. Sharing one ceiling
 * would let a single eval run consume the day's allowance for real customers,
 * which is precisely backwards.
 */
export function loadLimits(): AiLimits {
  return {
    request: {
      // ~1.9x the worst measured shape. Tight enough to stop a runaway loop,
      // loose enough that a legitimately long answer is never truncated for it.
      maxCostUsd: num("AI_MAX_COST_PER_REQUEST_USD", 0.06),
      // The worst measured turn is ~13k tokens; this is ~4.5x that.
      maxTokens: int("AI_MAX_TOKENS_PER_REQUEST", 60_000),
      // Equals the loop's structural maximum — see the field comment.
      maxModelCalls: int("AI_MAX_MODEL_CALLS_PER_REQUEST", 5),
      assumedInputTokensOnUnreadableUsage: int("AI_ASSUMED_INPUT_TOKENS", 8_000),
      // The request's own max_tokens: a call cannot have produced more.
      assumedOutputTokensOnUnreadableUsage: int("AI_ASSUMED_OUTPUT_TOKENS", 1_024),
    },
    daily: {
      // ~$5/day is roughly 160 worst-case requests, or 500 typical ones.
      maxCostUsd: num("AI_DAILY_BUDGET_USD", 5.0),
      failOpen: strictTrue("AI_BUDGET_FAIL_OPEN", false),
    },
    evaluation: {
      maxCases: int("AI_EVAL_MAX_CASES", 50),
      maxModelCalls: int("AI_EVAL_MAX_MODEL_CALLS", 250),
      maxTokens: int("AI_EVAL_MAX_TOKENS", 1_000_000),
      maxCostUsd: num("AI_EVAL_MAX_COST_USD", 2.0),
    },
  };
}

/**
 * Read once per process.
 *
 * Serverless instances are short-lived, so this is effectively per-deploy —
 * which is the right granularity for a limit. Re-reading per request would make
 * a ceiling that changes mid-conversation, and the validation log would repeat
 * on every call.
 */
export const AI_LIMITS: AiLimits = loadLimits();
