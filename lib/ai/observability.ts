/**
 * One trace per Ask Wovenne request.
 *
 * ══ WHAT THIS IS ══
 *
 * A customer message is not one model call. It is up to five, with tool lookups
 * between them, and until now the only thing any of that left behind was a
 * `console.warn` when a tool found nothing. This module records the shape of a
 * turn — how many model calls, which tools, how long each took, how many tokens
 * they burned, what it cost, and how it ended — and emits it as one structured
 * line when the turn is over.
 *
 * ══ METADATA, NOT TRANSCRIPT ══
 *
 * Nothing here accepts message content, tool arguments, tool results, an email
 * address, an order reference or a customer identifier. That is a property of
 * the API surface rather than of a redaction step: `recordToolCall` takes a tool
 * NAME and a duration, and there is no parameter you could pass a customer's
 * order number to even by mistake. A redactor can be forgotten; a function
 * signature that has nowhere to put the secret cannot.
 *
 * The one identity fact recorded is `caller: "guest" | "customer"`, which is a
 * classification rather than an identifier. Deliberately not the quota's hashed
 * key: that hash is stable per person, so storing it beside timings would let
 * one customer's conversations be counted together — pseudonymous, but still a
 * thread you could pull. The classification answers the question the telemetry
 * actually has ("do signed-in customers use more tools?") and answers nothing
 * else.
 *
 * ══ IT MUST NEVER BREAK A REPLY ══
 *
 * Every function below is wrapped so it cannot throw into the caller. A customer
 * waiting on an answer must not lose it because a counter overflowed or a log
 * line failed to serialise. Telemetry that can take down the thing it measures
 * is worse than no telemetry, so the failure mode here is always "the trace is
 * incomplete", never "the request failed".
 *
 * ══ NO PERSISTENCE YET, DELIBERATELY ══
 *
 * Traces go to stdout as JSON, which Vercel already collects. No table, no
 * migration. Two reasons: a migration on `main` must be 0059 or later because
 * 0058 belongs to the parked payment PR, and — more to the point — the volume
 * question should be answered from real traces before a schema is designed
 * around a guess. Structured logs answer every Phase 1 question. Persistence is
 * proposed separately.
 */

import {
  addUsage,
  costUsd,
  isPriced,
  roundCost,
  totalInputTokens,
  totalTokens,
  type TokenUsage,
  ZERO_USAGE,
} from "./cost";

// ══ Taxonomy ══════════════════════════════════
//
// Explicit unions rather than free strings. A typo in a category name is a
// silent hole in a dashboard — it does not error, it just makes a bucket that
// nothing ever looks at again.

/** Something went wrong reaching or reading the model. */
export const MODEL_ERROR_CATEGORIES = [
  "model_provider_error",
  "model_timeout",
  "malformed_model_response",
] as const;
export type ModelErrorCategory = (typeof MODEL_ERROR_CATEGORIES)[number];

/** Something went wrong running a lookup the model asked for. */
export const TOOL_ERROR_CATEGORIES = [
  /** The model named a tool that does not exist. */
  "invalid_tool_call",
  /** The tool exists but the arguments could not be used. */
  "tool_validation_error",
  /** The tool did not finish in time. */
  "tool_timeout",
  /** The tool threw. */
  "tool_internal_error",
] as const;
export type ToolErrorCategory = (typeof TOOL_ERROR_CATEGORIES)[number];

/** How a request ended, without an error of its own. */
export const TERMINAL_OUTCOMES = [
  "successful_no_tool",
  "successful_with_tools",
  /** Quota spent. */
  "rate_limited",
  /** The admin kill switch is off. */
  "feature_disabled",
  /** No usable API key. */
  "not_configured",
  /** Rejected for who the caller is, not what they asked. */
  "permission_refused",
  /** Malformed or empty request body. */
  "bad_request",
  /**
   * The turn stopped on its own spend ceiling. Distinct from an error: the
   * customer usually still got an answer, built from what had been gathered.
   */
  "request_budget_exceeded",
  /** The day's allowance is gone. Nothing was spent on this request. */
  "daily_budget_exceeded",
  /**
   * Spend state could not be established, so nothing was spent. Counting this
   * separately from a real ceiling matters — one is the system working, the
   * other is the system unable to tell whether it is working.
   */
  "budget_unavailable",
] as const;

