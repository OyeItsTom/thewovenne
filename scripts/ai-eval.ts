/**
 * The offline evaluation suite.
 *
 *   npx tsx scripts/ai-eval.ts            human-readable
 *   npx tsx scripts/ai-eval.ts --json     machine-readable, for CI
 *
 * Exits NON-ZERO if any hard gate fails, so it can be a merge gate as-is.
 *
 * ══ IT CANNOT SPEND MONEY AND IT CANNOT REACH ANTHROPIC ══
 *
 * The key set below is a fake, and every model call goes through ScriptedProvider,
 * which holds no HTTP client. The `--live` flag does not exist: see the note at
 * the bottom of this file about why adding it must be a deliberate act rather
 * than an if-statement somebody flips.
 */

// A syntactically valid but fake key, set BEFORE lib/chat.ts is imported so the
// module-level Anthropic client can be constructed. It is never used: the
// scripted provider answers every call. Setting a real key here would change
// nothing about what runs — which is the point of the guard below.
process.env.ANTHROPIC_API_KEY = "sk-ant-eval-offline-fake-key-000000000000000000";

import { CASES } from "../lib/ai/eval/cases";
import { runCase } from "../lib/ai/eval/runner";
import { scoreRun, runIsComplete } from "../lib/ai/eval/scoring";
import { AI_LIMITS } from "../lib/ai/limits";
import { EvalBudget } from "../lib/ai/budget";
import { CHAT_MODEL } from "../lib/chat";
import type { CaseResult } from "../lib/ai/eval/types";

const JSON_OUT = process.argv.includes("--json");

/**
 * Refuse to run if anything looks like it might reach the network.
 *
 * Cheap, and it catches the one mistake that would matter: somebody adding a
 * live path and forgetting that this file is what CI runs.
 */
function assertOffline() {
  if (process.argv.includes("--live")) {
    console.error(
      "ai-eval: --live is not implemented. Offline evaluation must never silently become a billed run."
    );
    process.exit(2);
  }
}

function validate(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of CASES) {
    if (seen.has(c.id)) problems.push(`duplicate case id: ${c.id}`);
    seen.add(c.id);
    if (c.script.length === 0) problems.push(`${c.id}: empty script`);
    if (c.caller === "guest" && c.sessionEmail) {
      problems.push(`${c.id}: a guest case must not carry a session email`);
    }
    // A case that asserts nothing would pass forever without testing anything.
    const asserts =
      c.expectTools || c.forbidTools || c.expectToolOrder || c.expectToolArgs ||
      c.expectPhrases || c.forbidPhrases || c.expectOutcome ||
      c.maxModelCalls !== undefined || c.maxToolCalls !== undefined ||
      c.maxCostUsd !== undefined || c.maxTokens !== undefined || c.privacyMarkers;
    if (!asserts) problems.push(`${c.id}: states no expectation — it can never fail`);
  }
  return problems;
}

