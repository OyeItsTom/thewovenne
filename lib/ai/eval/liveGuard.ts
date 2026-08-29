/**
 * The safety envelope for live model evaluation.
 *
 * ══ WHAT THIS FILE IS FOR ══
 *
 * A live evaluation is the first thing in this project that spends real money,
 * and a correctly shaped ANTHROPIC_API_KEY already sits in the production
 * environment. That key is CREDENTIAL AVAILABILITY. It is not authorisation,
 * and nothing here reads it, validates it or takes any interest in it — the
 * guards below would behave identically on a machine with no key at all, which
 * is a property the tests assert directly.
 *
 * These functions are pure. They take an argv array and an environment object
 * and return a verdict. They construct no client, open no socket and know
 * nothing about Anthropic. That is deliberate: the decision to spend should be
 * testable exhaustively, and it cannot be if it is tangled up with the thing
 * that does the spending.
 *
 * ══ WHY MONEY IS COUNTED IN INTEGERS ══
 *
 * The boundary cases here are exact by design — a $0.60 cap must admit a case
 * at $0.54 spent, because 0.54 + 0.06 is 0.60 and 0.60 is not over 0.60. In
 * IEEE-754 it is: `0.54 + 0.06` evaluates to 0.6000000000000001, so a naive
 * float comparison REFUSES a case the policy admits. That is not a rounding
 * nicety, it is the guard being wrong at exactly the point where it is asked
 * the hardest question.
 *
 * So every comparison in this file happens in whole micro-dollars. Money is
 * counted, not measured.
 */

import { AI_LIMITS } from "../limits";

/** One US dollar, in the integer unit this module compares in. */
const MICROS_PER_USD = 1_000_000;

/**
 * USD → whole micro-dollars.
 *
 * Rounded rather than truncated: a cost of $0.0599999999 arrived at through
 * float arithmetic should be the 60,000 micros it plainly means, not 59,999.
 */
export function toMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function fromMicros(micros: number): number {
  return micros / MICROS_PER_USD;
}

// ══ The spend cap ═════════════════════════════

export type CapResult =
  | { ok: true; usd: number; micros: number }
  | { ok: false; reason: string };

/**
 * Parse and validate `--max-spend-usd`.
 *
 * THERE IS NO DEFAULT, AND THAT IS THE POINT. An omitted cap is a refusal, not
 * a fallback to the global ceiling — the number has to be one a person chose
 * and typed, because the whole mechanism exists so that nobody can spend money
 * without having decided how much.
 *
 * IT NEVER CLAMPS. A caller who asks for $2.50 against a $2.00 ceiling is
 * refused, not quietly given $2.00. Silently granting less than was asked for
 * teaches an operator that the number they type is advisory, which is precisely
 * the habit this file exists to prevent.
 */
export function parseMaxSpend(
  raw: string | undefined,
  limits = AI_LIMITS
): CapResult {
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, reason: "--max-spend-usd is required; there is no default" };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { ok: false, reason: `--max-spend-usd="${raw}" is not a finite number` };
  }
  if (parsed <= 0) {
    return { ok: false, reason: `--max-spend-usd must be greater than zero, got ${parsed}` };
  }

  const micros = toMicros(parsed);
  const floorMicros = toMicros(limits.request.maxCostUsd);
  const ceilingMicros = toMicros(limits.evaluation.maxCostUsd);

  // A cap that cannot afford a single worst-case turn is not a small budget,
  // it is a run that can never start a case. Refused as configuration rather
  // than discovered as an empty report.
  if (micros < floorMicros) {
    return {
      ok: false,
      reason:
        `--max-spend-usd=${parsed} is below the $${limits.request.maxCostUsd} worst-case ` +
        `cost of a single case — no case could ever start`,
    };
  }
  if (micros > ceilingMicros) {
    return {
      ok: false,
      reason:
        `--max-spend-usd=${parsed} exceeds the $${limits.evaluation.maxCostUsd} global eval ` +
        `ceiling — refusing rather than silently reducing it`,
    };
  }

  return { ok: true, usd: fromMicros(micros), micros };
}

// ══ The three guards ══════════════════════════

export interface LiveAuthorization {
  authorized: boolean;
  /** Every reason the request was refused, not just the first. */
  refusals: string[];
  /** Present only when authorized. */
  cap: { usd: number; micros: number } | null;
  /** Which guards were individually satisfied — for the summary line. */
  guards: { flag: boolean; environment: boolean; cap: boolean };
}