/** Every way a trace can end. */
export const TRACE_OUTCOMES = [
  ...TERMINAL_OUTCOMES,
  ...MODEL_ERROR_CATEGORIES,
  ...TOOL_ERROR_CATEGORIES,
] as const;
export type TraceOutcome = (typeof TRACE_OUTCOMES)[number];

/** Whether an outcome represents a turn the customer got an answer from. */
export function isSuccessOutcome(outcome: TraceOutcome): boolean {
  return outcome === "successful_no_tool" || outcome === "successful_with_tools";
}

/**
 * Which outcome a budget refusal becomes.
 *
 * The mapping is deliberately lossy in one direction only: several request-level
 * ceilings collapse to one outcome, because a dashboard wants to know "did we
 * stop this turn on budget?" while the exact ceiling that bound is already on
 * the log line's detail. What must NOT collapse is the difference between
 * hitting a ceiling and being unable to read one.
 */
export function outcomeForBudgetStop(reason: string): TraceOutcome {
  switch (reason) {
    case "daily_ceiling":
      return "daily_budget_exceeded";
    case "budget_state_unavailable":
    case "pricing_unknown":
      return "budget_unavailable";
    default:
      return "request_budget_exceeded";
  }
}

// ══ Records ═══════════════════════════════════

/** One round trip to the model. */
export interface ModelCallRecord {
  index: number;
  model: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** `end_turn`, `tool_use`, `max_tokens`… useful for spotting truncation. */
  stop_reason: string | null;
  /** Whether tools were offered on this call — the last round switches them off. */
  tools_offered: boolean;
  error: ModelErrorCategory | null;
}

/**
 * One lookup.
 *
 * There is no field for arguments and no field for the result. `found` is the
 * signal the loop already produced — whether the lookup matched anything — and
 * it says nothing about what was looked up.
 */
export interface ToolCallRecord {
  index: number;
  tool: string;
  latency_ms: number;
  /** Did it run without erroring? A legitimate "no match" is still ok:true. */
  ok: boolean;
  found: boolean;
  /** True for the session-scoped order tool, so privileged use is countable. */
  privileged: boolean;
  error: ToolErrorCategory | null;
}

/** The finished trace, as emitted. */
export interface AiTrace {
  trace_id: string;
  ts: string;
  surface: "ask_wovenne";
  caller: "guest" | "customer";
  feature_enabled: boolean;
  model: string;

  model_calls: number;
  tool_calls: number;

  input_tokens: number;
  output_tokens: number;
  total_tokens: number;

  cost_usd: number | null;
  pricing_known: boolean;

  total_latency_ms: number;
  model_latency_ms: number;
  tool_latency_ms: number;

  outcome: TraceOutcome;

  calls: ModelCallRecord[];
  tools: ToolCallRecord[];
}

// ══ Recorder ══════════════════════════════════