async function main() {
  assertOffline();

  const problems = validate();
  if (problems.length) {
    console.error("ai-eval: case schema problems:\n  " + problems.join("\n  "));
    process.exit(2);
  }

  if (CASES.length > AI_LIMITS.evaluation.maxCases) {
    console.error(
      `ai-eval: ${CASES.length} cases exceeds the configured ceiling of ${AI_LIMITS.evaluation.maxCases}.`
    );
    process.exit(2);
  }

  // Real EvalBudget, fed the SIMULATED usage the scripted provider reports. It
  // is not protecting a wallet here — nothing is being bought — it is being
  // exercised, so that the accounting a live run would depend on is known to
  // work before a live run exists.
  const evalBudget = new EvalBudget(CHAT_MODEL);

  const started = Date.now();
  const results: CaseResult[] = [];
  /**
   * Why the run stopped early, if it did.
   *
   * ══ A TRUNCATED RUN IS A FAILED RUN ══
   *
   * The first version of this file broke out of the loop, reported
   * "32/32 passed" and exited 0 — while five cases, three of them privacy
   * cases, had never executed. Every case that ran had passed, so every number
   * on the report was true, and the report was still a lie: it answered "did
   * anything fail?" when the question is "did we check?".
   *
   * An exhausted budget now poisons the verdict outright. Skipped cases are not
   * absent evidence, they are unmet obligations.
   */
  let truncatedAt: string | null = null;
  for (const c of CASES) {
    const verdict = evalBudget.canStartCase();
    if (!verdict.allowed) {
      truncatedAt = `${c.id} — ${verdict.reason}: ${verdict.detail}`;
      console.error(`ai-eval: RUN TRUNCATED at ${truncatedAt}`);
      break;
    }
    evalBudget.recordCase();
    const r = await runCase(c);
    for (const call of r.trace?.calls ?? []) {
      evalBudget.recordCall({
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        cache_read_input_tokens: call.cache_read_tokens,
        cache_creation_input_tokens: call.cache_write_tokens,
      });
    }
    results.push(r);
  }
  const elapsed = Date.now() - started;

  const scored = scoreRun(results);
  // Every case must have run. A skipped case is an unanswered question, and an
  // unanswered question is not a pass.
  const complete = runIsComplete(CASES.length, results.length, truncatedAt);
  const verdict = { ...scored, passed: scored.passed && complete };
  const spend = evalBudget.spent;
  const simulated = {
    model_calls: results.reduce((n, r) => n + r.modelCalls, 0),
    tool_calls: results.reduce((n, r) => n + r.toolsCalled.length, 0),
    tokens: spend.tokens,
    cost_usd_SIMULATED: spend.costUsd,
  };

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          passed: verdict.passed,
          cases: verdict.cases,
          checks: verdict.checks,
          dimensions: verdict.dimensions,
          gates: verdict.gates.map((g) => ({
            dimension: g.gate.dimension,
            threshold: g.gate.threshold,
            score: g.score,
            held: g.held,
          })),
          critical_failures: verdict.criticalFailures,
          complete: complete,
          truncated_at: truncatedAt,
          cases_defined: CASES.length,
          simulated,
          actual_provider_calls: 0,
          actual_provider_spend_usd: 0,
          elapsed_ms: elapsed,
          failures: results.filter((r) => !r.passed).map((r) => ({
            id: r.id,
            dimension: r.dimension,
            severity: r.severity,
            failed: r.checks.filter((c) => !c.passed),
          })),
        },
        null,
        2
      )
    );
    process.exit(verdict.passed ? 0 : 1);
  }

  const pct = (s: number | null) => (s === null ? "  —  " : `${(s * 100).toFixed(0)}%`.padStart(5));

  console.log("\n══ ASK WOVENNE — OFFLINE EVALUATION ══\n");
  console.log(`Run:        ${verdict.passed ? "PASS" : "FAIL"}`);
  console.log(`Cases:      ${verdict.cases.passed}/${verdict.cases.total} passed  (${CASES.length} defined)`);
  if (!complete) {
    console.log(`            TRUNCATED — ${CASES.length - results.length} case(s) never ran: ${truncatedAt}`);
  }
  console.log(`Checks:     ${verdict.checks.passed}/${verdict.checks.total} passed`);
  console.log(`Hard gates: ${verdict.gates.every((g) => g.held) ? "PASS" : "FAIL"}`);
  console.log(`Elapsed:    ${elapsed}ms\n`);

  console.log("Dimensions");
  for (const d of verdict.dimensions) {
    const gate = verdict.gates.find((g) => g.gate.dimension === d.dimension);
    const mark = gate ? (gate.held ? "ok  " : "FAIL") : "    ";
    console.log(`  ${mark} ${d.dimension.padEnd(18)} ${pct(d.score)}  ${d.passed}/${d.total}`);
  }

  const failures = results.filter((r) => !r.passed);
  if (failures.length) {
    console.log("\nFailures");
    for (const r of failures) {
      console.log(`\n  ${r.id}  [${r.dimension} / ${r.severity}]`);
      console.log(`    ${r.description}`);
      for (const c of r.checks.filter((x) => !x.passed)) {
        console.log(`    ✗ ${c.name}`);
        console.log(`        expected: ${c.expected}`);
        console.log(`        actual:   ${c.actual}`);
      }
    }
  }

  console.log("\nSimulated usage (NOT real spend)");
  console.log(`  simulated model calls : ${simulated.model_calls}`);
  console.log(`  simulated tool calls  : ${simulated.tool_calls}`);
  console.log(`  simulated tokens      : ${simulated.tokens}`);
  console.log(`  SIMULATED cost        : $${simulated.cost_usd_SIMULATED?.toFixed(4) ?? "0.0000"}`);
  console.log("\n  ACTUAL provider calls : 0");
  console.log("  ACTUAL provider spend : $0.00\n");

  process.exit(verdict.passed ? 0 : 1);
}

main().catch((e) => {
  console.error("ai-eval crashed:", e);
  process.exit(2);
});
