/**
 * What an evaluation case IS.
 *
 * ══ THE SHAPE FOLLOWS THE QUESTION, NOT THE OTHER WAY ROUND ══
 *
 * The question this suite answers is "would we notice if Ask Wovenne started
 * behaving badly?", and the ways it can behave badly are not equivalent. A
 * verbose answer is a nuisance; handing a stranger somebody else's order is an
 * incident. So a case does not carry one blob of "expected output" — it carries
 * separate, independently gradable expectations, and each grader reports which
 * DIMENSION it speaks to and how much a failure MATTERS.
 *
 * That is why there is no `expectedAnswer: string` field. Comparing generated
 * prose to a golden string measures phrasing, which is the one thing we do not
 * care about; every text expectation here is a PROPERTY — this fact may appear,
 * that claim may not.
 *
 * ══ EVERY FIELD IS OPTIONAL EXCEPT IDENTITY AND SCRIPT ══
 *
 * A case states only what it is about. An authorisation case says nothing about
 * token counts; a budget case says nothing about grounding. Absent expectations
 * are NOT graded — silence is not a passing grade, it is an absence of opinion,
 * and a grader that quietly passes on missing configuration would let a case
 * rot into vacuity without anyone noticing.
 *
 * ══ NO PRODUCTION DATA, EVER ══
 *
 * Cases are checked into the repository and read by anyone with the repo. They
 * carry synthetic products and invented order references only. No customer, no
 * real email, no real order.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AiTrace, TraceOutcome } from "../observability";

/** Which axis of behaviour a check speaks to. Reported separately, always. */
export type EvalDimension =
  | "tool_selection"
  | "grounding"
  | "authorization"
  | "failure_handling"
  | "budget"
  | "privacy"
  | "execution_bounds";

/**
 * How much a failure matters.
 *
 * `critical` is not "important" — it is "this must never happen, and a run
 * containing one is a failed run regardless of what else passed". Authorisation,
 * privacy, execution bounds and budget bypasses are critical by nature; a
 * clumsy sentence is not.
 */
export type EvalSeverity = "critical" | "major" | "minor";

/**
 * One scripted model turn.
 *
 * Either the model says something, or it asks for tools, or it fails. A turn
 * that both speaks and calls tools is expressible — real models do it — by
 * giving both `text` and `toolCalls`.
 */
export interface ScriptedTurn {
  /** Text the model streams. Split into deltas by the provider. */
  text?: string;
  /** Tools it asks for. Presence implies stop_reason "tool_use". */
  toolCalls?: { name: string; input: unknown }[];
  /**
   * Claim `tool_use` while naming no tool — the one malformed shape the loop
   * can actually detect.
   */
  malformed?: boolean;
  /** Fail this turn instead of answering. */
  error?: { type: "provider_error" | "timeout" | "overloaded"; message: string };
  /**
   * Usage the provider reports. Deliberately settable to nonsense so the
   * budget's "unreadable usage is not zero" rule can be exercised.
   */
  usage?: unknown;
}

/** What a fixture tool returns when the loop asks for it. */
export interface FixtureToolResponse {
  text: string;
  found: boolean;
  error?: string;
  /** Throw instead of returning — a tool that fails past its own handler. */
  throws?: string;
}

export interface EvalCase {
  id: string;
  dimension: EvalDimension;
  severity: EvalSeverity;
  description: string;

  /** Guest, or a customer whose identity came from a verified session. */
  caller: "guest" | "customer";
  /**
   * The session email for a customer case. SYNTHETIC ONLY.
   * Never present for a guest — that is the boundary under test.
   */
  sessionEmail?: string;

  /** The customer's message(s). */
  input: string;

  /** What the scripted model does, turn by turn. */
  script: ScriptedTurn[];

  /** Tool name → what the fixture returns. */
  fixtures?: Record<string, FixtureToolResponse>;

  // ── Tool expectations ─────────────────────
  /** These tools must have been called. */
  expectTools?: string[];
  /** These must NOT have been called, in any circumstance. */
  forbidTools?: string[];
  /** Exact call order, when order is part of the behaviour. */
  expectToolOrder?: string[];
  /** Predicates over the arguments the model actually sent. */
  expectToolArgs?: { tool: string; predicate: (input: unknown) => boolean; describe: string }[];

  // ── Answer expectations, as properties ────
  /** Substrings that must appear (case-insensitive). */
  expectPhrases?: string[];
  /**
   * Substrings that must NOT appear. This is where an unsupported claim is
   * caught: a fixture with no artisan name must not produce one.
   */
  forbidPhrases?: string[];

  // ── Trace / execution expectations ────────
  expectOutcome?: TraceOutcome;
  maxModelCalls?: number;
  maxToolCalls?: number;
  /** Simulated only — the scripted provider reports whatever usage it is told to. */
  maxCostUsd?: number;
  maxTokens?: number;

  // ── Privacy ───────────────────────────────
  /**
   * Markers pushed through the input and fixtures that must never reach the
   * emitted trace. Synthetic sentinels, never real data.
   */
  privacyMarkers?: string[];

  tags?: string[];
}

/** One graded assertion. */
export interface CheckResult {
  dimension: EvalDimension;
  severity: EvalSeverity;
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

/** Everything one case produced. */
export interface CaseResult {
  id: string;
  dimension: EvalDimension;
  severity: EvalSeverity;
  description: string;
  passed: boolean;
  checks: CheckResult[];
  /** What the loop actually did. */
  answer: string;
  toolsCalled: string[];
  toolArgs: { tool: string; input: unknown }[];
  trace: AiTrace | null;
  modelCalls: number;
  threw: string | null;
  durationMs: number;
}

/** A model reply the scripted provider assembles. */
export type ScriptedMessage = Anthropic.Message;
