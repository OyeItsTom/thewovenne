/**
 * Runs cases against THE REAL LOOP.
 *
 * ══ WHAT IS REAL HERE AND WHAT IS NOT ══
 *
 * Real: `streamChat` itself — the round loop, MAX_TOOL_ROUNDS, the final
 * tool-free round, tool dispatch, the privileged/non-privileged split,
 * `chatToolsFor`, the TraceRecorder, RequestBudget, cost estimation, outcome
 * classification. All of it is the code that ships.
 *
 * Substituted: the model (scripted) and the non-privileged tool executor
 * (fixtures). Those are the two things that cost money or need a network.
 *
 * NOT substituted: `runOrderTool`. The authorisation boundary keeps its real
 * executor — see the note in lib/chat.ts. That means an authenticated case
 * whose script actually calls the order tool would reach Supabase, so no case
 * does; the boundary is evaluated from the guest side, where the whole question
 * lives, plus a structural check. This is stated as a limitation rather than
 * papered over.
 *
 * ══ NO NETWORK, NO PRODUCTION DATABASE ══
 *
 * `getCatalogueIndex()` and `lookupOrder()` run at the top of streamChat and
 * both read Supabase. The runner therefore installs a read seam via the
 * environment before importing, and asserts afterwards that zero provider calls
 * were made. See `assertOffline`.
 */

import { streamChat, CHAT_MODEL, type ChatMessage } from "../../chat";
import { beginTrace, classifyModelError, outcomeForBudgetStop } from "../observability";
import { RequestBudget, type BudgetStopReason } from "../budget";
import { ScriptedProvider } from "./scriptedProvider";
import { gradeCase } from "./graders";
import type { CaseResult, EvalCase, FixtureToolResponse } from "./types";
import type { ToolOutcome } from "../../chatTools";

/**
 * The catalogue every case sees.
 *
 * Fixed and synthetic, so the system prompt is a known quantity. It names two
 * products and mentions no weaver, village, certification or founding date —
 * which is what lets a grounding case assert that such a claim was invented
 * rather than merely repeated.
 */
export const EVAL_CATALOGUE = [
  "Mul Cotton Saree | mul-cotton-saree | ₹3,200 | in stock",
  "Plain Linen Stole | plain-linen-stole | ₹1,450 | in stock",
].join("\n");

export interface RunOptions {
  /** Swap in a different loop — used ONLY by the evaluator's own mutation tests. */
  loop?: typeof streamChat;
}

function fixtureToOutcome(f: FixtureToolResponse): ToolOutcome {
  return {
    text: f.text,
    found: f.found,
    ...(f.error ? { error: f.error as ToolOutcome["error"] } : {}),
  };
}

export async function runCase(c: EvalCase, opts: RunOptions = {}): Promise<CaseResult> {
  const started = Date.now();
  const loop = opts.loop ?? streamChat;

  const provider = new ScriptedProvider(c.script);
  // Captured, not printed. The recorder already had an `emit` seam for exactly
  // this; a suite that dumps one structured line per case is unreadable, and on
  // the --json path it would corrupt the document.
  const trace = beginTrace({ model: CHAT_MODEL, emit: () => {} });
  trace.setCaller(c.caller === "customer" ? "customer" : "guest");
  trace.setFeatureEnabled(true);
  const budget = new RequestBudget(CHAT_MODEL);
  let budgetStop: BudgetStopReason | null = null;

  const toolsCalled: string[] = [];
  const toolArgs: { tool: string; input: unknown }[] = [];
  let answer = "";
  let threw: string | null = null;

  const runTool = async (name: string, input: unknown): Promise<ToolOutcome> => {
    toolsCalled.push(name);
    toolArgs.push({ tool: name, input });
    const f = c.fixtures?.[name];
    if (!f) {
      return {
        text: `There is no tool called "${name}". Answer from what you already have, or offer WhatsApp.`,
        found: false,
        error: "invalid_tool_call",
      };
    }
    if (f.throws) throw new Error(f.throws);
    return fixtureToOutcome(f);
  };

  const messages: ChatMessage[] = [{ role: "user", content: c.input }];

  // The trace is closed EXACTLY ONCE, on whichever path the turn takes, and the
  // outcome is chosen the same way app/api/chat/route.ts chooses it — a
  // different rule here would be evaluating a different program.
  let finished: CaseResult["trace"] = null;
  try {
    for await (const delta of loop(messages, {
      email: c.caller === "customer" ? (c.sessionEmail ?? null) : null,
      recorder: trace,
      budget,
      provider,
      runTool,
      catalogue: EVAL_CATALOGUE,
      onBudgetStop: (reason) => {
        budgetStop = reason;
      },
    })) {
      answer += delta;
    }
    finished = trace.finish(
      budgetStop
        ? outcomeForBudgetStop(budgetStop)
        : (trace.firstToolError() ??
            (trace.toolCallCount > 0 ? "successful_with_tools" : "successful_no_tool"))
    );
  } catch (err) {
    threw = (err as Error).message;
    finished = trace.finish(classifyModelError(err));
  }

  const ctx = {
    answer,
    toolsCalled,
    toolArgs,
    trace: finished,
    modelCalls: provider.callCount,
    threw,
  };

  const checks = gradeCase(c, ctx);

  return {
    id: c.id,
    dimension: c.dimension,
    severity: c.severity,
    description: c.description,
    passed: checks.every((x) => x.passed),
    checks,
    answer,
    toolsCalled,
    toolArgs,
    trace: finished,
    modelCalls: provider.callCount,
    threw,
    durationMs: Date.now() - started,
  };
}
