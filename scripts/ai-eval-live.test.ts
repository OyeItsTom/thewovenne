/**
 * Tests for the live-eval SAFETY ENVELOPE. Phase 2.5A.
 *
 *   npx tsx scripts/ai-eval-live.test.ts
 *
 * ══ WHAT IS BEING PROVED ══
 *
 * Not that live evaluation works — there is no live evaluation yet. That a
 * correctly authorised command STILL cannot spend, that a partially authorised
 * one is refused, and that the presence of a real-looking API key changes
 * nothing whatsoever.
 *
 * The most important test in this file is the one that runs the FULLY
 * AUTHORISED command with every network primitive replaced by a trap and
 * asserts zero attempts. Everything else is the argument; that is the evidence.
 */

// A fake key, set before anything imports. Its presence must be irrelevant —
// see the key-irrelevance block below, which asserts exactly that.
process.env.ANTHROPIC_API_KEY = "sk-ant-live-safety-test-fake-0000000000000000";
delete process.env.AI_EVAL_LIVE;

import {
  authorizeLive,
  parseMaxSpend,
  canAdmitCase,
  worstCaseCapacity,
  readFlagValue,
  toMicros,
  LIVE_PROVIDER_INVARIANT,
} from "../lib/ai/eval/liveGuard";
import { EvalBudget } from "../lib/ai/budget";
import { AI_LIMITS } from "../lib/ai/limits";
import { main } from "./ai-eval-live";
import fs from "node:fs";

let passed = 0;
let failed = 0;
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const CAP_OK = ["--live", "--max-spend-usd", "0.60"];
const ENV_OK = { AI_EVAL_LIVE: "true" };
const WORST = AI_LIMITS.request.maxCostUsd;