/**
 * All three, or nothing.
 *
 * ══ WHY THREE, AND WHY THESE THREE ══
 *
 *   --live              intent, at the moment of invocation. Cannot be
 *                       inherited from a shell or a stale export.
 *   AI_EVAL_LIVE=true   authorisation from the environment, separable from the
 *                       command. Exactly "true" — "1", "yes" and "TRUE" are all
 *                       refused, matching strictTrue() in limits.ts. An escape
 *                       hatch that can be opened by accident is not a hatch.
 *   --max-spend-usd     a number a person had to think about.
 *
 * They are independent on purpose: no single mistake — a leftover export, a
 * copied command line, a CI secret — satisfies more than one of them.
 *
 * EVERY refusal is collected rather than short-circuiting on the first. An
 * operator who is missing two guards should learn that in one attempt.
 */
export function authorizeLive(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  limits = AI_LIMITS
): LiveAuthorization {
  const refusals: string[] = [];

  // ── Guard A ──
  const flag = argv.includes("--live");
  if (!flag) refusals.push("--live was not passed");

  // ── Guard B ──
  const raw = env.AI_EVAL_LIVE;
  const environment = raw === "true";
  if (!environment) {
    refusals.push(
      raw === undefined || raw === ""
        ? 'AI_EVAL_LIVE is not set (must be exactly "true")'
        : `AI_EVAL_LIVE="${raw}" is not exactly "true"`
    );
  }

  // ── Guard C ──
  const capResult = parseMaxSpend(readFlagValue(argv, "--max-spend-usd"), limits);
  if (!capResult.ok) refusals.push(capResult.reason);

  const authorized = flag && environment && capResult.ok;

  return {
    authorized,
    refusals,
    cap: capResult.ok ? { usd: capResult.usd, micros: capResult.micros } : null,
    guards: { flag, environment, cap: capResult.ok },
  };
}

/** `--name value` or `--name=value`. */
export function readFlagValue(argv: readonly string[], name: string): string | undefined {
  const joined = argv.find((a) => a.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  // A flag whose value is another flag was given no value at all.
  return next === undefined || next.startsWith("--") ? undefined : next;
}

// ══ Admission ═════════════════════════════════

/**
 * May a case start, given what has been spent?
 *
 * ══ RESERVE, DO NOT MERELY CHECK ══
 *
 * The question is not "have we crossed the ceiling?" but "could this case cross
 * it?". Asking the first admits a case at $1.99 of a $2.00 run that then spends
 * $0.06 — the ceiling was consulted and then exceeded, which is the same
 * check-then-act shape that migration 0059 exists to avoid at the daily level.
 *
 * The worst case is not a guess: RequestBudget enforces
 * AI_LIMITS.request.maxCostUsd on every single turn, so no case can cost more
 * than that. Holding exactly that much before starting makes the run cap a
 * cap rather than a tripwire.
 */
export function canAdmitCase(
  spentUsd: number,
  runCapUsd: number,
  worstCasePerCaseUsd: number = AI_LIMITS.request.maxCostUsd
): boolean {
  return toMicros(spentUsd) + toMicros(worstCasePerCaseUsd) <= toMicros(runCapUsd);
}

/** How many worst-case cases a cap could admit from a standing start. */
export function worstCaseCapacity(
  runCapUsd: number,
  worstCasePerCaseUsd: number = AI_LIMITS.request.maxCostUsd
): number {
  const per = toMicros(worstCasePerCaseUsd);
  if (per <= 0) return 0;
  return Math.floor(toMicros(runCapUsd) / per);
}

/**
 * The invariant a future provider client must honour.
 *
 * NOT APPLIED HERE — Phase 2.5A builds no provider. Stated so that whoever adds
 * one in 2.5F has to actively disagree with it rather than never encounter it.
 *
 * The SDK defaults to maxRetries: 2, so one model call can be three billed
 * attempts. Reported usage reflects only the final successful response, which
 * means measured cost silently under-reports what the account is charged, and
 * measured latency silently includes retry backoff. An eval that cannot say how
 * many calls it made cannot say what a call costs.
 *
 * PRODUCTION KEEPS THE DEFAULT. There, resilience for a waiting customer is
 * worth more than measurement precision. These are different concerns and they
 * get different settings.
 */
export const LIVE_PROVIDER_INVARIANT = {
  maxRetries: 0,
  rationale:
    "eval measurement requires one call to mean one call; production keeps the SDK default of 2",
} as const;