/** Swallow anything a telemetry call throws. See the header. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // Deliberately silent. A telemetry failure that logged an error would turn
    // one dropped measurement into noise in the channel used for real faults.
  }
}

/** Monotonic where available, so a clock adjustment cannot produce a negative. */
function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function newTraceId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    // Never the interesting path, but a trace without an id correlates nothing.
    return `t_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

export interface TraceOptions {
  model: string;
  caller?: "guest" | "customer";
  featureEnabled?: boolean;
  /** Swap the sink in tests. Defaults to a structured line on stdout. */
  emit?: (trace: AiTrace) => void;
}

/**
 * Collects one request's events and emits once.
 *
 * Created in the route, written to by the chat loop, finished exactly once —
 * `finish` is idempotent because a request can end down more than one path (a
 * stream that errors after the happy path has already returned, say) and two
 * lines for one turn would double every total built from them.
 */
export class TraceRecorder {
  readonly traceId: string;
  private readonly startedAt: number;
  private readonly startedIso: string;
  private readonly model: string;
  private readonly emit: (trace: AiTrace) => void;

  private caller: "guest" | "customer";
  private featureEnabled: boolean;

  private calls: ModelCallRecord[] = [];
  private tools: ToolCallRecord[] = [];
  private usage: TokenUsage = ZERO_USAGE;
  private modelLatency = 0;
  private toolLatency = 0;

  private finished = false;
  /** The finished trace, kept so tests and callers can read it back. */
  private result: AiTrace | null = null;

  constructor(opts: TraceOptions) {
    this.traceId = newTraceId();
    this.startedAt = now();
    this.startedIso = new Date().toISOString();
    this.model = opts.model;
    this.caller = opts.caller ?? "guest";
    this.featureEnabled = opts.featureEnabled ?? true;
    this.emit = opts.emit ?? emitTraceLine;
  }

  /** Set once the session has been read. A classification, never an identifier. */
  setCaller(caller: "guest" | "customer"): void {
    safe(() => {
      this.caller = caller;
    });
  }

  setFeatureEnabled(enabled: boolean): void {
    safe(() => {
      this.featureEnabled = enabled;
    });
  }

  /** Start timing a model call. Returns a function that closes it. */
  startModelCall(toolsOffered: boolean): (r: {
    usage?: unknown;
    stopReason?: string | null;
    error?: ModelErrorCategory | null;
  }) => void {
    const index = this.calls.length;
    const t0 = now();

    return (r) =>
      safe(() => {
        const latency = Math.max(0, Math.round(now() - t0));
        const u = readUsageSafely(r.usage);

        this.usage = addUsage(this.usage, u);
        this.modelLatency += latency;
        this.calls.push({
          index,
          model: this.model,
          latency_ms: latency,
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_read_tokens: u.cacheReadTokens,
          cache_write_tokens: u.cacheWriteTokens,
          stop_reason: r.stopReason ?? null,
          tools_offered: toolsOffered,
          error: r.error ?? null,
        });
      });
  }

  /**
   * Record one lookup.
   *
   * Takes a name and a verdict. There is nowhere here to put an argument, and
   * that is the privacy guarantee rather than a convention — see the header.
   */
  recordToolCall(r: {
    tool: string;
    latencyMs: number;
    found: boolean;
    privileged?: boolean;
    error?: ToolErrorCategory | null;
  }): void {
    safe(() => {
      this.toolLatency += Math.max(0, Math.round(r.latencyMs));
      this.tools.push({
        index: this.tools.length,
        tool: r.tool,
        latency_ms: Math.max(0, Math.round(r.latencyMs)),
        ok: !r.error,
        found: r.found,
        privileged: r.privileged ?? false,
        error: r.error ?? null,
      });
    });
  }

  /** How many lookups have run — the route uses this to pick a success outcome. */
  get toolCallCount(): number {
    return this.tools.length;
  }

  /** Whether any tool reported an error, so an outcome can reflect it. */
  firstToolError(): ToolErrorCategory | null {
    for (const t of this.tools) if (t.error) return t.error;
    return null;
  }

  /**
   * Close the trace and emit it. Safe to call more than once; only the first
   * call counts.
   */
  finish(outcome: TraceOutcome): AiTrace | null {
    if (this.finished) return this.result;
    this.finished = true;

    try {
      const cost = costUsd(this.model, this.usage);
      const trace: AiTrace = {
        trace_id: this.traceId,
        ts: this.startedIso,
        surface: "ask_wovenne",
        caller: this.caller,
        feature_enabled: this.featureEnabled,
        model: this.model,
        model_calls: this.calls.length,
        tool_calls: this.tools.length,
        input_tokens: totalInputTokens(this.usage),
        output_tokens: this.usage.outputTokens,
        total_tokens: totalTokens(this.usage),
        cost_usd: roundCost(cost),
        pricing_known: isPriced(this.model),
        total_latency_ms: Math.max(0, Math.round(now() - this.startedAt)),
        model_latency_ms: this.modelLatency,
        tool_latency_ms: this.toolLatency,
        outcome,
        calls: this.calls,
        tools: this.tools,
      };
      this.result = trace;
      safe(() => this.emit(trace));
      return trace;
    } catch {
      return null;
    }
  }

  /** The emitted trace, for tests and for a caller that wants to inspect it. */
  get trace(): AiTrace | null {
    return this.result;
  }
}

/** Local copy of readUsage that cannot throw, whatever it is handed. */
function readUsageSafely(usage: unknown): TokenUsage {
  try {
    // Imported lazily by reference rather than at call time so a malformed
    // object cannot escape the try.
    const u = (usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    return {
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens),
      cacheReadTokens: n(u.cache_read_input_tokens),
      cacheWriteTokens: n(u.cache_creation_input_tokens),
    };
  } catch {
    return ZERO_USAGE;
  }
}

// ══ Budget events ═════════════════════════════

/**
 * The lifecycle of one request's daily-budget hold.
 *
 * Separate from the trace because they happen at different moments: a
 * reservation is granted before the model is called and settled after the
 * customer already has their answer, while a trace is emitted once at the end.
 * Folding settlement into the trace would mean either delaying the trace until
 * reconciliation finished, or emitting a trace that says nothing about whether
 * the money was ever accounted for.
 */
export const BUDGET_EVENTS = [
  "daily_budget_reserved",
  "daily_budget_denied",
  "daily_budget_unavailable",
  "daily_budget_reconciled",
  "reconciliation_failed",
] as const;
export type BudgetEvent = (typeof BUDGET_EVENTS)[number];

/**
 * Emit one budget event.
 *
 * SAME PRIVACY RULE AS THE TRACE. Amounts, a reservation id and a trace id —
 * nothing else. The reservation id is server-generated and random; it names a
 * row in an aggregate table and can never be resolved back to a person, because
 * that table holds no person to resolve to.
 */
export function emitBudgetEvent(
  event: BudgetEvent,
  fields: {
    traceId?: string;
    reservationId?: string;
    amountUsd?: number | null;
    actualUsd?: number | null;
    detail?: string;
  } = {}
): void {
  safe(() =>
    console.log(
      JSON.stringify({
        evt: "ai_budget",
        event,
        ts: new Date().toISOString(),
        ...fields,
      })
    )
  );
}

/**
 * The default sink: one JSON line on stdout.
 *
 * `console.log`, not `console.error` — a successful turn is not a fault, and
 * routing traces through the error channel would bury real failures in Sentry
 * under a stream of ordinary conversations. Faults still log separately where
 * they happen.
 *
 * The `evt` discriminator is what makes these greppable in Vercel's log search
 * and parseable by anything downstream without matching on prose.
 */
export function emitTraceLine(trace: AiTrace): void {
  console.log(JSON.stringify({ evt: "ai_trace", ...trace }));
}

/**
 * Classify a thrown model error.
 *
 * Duck-typed rather than instanceof-checked against the SDK's error classes, so
 * this module needs no dependency on the provider. It also keeps working if a
 * transport error arrives from below the SDK, where those classes never apply.
 */
export function classifyModelError(err: unknown): ModelErrorCategory {
  const e = err as { name?: unknown; message?: unknown; status?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const message = typeof e?.message === "string" ? e.message : "";
  const text = `${name} ${message}`.toLowerCase();

  if (text.includes("timeout") || text.includes("timed out") || text.includes("etimedout")) {
    return "model_timeout";
  }
  if (text.includes("abort")) return "model_timeout";
  return "model_provider_error";
}

/** Start a trace. A thin wrapper so callers never touch the class directly. */
export function beginTrace(opts: TraceOptions): TraceRecorder {
  return new TraceRecorder(opts);
}
