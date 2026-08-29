/**
 * Live evaluation — SAFETY ENVELOPE ONLY. Phase 2.5A.
 *
 *   AI_EVAL_LIVE=true npx tsx scripts/ai-eval-live.ts --live --max-spend-usd 0.60
 *
 * ══ THIS FILE CANNOT SPEND MONEY, AND THAT IS THE ENTIRE POINT ══
 *
 * It validates authorisation and then stops. Even a fully authorised
 * invocation — all three guards satisfied, a valid cap, a real key sitting in
 * the environment — reaches a printed refusal rather than a provider, because
 * there is no provider here to reach. No Anthropic import, no client, no
 * network, no tool call, no database write.
 *
 * The order is deliberate: build the brake before the engine. A safety
 * mechanism written after the dangerous capability is a safety mechanism
 * written under pressure to let something through.
 *
 * ══ WHY IT IS A SEPARATE FILE ══
 *
 * scripts/ai-eval.ts is what CI runs, and it must contain no live code path at
 * all. A flag on a shared file is protection by convention — someone has to
 * remember not to pass it. Two files means the file CI runs is structurally
 * incapable of billing, whatever secrets exist in the environment.
 *
 * Deliberately NOT wired into package.json. A script entry is a shorter path to
 * an accidental invocation, and this command should stay something a person
 * types out in full.
 */

import { authorizeLive, worstCaseCapacity, LIVE_PROVIDER_INVARIANT } from "../lib/ai/eval/liveGuard";
import { AI_LIMITS } from "../lib/ai/limits";

/** Exit codes, so a caller can tell refusal from malfunction. */
const EXIT_OK = 0;
const EXIT_REFUSED = 2;

export function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  log: (s: string) => void = console.log,
  err: (s: string) => void = console.error
): number {
  // NOTHING about the API key is read here. Not its presence, not its shape,
  // not its length. A key is credential availability; these three guards are
  // authorisation. Conflating them is how a deploy becomes a decision.
  const auth = authorizeLive(argv, env);

  if (!auth.authorized) {
    err("\n══ LIVE EVALUATION REFUSED ══\n");
    for (const r of auth.refusals) err(`  ✗ ${r}`);
    err("\n  All three guards are required:");
    err("    --live                    explicit intent at invocation");
    err('    AI_EVAL_LIVE=true         environment authorisation (exactly "true")');
    err("    --max-spend-usd <n>       an explicit cap; there is no default");
    err("\n  Provider calls made: 0.  Spend: $0.00.\n");
    return EXIT_REFUSED;
  }

  const cap = auth.cap!;
  const worst = AI_LIMITS.request.maxCostUsd;
  const capacity = worstCaseCapacity(cap.usd, worst);

  log("\n══ ASK WOVENNE — LIVE AUTHORIZATION CHECK ══\n");
  log("  Mode                          LIVE AUTHORIZATION CHECK ONLY");
  log("  Guards                        --live ✓   AI_EVAL_LIVE ✓   --max-spend-usd ✓");
  log("");
  log(`  Requested maximum             $${cap.usd.toFixed(2)}`);
  log(`  Global eval ceiling           $${AI_LIMITS.evaluation.maxCostUsd.toFixed(2)}`);
  log(`  Worst-case reservation/case   $${worst.toFixed(2)}`);
  log(`  Max worst-case cases admitted ${capacity}`);
  log(`  Case ceiling for a run        ${AI_LIMITS.evaluation.maxCases}`);
  log("");
  log("  Provider execution            NOT IMPLEMENTED (Phase 2.5A)");
  log("  Provider calls                0");
  log("  Actual spend                  $0.00");
  log("");
  log("  Live evaluation authorization validated.");
  log("  Provider execution is not implemented in Phase 2.5A — nothing was spent.");
  log("");
  log(`  When a provider is added (2.5F) it must use maxRetries: ${LIVE_PROVIDER_INVARIANT.maxRetries} —`);
  log(`  ${LIVE_PROVIDER_INVARIANT.rationale}.`);
  log("");

  return EXIT_OK;
}

// Only run when invoked directly, so the tests can call main() without the
// process exiting underneath them.
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /ai-eval-live\.[tj]s$/.test(process.argv[1]);

if (invokedDirectly) {
  process.exit(main());
}