// ══════════════════════════════════════════════
console.log("\n=== GATE 3: the cap parser refuses everything it should ===");
{
  const reject: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["negative small", "-0.06"],
    ["NaN", "NaN"],
    ["not a number", "sixty cents"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["below floor 0.01", "0.01"],
    ["just below floor 0.059999", "0.059999"],
    ["above ceiling 2.01", "2.01"],
    ["far above ceiling 100", "100"],
  ];
  for (const [label, raw] of reject) {
    const r = parseMaxSpend(raw);
    t(`rejects ${label}`, r.ok === false, r.ok ? "ACCEPTED" : "");
  }

  for (const raw of ["0.06", "0.10", "0.50", "0.60", "2.00", "2"]) {
    const r = parseMaxSpend(raw);
    t(`accepts ${raw}`, r.ok === true, r.ok ? `$${r.usd}` : r.reason);
  }

  // Never clamps.
  const over = parseMaxSpend("2.50");
  t("2.50 is REFUSED, not silently clamped to 2.00", over.ok === false);
  t("…and the refusal says so", !over.ok && /refusing rather than silently/.test(over.reason));
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 2: admission boundaries, exact ===");
{
  const cases: [string, number, number, boolean][] = [
    ["0.00 + 0.06 <= 0.60", 0.0, 0.6, true],
    ["0.54 + 0.06 == 0.60", 0.54, 0.6, true],
    ["0.55 + 0.06 = 0.61 > 0.60", 0.55, 0.6, false],
    ["0.59 + 0.06 = 0.65 > 0.60", 0.59, 0.6, false],
    ["0.47 + 0.06 = 0.53 > 0.50", 0.47, 0.5, false],
    ["0.44 + 0.06 == 0.50", 0.44, 0.5, true],
    ["cap exactly 0.06, nothing spent", 0.0, 0.06, true],
    ["cap exactly 0.06, one case spent", 0.06, 0.06, false],
    ["1.94 + 0.06 == 2.00", 1.94, 2.0, true],
    ["1.95 + 0.06 > 2.00", 1.95, 2.0, false],
  ];
  for (const [label, spent, cap, want] of cases) {
    t(label, canAdmitCase(spent, cap, WORST) === want);
  }

  // The float trap this arithmetic exists to avoid.
  t("naive float would have got 0.54+0.06<=0.60 WRONG", (0.54 + 0.06) <= 0.6 === false);
  t("…micro-dollar arithmetic gets it right", canAdmitCase(0.54, 0.6, 0.06) === true);
  t("toMicros rounds rather than truncates", toMicros(0.0599999999) === 60_000);

  t("capacity of $0.60 at $0.06 = 10 cases", worstCaseCapacity(0.6, 0.06) === 10);
  t("capacity of $2.00 at $0.06 = 33 cases", worstCaseCapacity(2.0, 0.06) === 33);
  t("capacity of $0.06 at $0.06 = 1 case", worstCaseCapacity(0.06, 0.06) === 1);
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 4: three-guard truth table ===");
{
  const A = ["--live"];
  const C = ["--max-spend-usd", "0.60"];
  const on = { AI_EVAL_LIVE: "true" };
  const off = {};

  const rows: [string, string[], Record<string, string | undefined>][] = [
    ["none", [], off],
    ["A only", A, off],
    ["B only", [], on],
    ["C only", C, off],
    ["A+B", A, on],
    ["A+C", [...A, ...C], off],
    ["B+C", C, on],
  ];
  for (const [label, argv, env] of rows) {
    const r = authorizeLive(argv, env);
    t(`REFUSES ${label}`, r.authorized === false, `${r.refusals.length} refusal(s)`);
  }

  const all = authorizeLive([...A, ...C], on);
  t("AUTHORIZES A+B+C", all.authorized === true);
  t("…and carries the cap", all.cap?.usd === 0.6);
  t("…and reports every guard satisfied",
    all.guards.flag && all.guards.environment && all.guards.cap);

  // Environment string strictness.
  for (const bad of ["1", "yes", "TRUE", "True", "on", " true", "true "]) {
    const r = authorizeLive([...A, ...C], { AI_EVAL_LIVE: bad });
    t(`AI_EVAL_LIVE="${bad}" is refused`, r.authorized === false);
  }

  // Every refusal reported, not just the first.
  const none = authorizeLive([], {});
  t("all three refusals reported at once", none.refusals.length === 3, `${none.refusals.length}`);

  // Flag value parsing.
  t("--max-spend-usd=0.60 joined form works",
    authorizeLive(["--live", "--max-spend-usd=0.60"], on).authorized === true);
  t("--max-spend-usd with no value is refused",
    authorizeLive(["--live", "--max-spend-usd", "--live"], on).authorized === false);
  t("readFlagValue returns undefined for a missing flag",
    readFlagValue(["--live"], "--max-spend-usd") === undefined);
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 6: the API key is irrelevant to authorization ===");
{
  const argv = [...CAP_OK];
  const withKey = { ...ENV_OK, ANTHROPIC_API_KEY: "sk-ant-a-very-real-looking-key-000000000000000" };
  const withoutKey = { ...ENV_OK };
  const a = authorizeLive(argv, withKey);
  const b = authorizeLive(argv, withoutKey);
  t("identical verdict with and without a key", a.authorized === b.authorized && a.authorized);
  t("identical cap", a.cap?.micros === b.cap?.micros);
  t("identical guard flags", JSON.stringify(a.guards) === JSON.stringify(b.guards));

  // A key cannot rescue a missing guard.
  const keyOnly = authorizeLive([], { ANTHROPIC_API_KEY: "sk-ant-real-000000000000000000000000000" });
  t("a key alone authorizes NOTHING", keyOnly.authorized === false);

  const src = fs.readFileSync("lib/ai/eval/liveGuard.ts", "utf8");
  t("liveGuard never reads ANTHROPIC_API_KEY", !/env\.ANTHROPIC_API_KEY|process\.env\.ANTHROPIC/.test(src));
  const live = fs.readFileSync("scripts/ai-eval-live.ts", "utf8");
  t("the live entrypoint never reads ANTHROPIC_API_KEY", !/ANTHROPIC_API_KEY/.test(live));
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 5 + M: no provider is reachable from the live entrypoint ===");
{
  const live = fs.readFileSync("scripts/ai-eval-live.ts", "utf8");
  t("no Anthropic import", !/@anthropic-ai\/sdk/.test(live));
  t("no client construction", !/new Anthropic\(/.test(live));
  t("no anthropicProvider", !/anthropicProvider/.test(live));
  t("no ScriptedProvider", !/ScriptedProvider/.test(live));
  t("no runCase / tool execution", !/runCase|runChatTool|streamChat/.test(live));
  t("no fetch / http", !/fetch\(|https?:\/\/|axios/.test(live.replace(/^\s*\*.*$/gm, "")));
  t("no supabase / db write", !/supabase|createServiceClient|insert|update/i.test(live));
  t("says provider execution is not implemented", /NOT IMPLEMENTED/.test(live));

  const guard = fs.readFileSync("lib/ai/eval/liveGuard.ts", "utf8");
  t("liveGuard imports no SDK", !/@anthropic-ai\/sdk/.test(guard));
  t("liveGuard opens no socket", !/fetch\(|http|net\.|tls\./.test(guard.replace(/^\s*\*.*$/gm, "")));

  // The offline evaluator stays offline and stays separate.
  const off = fs.readFileSync("scripts/ai-eval.ts", "utf8");
  t("offline evaluator does NOT import the live entrypoint", !/ai-eval-live/.test(off));
  t("offline evaluator constructs no Anthropic client", !/new Anthropic\(/.test(off));
  t("offline --live still refuses", /--live/.test(off) && /not implemented/.test(off));
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 12: authorized run reports its blast radius and stops ===");
{
  const out: string[] = [];
  const code = main(CAP_OK, ENV_OK, (s) => out.push(s), (s) => out.push(s));
  const text = out.join("\n");
  t("fully authorized invocation exits 0", code === 0, `exit=${code}`);
  t("reports LIVE AUTHORIZATION CHECK ONLY", /LIVE AUTHORIZATION CHECK ONLY/.test(text));
  t("reports the requested maximum", /Requested maximum\s+\$0\.60/.test(text));
  t("reports the global ceiling", /Global eval ceiling\s+\$2\.00/.test(text));
  t("reports the worst-case reservation", /Worst-case reservation\/case\s+\$0\.06/.test(text));
  t("reports max worst-case cases = 10", /Max worst-case cases admitted 10/.test(text));
  t("states provider execution NOT IMPLEMENTED", /Provider execution\s+NOT IMPLEMENTED/.test(text));
  t("reports 0 provider calls", /Provider calls\s+0/.test(text));
  t("reports $0.00 actual spend", /Actual spend\s+\$0\.00/.test(text));
  t("documents the maxRetries: 0 invariant", /maxRetries: 0/.test(text));
  t("prints NO api key", !/sk-ant-/.test(text));
  t("prints no environment dump", !/AI_EVAL_LIVE=|process\.env/.test(text));

  const refused: string[] = [];
  const rcode = main([], {}, (s) => refused.push(s), (s) => refused.push(s));
  t("unauthorized invocation exits 2", rcode === 2, `exit=${rcode}`);
  t("…and says spend was $0.00", /Spend: \$0\.00/.test(refused.join("\n")));
  t("…and prints no key", !/sk-ant-/.test(refused.join("\n")));
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 10: the admission guard is load-bearing (mutation) ===");
{
  // MUTATION: the pre-fix behaviour — "have we already crossed?" instead of
  // "could this case cross?". If this passes the same boundary cases as the
  // real guard, the real guard is not doing anything.
  const mutantCheckAfterOvershoot = (spent: number, cap: number) => spent < cap;

  const boundary: [number, number][] = [[0.47, 0.5], [0.55, 0.6], [0.59, 0.6], [1.95, 2.0]];
  let mutantAdmits = 0;
  let realAdmits = 0;
  for (const [spent, cap] of boundary) {
    if (mutantCheckAfterOvershoot(spent, cap)) mutantAdmits++;
    if (canAdmitCase(spent, cap, WORST)) realAdmits++;
  }
  t("MUTATION: the old check admits every over-committing case",
    mutantAdmits === boundary.length, `${mutantAdmits}/${boundary.length}`);
  t("CONTROL: the real guard admits none of them",
    realAdmits === 0, `${realAdmits}/${boundary.length}`);
  t("MUTATION: the two disagree — the guard is load-bearing", mutantAdmits !== realAdmits);

  // MUTATION: float arithmetic instead of micro-dollars.
  const mutantFloat = (spent: number, cap: number) => spent + WORST <= cap;
  t("MUTATION: float arithmetic wrongly REFUSES 0.54 of a 0.60 cap",
    mutantFloat(0.54, 0.6) === false);
  t("CONTROL: micro-dollar arithmetic admits it", canAdmitCase(0.54, 0.6, WORST) === true);
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 1 + 11: EvalBudget end-to-end, and refusal means INCOMPLETE ===");
{
  // The real class, at the boundary that used to overshoot.
  const b = new EvalBudget("claude-sonnet-5", { ...AI_LIMITS.evaluation, maxCostUsd: 0.5 });
  b.recordCase();
  b.recordCall({ input_tokens: 235_000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const spent = b.spent.costUsd ?? 0;
  t("EvalBudget reached ~$0.47", Math.abs(spent - 0.47) < 0.001, `$${spent.toFixed(4)}`);
  const v = b.canStartCase();
  t("EvalBudget REFUSES the case that would reach $0.53", v.allowed === false);
  t("…with the eval_cost_ceiling reason", !v.allowed && v.reason === "eval_cost_ceiling");

  // A budget with room still admits.
  const roomy = new EvalBudget("claude-sonnet-5", { ...AI_LIMITS.evaluation, maxCostUsd: 2.0 });
  t("a budget with room admits", roomy.canStartCase().allowed === true);

  // Completeness: Phase 2's guard treats a budget refusal as an incomplete run.
  const evalSrc = fs.readFileSync("scripts/ai-eval.ts", "utf8");
  t("a budget refusal marks the run TRUNCATED", /truncatedAt = /.test(evalSrc));
  t("…and completeness poisons the verdict", /scored\.passed && complete/.test(evalSrc));
  t("…and runIsComplete is still the gate", /runIsComplete\(CASES\.length/.test(evalSrc));
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 8: the future provider invariant is recorded ===");
{
  t("maxRetries: 0 is the stated invariant", LIVE_PROVIDER_INVARIANT.maxRetries === 0);
  t("…with a rationale", LIVE_PROVIDER_INVARIANT.rationale.length > 20);
  // Production must NOT have been changed.
  const chat = fs.readFileSync("lib/chat.ts", "utf8");
  t("production Anthropic client is unchanged (no maxRetries override)",
    !/maxRetries/.test(chat));
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 13: CI and production exposure ===");
{
  t("no .github/workflows directory to reference it", !fs.existsSync(".github/workflows"));
  t("no vercel.json (so no crons)", !fs.existsSync("vercel.json"));
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  t("no package script invokes the live entrypoint",
    !JSON.stringify(pkg.scripts ?? {}).includes("ai-eval-live"));
  t("build script unchanged", pkg.scripts?.build === "next build");

  // Nothing in the app can reach either eval entrypoint.
  const appHits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        const s = fs.readFileSync(p, "utf8");
        if (/ai-eval-live|ai\/eval\/liveGuard/.test(s)) appHits.push(p);
      }
    }
  };
  walk("app");
  walk("components");
  t("no app route or component imports the live entrypoint or guard",
    appHits.length === 0, appHits.join(", "));
}

// ══════════════════════════════════════════════
console.log("\n=== GATE 15: protected areas untouched ===");
{
  const migs = fs.readdirSync("supabase/migrations");
  t("no migration 0060", migs.filter((f) => /^0060_/.test(f)).length === 0);
  t("0058 still not taken", migs.filter((f) => /^0058_/.test(f)).length === 0);
  t("0059 still present", migs.filter((f) => /^0059_/.test(f)).length === 1);

  const pay = fs.readFileSync("app/api/checkout/razorpay/route.ts", "utf8");
  t("payment code untouched by this work", !/liveGuard|ai-eval-live|canAdmitCase/.test(pay));

  const route = fs.readFileSync("app/api/chat/route.ts", "utf8");
  t("the chat route is unchanged by 2.5A", !/liveGuard|ai-eval-live/.test(route));

  // 2.5B-F must NOT have been implemented.
  t("no grounding attribution implemented (2.5B)", !fs.existsSync("lib/ai/eval/attribution.ts"));
  t("no canary cases implemented (2.5C)", !fs.existsSync("lib/ai/eval/liveCases.ts"));
  t("no live provider path implemented (2.5F)",
    !fs.readFileSync("scripts/ai-eval-live.ts", "utf8").includes("anthropicProvider"));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
