/**
 * Recommended ceilings, derived from the Phase 1 pricing abstraction.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/ai-budget-baseline.ts
 *
 * Makes no model calls. Everything here is arithmetic over `lib/ai/cost.ts` and
 * the shapes measured in the Phase 1 baseline, so the recommendations move
 * automatically when a rate or a limit changes.
 *
 * MEASURED and RECOMMENDED are labelled separately throughout. A recommendation
 * is a judgement about acceptable loss; a measurement is not, and running them
 * together is how a guess acquires the authority of a number.
 */
import fs from "node:fs";

// Phase 1 measured shapes (see reports/ai-observability/cost-baseline.md).
// Input figures are themselves ESTIMATED — no usable local key — which is
// carried through to every line below.
const SHAPES = [
  { name: "No tool", calls: 1, inTok: 2_049, outLow: 120, outHigh: 320 },
  { name: "One tool", calls: 2, inTok: 4_194, outLow: 160, outHigh: 410 },
  { name: "Multi tool", calls: 3, inTok: 7_431, outLow: 200, outHigh: 500 },
  { name: "Worst case", calls: 5, inTok: 12_454, outLow: 280, outHigh: 680 },
];

async function main() {
  const { AI_LIMITS } = await import("../lib/ai/limits");
  const cost = await import("../lib/ai/cost");
  const { CHAT_MODEL } = await import("../lib/chat");
  const { SIGNED_IN_MESSAGE_LIMIT, ANON_MESSAGE_LIMIT } = await import("../lib/chatQuota");

  const priced = (inTok: number, outTok: number) =>
    cost.costUsd(CHAT_MODEL, {
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

  const rows = SHAPES.map((s) => ({
    ...s,
    low: priced(s.inTok, s.outLow),
    high: priced(s.inTok, s.outHigh),
  }));
  const worst = rows[rows.length - 1];
  const typical = rows[1];

  const usd = (n: number | null, dp = 5) => (n == null ? "n/a" : `$${n.toFixed(dp)}`);

  const L = AI_LIMITS;
  const enforcedPerRequest = L.request.maxCostUsd;
  const measuredWorst = worst.high ?? 0;

  const out: string[] = [];
  const w = (s = "") => out.push(s);

  w("# Ask Wovenne — budget recommendations");
  w();
  w(`Generated ${new Date().toISOString()} · model \`${CHAT_MODEL}\` · pricing as of ${cost.PRICING_AS_OF}`);
  w();
  w("No model calls were made. Every figure is arithmetic over `lib/ai/cost.ts`.");
  w();
  w("## Measured (Phase 1 shapes)");
  w();
  w("Input token counts are themselves ESTIMATED — `.env.local` holds a placeholder key,");
  w("so `countTokens` could not run. Output tokens are ESTIMATED by construction.");
  w();
  w("| Shape | Model calls | Input tok | Cost low | Cost high |");
  w("|---|--:|--:|--:|--:|");
  for (const r of rows) {
    w(`| ${r.name} | ${r.calls} | ${r.inTok.toLocaleString()} | ${usd(r.low)} | ${usd(r.high)} |`);
  }
  w();
  w(`**Measured worst case: ${usd(measuredWorst)} per request.**`);
  w();
  w("## Enforced ceilings (now in force)");
  w();
  w("| Limit | Value | Env var | Rationale |");
  w("|---|--:|---|---|");
  w(`| Max cost / request | ${usd(enforcedPerRequest, 4)} | \`AI_MAX_COST_PER_REQUEST_USD\` | ~${(enforcedPerRequest / measuredWorst).toFixed(1)}× the measured worst case — a runaway loop stops, a long answer never does |`);
  w(`| Max tokens / request | ${L.request.maxTokens.toLocaleString()} | \`AI_MAX_TOKENS_PER_REQUEST\` | ~${(L.request.maxTokens / worst.inTok).toFixed(1)}× the worst measured turn; backstop when pricing is unknown |`);
  w(`| Max model calls / request | ${L.request.maxModelCalls} | \`AI_MAX_MODEL_CALLS_PER_REQUEST\` | Equals the loop's structural max (MAX_TOOL_ROUNDS 4 + 1). The loop stays authoritative |`);
  w(`| Assumed input tok on unreadable usage | ${L.request.assumedInputTokensOnUnreadableUsage.toLocaleString()} | \`AI_ASSUMED_INPUT_TOKENS\` | Never zero — that is the bypass |`);
  w(`| Assumed output tok on unreadable usage | ${L.request.assumedOutputTokensOnUnreadableUsage.toLocaleString()} | \`AI_ASSUMED_OUTPUT_TOKENS\` | The request's own max_tokens |`);
  w(`| Daily ceiling | ${usd(L.daily.maxCostUsd, 2)} | \`AI_DAILY_BUDGET_USD\` | See below. **Not yet enforceable** |`);
  w(`| Fail open | ${L.daily.failOpen} | \`AI_BUDGET_FAIL_OPEN\` | Only the literal "true" opens it |`);
  w();
  w("## Theoretical maximum per user per hour");
  w();
  w("Under the existing quota, which is the only other limit.");
  w();
  w("| Tier | Messages/hour | At measured worst case | At the enforced ceiling |");
  w("|---|--:|--:|--:|");
  w(`| Anonymous | ${ANON_MESSAGE_LIMIT} | ${usd(measuredWorst * ANON_MESSAGE_LIMIT, 2)} | ${usd(enforcedPerRequest * ANON_MESSAGE_LIMIT, 2)} |`);
  w(`| Signed in | ${SIGNED_IN_MESSAGE_LIMIT} | ${usd(measuredWorst * SIGNED_IN_MESSAGE_LIMIT, 2)} | ${usd(enforcedPerRequest * SIGNED_IN_MESSAGE_LIMIT, 2)} |`);
  w();
  w("**This is per identity, and identities are cheap.** The anonymous tier is keyed on a");
  w("hashed IP; the signed-in tier on a customer id, and an account costs an email address.");
  w("So the per-user figures above bound one abuser's hourly spend, not the project's.");
  w("Only a daily ceiling does that — which is exactly why the next section matters.");
  w();
  w("## Recommendations");
  w();
  w("Judgements, not measurements.");
  w();
  const dailyWorst = Math.floor(L.daily.maxCostUsd / measuredWorst);
  const dailyTypical = Math.floor(L.daily.maxCostUsd / (typical.high ?? 1));
  w(`**Daily project ceiling: ${usd(L.daily.maxCostUsd, 2)}/day** (~£${(L.daily.maxCostUsd * 0.79).toFixed(2)} at a nominal rate).`);
  w(`That buys ~${dailyWorst} worst-case requests or ~${dailyTypical} typical ones per day —`);
  w("comfortably more than a shop with 34 products and one order in its history will see,");
  w("and small enough that a runaway costs the price of a coffee before it trips.");
  w("Raise it when real traffic justifies it, not in anticipation.");
  w();
  const evalWorstCases = Math.floor(L.evaluation.maxCostUsd / measuredWorst);
  w(`**Eval-run ceiling: ${usd(L.evaluation.maxCostUsd, 2)} per run**, ${L.evaluation.maxCases} cases, ${L.evaluation.maxModelCalls} model calls, ${L.evaluation.maxTokens.toLocaleString()} tokens.`);
  w(`At the worst-case shape that is ~${evalWorstCases} requests — more than the ${L.evaluation.maxCases}-case cap allows,`);
  w("so the case count binds first and the dollar figure is the backstop. That is the right");
  w("order: a run should end because it finished its cases, not because it ran out of money.");
  w();
  w("**Separate pots.** The eval budget is deliberately not drawn from the daily production");
  w("ceiling. A thorough eval run must never be the reason a customer gets turned away.");
  w();
  w("## The gap this does not close");
  w();
  w("The daily ceiling above is **configured but not enforceable**: there is no durable");
  w("store to add up the day's spend, so `checkDailyBudget()` reports unavailable and — by");
  w("design — denies. Per-request and per-eval ceilings are fully enforced in process.");
  w();
  w("Until a store exists, the effective protection is: per-request ceiling × the quota,");
  w("per identity. That bounds one abuser, not the project.");
  w();

  fs.mkdirSync("reports/ai-observability", { recursive: true });
  fs.writeFileSync("reports/ai-observability/budget-recommendations.md", out.join("\n"));
  console.log(out.join("\n"));
  console.log("\nWritten to reports/ai-observability/budget-recommendations.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
