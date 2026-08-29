/**
 * Cost controls: request ceilings, daily guard, eval budget, fail-closed quota.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/ai-budget.test.ts
 *
 * WHAT THIS IS DEFENDING. A spend ceiling fails in one direction that matters:
 * it lets something through. Every "unknown" in this system — an unpriced
 * model, a usage block that will not parse, a daily counter that cannot be read
 * — is a place where a naive implementation substitutes zero and the ceiling
 * silently stops existing. Most of the assertions below are about those, and
 * about the one that is easiest to get wrong: that no FURTHER model call
 * happens once a ceiling is reached.
 *
 * The loop assertions drive the real streamChat against a fake model, counting
 * how many times the model was actually invoked.
 */
import fs from "node:fs";
import Module from "node:module";

const require_ = Module.createRequire(import.meta.url);

process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-for-a-fake-client-0000000000000000";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const i = s.indexOf("=");
  const k = s.slice(0, i).trim();
  if (k === "ANTHROPIC_API_KEY") continue;
  process.env[k] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

interface Scripted {
  text: string;
  tool?: { name: string; input: Record<string, unknown> };
  usage?: unknown;
}

/** Returns a counter so a test can assert how many calls the model actually saw. */
function installFakeModel(script: Scripted[]): { calls: number } {
  const { Messages } = require_("@anthropic-ai/sdk/resources/messages/messages.js");
  const counter = { calls: 0 };

  Messages.prototype.stream = function () {
    const turn = script[counter.calls] ?? { text: "…" };
    counter.calls++;
    const content: Record<string, unknown>[] = [{ type: "text", text: turn.text }];
    if (turn.tool) {
      content.push({ type: "tool_use", id: `t${counter.calls}`, name: turn.tool.name, input: turn.tool.input });
    }
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: turn.text } };
      },
      async finalMessage() {
        return {
          role: "assistant",
          content,
          stop_reason: turn.tool ? "tool_use" : "end_turn",
          usage:
            turn.usage === undefined
              ? { input_tokens: 1000, output_tokens: 50 }
              : turn.usage,
        };
      },
    };
  };
  return counter;
}

async function drain(gen: AsyncGenerator<string, void, void>): Promise<string> {
  let out = "";
  for await (const d of gen) out += d;
  return out;
}

const MODEL = "claude-sonnet-5";

async function main() {
  const budgetMod = await import("../lib/ai/budget");
  const limitsMod = await import("../lib/ai/limits");
  const obs = await import("../lib/ai/observability");
  const { RequestBudget, EvalBudget, reserveDailyBudget, isUsableUsage, chargeableUsage } = budgetMod;

  // ══ Config ══════════════════════════════════
  console.log("\n=== configuration ===");
  {
    const L = limitsMod.AI_LIMITS;
    t("production and evaluation budgets are separate", L.request !== (L.evaluation as never));
    t("a per-request cost ceiling exists", L.request.maxCostUsd > 0);
    t("a per-request token ceiling exists", L.request.maxTokens > 0);
    t("a daily ceiling exists", L.daily.maxCostUsd > 0);
    t("daily budget fails CLOSED by default", L.daily.failOpen === false);
    t(
      "the per-request call cap does not undercut the loop's own maximum",
      L.request.maxModelCalls >= 5,
      "MAX_TOOL_ROUNDS=4 → 5 calls; the loop stays authoritative"
    );
    t("assumed-usage figures are non-zero", L.request.assumedInputTokensOnUnreadableUsage > 0 && L.request.assumedOutputTokensOnUnreadableUsage > 0);

    // Strict env validation.
    process.env.AI_DAILY_BUDGET_USD = "ten dollars";
    process.env.AI_BUDGET_FAIL_OPEN = "yes";
    process.env.AI_MAX_TOKENS_PER_REQUEST = "-5";
    const reloaded = limitsMod.loadLimits();
    t("a non-numeric ceiling falls back to the default, not NaN", Number.isFinite(reloaded.daily.maxCostUsd) && reloaded.daily.maxCostUsd === 5);
    t('fail-open only honours the literal "true" — "yes" is refused', reloaded.daily.failOpen === false);
    t("a negative ceiling is refused", reloaded.request.maxTokens === 60_000);
    process.env.AI_BUDGET_FAIL_OPEN = "true";
    t('but "true" exactly does open it', limitsMod.loadLimits().daily.failOpen === true);
    delete process.env.AI_DAILY_BUDGET_USD;
    delete process.env.AI_BUDGET_FAIL_OPEN;
    delete process.env.AI_MAX_TOKENS_PER_REQUEST;
    // Check the env names actually READ, not the prose. The first version of
    // this assertion grepped the whole file and tripped on its own "NO SECRETS"
    // heading — a comment saying the right thing is not evidence of it.
    const limitsSrc = fs.readFileSync("lib/ai/limits.ts", "utf8");
    const envNames = [...limitsSrc.matchAll(/(?:num|int|strictTrue)\("([A-Z0-9_]+)"/g)].map((m) => m[1]);
    t("the limits module reads at least one env var", envNames.length > 0, `${envNames.length}`);
    t("every env var it reads is an AI_ limit", envNames.every((n) => n.startsWith("AI_")), envNames.join(","));
    t(
      "none of them is a credential",
      envNames.every((n) => !/KEY|SECRET|PASSWORD|TOKEN$/.test(n)),
      envNames.join(",")
    );
  }

  // ══ Usage plausibility ══════════════════════
  console.log("\n=== malformed usage cannot buy a free call ===");
  {
    t("a real usage block is usable", isUsableUsage({ input_tokens: 10, output_tokens: 5 }));
    t("zero output tokens is NOT plausible for a completed call", !isUsableUsage({ input_tokens: 10, output_tokens: 0 }));
    t("a missing usage object is unusable", !isUsableUsage(undefined));
    t("null is unusable", !isUsableUsage(null));
    t("a string output count is unusable", !isUsableUsage({ output_tokens: "50" }));
    t("an empty object is unusable", !isUsableUsage({}));

    const L = limitsMod.AI_LIMITS.request;
    const bad = chargeableUsage({ output_tokens: "nonsense" }, L);
    t("an unreadable block is flagged as assumed", bad.assumed === true);
    t(
      "…and charged the conservative estimate, NOT zero",
      bad.usage.outputTokens === L.assumedOutputTokensOnUnreadableUsage &&
        bad.usage.inputTokens === L.assumedInputTokensOnUnreadableUsage
    );
    const good = chargeableUsage({ input_tokens: 7, output_tokens: 3 }, L);
    t("a good block is charged as reported", good.assumed === false && good.usage.inputTokens === 7);
  }

  // ══ Request budget ══════════════════════════
  console.log("\n=== request budget ===");
  {
    const b = new RequestBudget(MODEL, { ...limitsMod.AI_LIMITS.request });
    t("a fresh budget permits the first call", b.checkBeforeCall().allowed);
    b.recordCall({ input_tokens: 1000, output_tokens: 50 });
    t("and still permits the second, well under the ceiling", b.checkBeforeCall().allowed);
    t("spend is tracked", b.spent.calls === 1 && b.spent.tokens === 1050);
    t("cost is computed", b.spent.costUsd === (1000 / 1e6) * 2 + (50 / 1e6) * 10);
  }

  {
    const b = new RequestBudget(MODEL, { ...limitsMod.AI_LIMITS.request, maxModelCalls: 2 });
    b.recordCall({ input_tokens: 10, output_tokens: 10 });
    b.recordCall({ input_tokens: 10, output_tokens: 10 });
    const v = b.checkBeforeCall();
    t("the call ceiling stops the next call", !v.allowed);
    t("with the right reason", !v.allowed && v.reason === "request_call_ceiling", !v.allowed ? v.reason : "");
  }

  {
    const b = new RequestBudget(MODEL, { ...limitsMod.AI_LIMITS.request, maxTokens: 100 });
    b.recordCall({ input_tokens: 90, output_tokens: 20 });
    const v = b.checkBeforeCall();
    t("the token ceiling stops the next call", !v.allowed && v.reason === "request_token_ceiling", !v.allowed ? v.reason : "");
  }

  {
    // The token ceiling is raised out of the way so the COST ceiling is
    // unambiguously the thing that binds — otherwise this passes for the wrong
    // reason, which is how a broken cost guard hides behind a working token one.
    const b = new RequestBudget(MODEL, {
      ...limitsMod.AI_LIMITS.request,
      maxCostUsd: 0.001,
      maxTokens: 10_000_000,
    });
    b.recordCall({ input_tokens: 500_000, output_tokens: 1000 });
    const v = b.checkBeforeCall();
    t("the cost ceiling stops the next call", !v.allowed && v.reason === "request_cost_ceiling", !v.allowed ? v.reason : "");
    t("…and it was cost, not tokens, that bound", b.spent.tokens < 10_000_000);
  }

  {
    const b = new RequestBudget("claude-not-a-real-model", { ...limitsMod.AI_LIMITS.request });
    const v = b.checkBeforeCall();
    t("an UNPRICED model is refused outright", !v.allowed, "unknown cost is not zero cost");
    t("with reason pricing_unknown", !v.allowed && v.reason === "pricing_unknown", !v.allowed ? v.reason : "");
  }

  {
    // The bypass this closes: a provider returning junk usage forever.
    const b = new RequestBudget(MODEL, { ...limitsMod.AI_LIMITS.request, maxTokens: 20_000 });
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (!b.checkBeforeCall().allowed) break;
      allowed++;
      b.recordCall({ garbage: true });
    }
    t(
      "malformed usage still trips the token ceiling",
      allowed < 10,
      `${allowed} calls allowed before the ceiling bound`
    );
    t("and the assumed charges were counted", b.spent.assumedCalls === allowed, `${b.spent.assumedCalls}`);
  }

  {
    const b = new RequestBudget(MODEL, { ...limitsMod.AI_LIMITS.request, maxModelCalls: 1 });
    b.recordCall({ input_tokens: 1, output_tokens: 1 });
    b.checkBeforeCall();
    const again = b.checkBeforeCall();
    t("once stopped, a budget stays stopped", !again.allowed);
    t("and reports the original reason", !again.allowed && again.reason === "request_call_ceiling");
  }

  // ══ Daily budget ════════════════════════════
  console.log("\n=== daily budget ===");
  {
    const closed = { maxCostUsd: 5, failOpen: false };
    const open = { maxCostUsd: 5, failOpen: true };

    const noop = async () => true;

    const none = await reserveDailyBudget(0.06, null, closed);
    t("no store → DENIED (fail closed)", !none.allowed);
    t("with reason budget_state_unavailable", !none.allowed && none.reason === "budget_state_unavailable", !none.allowed ? none.reason : "");
    t(
      "the reason explains why chat_usage was not reused",
      budgetMod.NO_DAILY_STORE_REASON.includes("0019") && budgetMod.NO_DAILY_STORE_REASON.includes("cleanup")
    );

    const openVerdict = await reserveDailyBudget(0.06, null, open);
    t("no store + explicit fail-open → allowed", openVerdict.allowed);
    t("…with nothing to settle", openVerdict.allowed && openVerdict.reservation === null);

    const under = await reserveDailyBudget(
      0.06,
      { reserve: async () => ({ allowed: true, reservationId: "r1", committedUsd: 1 }), finalize: noop },
      closed
    );
    t("under the daily cap → allowed", under.allowed);
    t("…and carries a reservation to settle", under.allowed && under.reservation?.id === "r1");

    const over = await reserveDailyBudget(
      0.06,
      { reserve: async () => ({ allowed: false, committedUsd: 5 }), finalize: noop },
      closed
    );
    t("at the daily cap → denied", !over.allowed && over.reason === "daily_ceiling", !over.allowed ? over.reason : "");

    const nullish = await reserveDailyBudget(0.06, { reserve: async () => null, finalize: noop }, closed);
    t("a store that cannot answer → denied, not assumed-allowed", !nullish.allowed && nullish.reason === "budget_state_unavailable");

    const throws = await reserveDailyBudget(
      0.06,
      { reserve: async () => { throw new Error("db down"); }, finalize: noop },
      closed
    );
    t("a throwing store → denied", !throws.allowed && throws.reason === "budget_state_unavailable");
    t(
      "a throwing store + fail-open → allowed",
      (await reserveDailyBudget(0.06, { reserve: async () => { throw new Error("x"); }, finalize: noop }, open)).allowed
    );

    const nan = await reserveDailyBudget(NaN, { reserve: async () => ({ allowed: true, reservationId: "x" }), finalize: noop }, closed);
    t("a NaN reservation amount → denied before it reaches the store", !nan.allowed, "the classic silent-bypass shape");

    const idless = await reserveDailyBudget(0.06, { reserve: async () => ({ allowed: true }), finalize: noop }, closed);
    t("allowed with no reservation id → denied, to avoid a leaked hold", !idless.allowed);
  }

  // ══ Eval budget ═════════════════════════════
  console.log("\n=== eval budget ===");
  {
    const e = new EvalBudget(MODEL, { maxCases: 3, maxModelCalls: 100, maxTokens: 1e6, maxCostUsd: 10 });
    let ran = 0;
    for (let i = 0; i < 50; i++) {
      if (!e.canStartCase().allowed) break;
      e.recordCase();
      e.recordCall({ input_tokens: 100, output_tokens: 10 });
      ran++;
    }
    t("the case ceiling stops the run cleanly", ran === 3, `${ran} cases ran`);
    t("with the right reason", e.spent.stopReason === "eval_case_ceiling", `${e.spent.stopReason}`);
  }

  {
    const e = new EvalBudget(MODEL, { maxCases: 1000, maxModelCalls: 4, maxTokens: 1e6, maxCostUsd: 10 });
    let ran = 0;
    for (let i = 0; i < 50; i++) {
      if (!e.canStartCase().allowed) break;
      e.recordCase();
      e.recordCall({ input_tokens: 10, output_tokens: 10 });
      ran++;
    }
    t("the model-call ceiling stops the run", ran === 4 && e.spent.stopReason === "eval_call_ceiling", `${ran}, ${e.spent.stopReason}`);
  }

  {
    const e = new EvalBudget(MODEL, { maxCases: 1000, maxModelCalls: 1e6, maxTokens: 500, maxCostUsd: 10 });
    let ran = 0;
    for (let i = 0; i < 50; i++) {
      if (!e.canStartCase().allowed) break;
      e.recordCase();
      e.recordCall({ input_tokens: 200, output_tokens: 10 });
      ran++;
    }
    t("the token ceiling stops the run", e.spent.stopReason === "eval_token_ceiling", `${ran} cases, ${e.spent.stopReason}`);
  }

  {
    const e = new EvalBudget(MODEL, { maxCases: 1000, maxModelCalls: 1e6, maxTokens: 1e9, maxCostUsd: 0.01 });
    let ran = 0;
    for (let i = 0; i < 500; i++) {
      if (!e.canStartCase().allowed) break;
      e.recordCase();
      e.recordCall({ input_tokens: 100_000, output_tokens: 1000 });
      ran++;
    }
    t("the USD ceiling stops the run", e.spent.stopReason === "eval_cost_ceiling", `${ran} cases, $${e.spent.costUsd}`);
    t("and it stopped BELOW a runaway count", ran < 500, `${ran}`);
  }

  {
    const e = new EvalBudget("claude-not-a-real-model", limitsMod.AI_LIMITS.evaluation);
    t("an unpriced model refuses to start an eval run at all", !e.canStartCase().allowed);
  }

  // ══ Loop integration ════════════════════════
  console.log("\n=== the loop honours the budget ===");
  {
    const counter = installFakeModel([
      { text: "a", tool: { name: "search_products", input: { query: "x" } } },
      { text: "b", tool: { name: "search_products", input: { query: "y" } } },
      { text: "c", tool: { name: "search_products", input: { query: "z" } } },
      { text: "d" },
    ]);
    const { streamChat } = await import("../lib/chat");
    const budget = new RequestBudget(MODEL, { ...limitsMod.AI_LIMITS.request, maxModelCalls: 2 });
    let stopReason: string | null = null;

    const out = await drain(
      streamChat([{ role: "user", content: "hi" }], {
        budget,
        onBudgetStop: (r) => (stopReason = r),
      })
    );

    t("NO further model call after the ceiling", counter.calls === 2, `${counter.calls} model calls made`);
    t("the loop reported the stop", stopReason === "request_call_ceiling", `${stopReason}`);
    t("the partial answer already streamed is kept", out.startsWith("ab"), JSON.stringify(out));
    t("no fallback line was appended over a partial answer", !out.includes("WhatsApp"), JSON.stringify(out));
  }

  {
    // Stopped before the very first token: the customer must see something.
    const counter = installFakeModel([{ text: "never reached" }]);
    const { streamChat } = await import("../lib/chat");
    const budget = new RequestBudget("claude-not-a-real-model", limitsMod.AI_LIMITS.request);
    let stopReason: string | null = null;
    const out = await drain(
      streamChat([{ role: "user", content: "hi" }], { budget, onBudgetStop: (r) => (stopReason = r) })
    );

    t("no model call was made at all", counter.calls === 0, `${counter.calls}`);
    t("the stop was reported", stopReason === "pricing_unknown", `${stopReason}`);
    t("the customer gets a safe fallback rather than silence", out.length > 0);
    t("…which offers WhatsApp, as every other failure path does", out.includes("WhatsApp"));
    for (const leak of ["budget", "ceiling", "cost", "token", "$", "pricing", "USD"]) {
      t(`the fallback does not mention "${leak}"`, !out.toLowerCase().includes(leak.toLowerCase()));
    }
  }

  {
    // No budget supplied — the WhatsApp shape. Nothing may change.
    const counter = installFakeModel([
      { text: "a", tool: { name: "search_products", input: { query: "x" } } },
      { text: "b" },
    ]);
    const { streamChat } = await import("../lib/chat");
    const out = await drain(streamChat([{ role: "user", content: "hi" }], {}));
    t("with no budget the loop runs unchanged", counter.calls === 2, `${counter.calls}`);
    t("and the answer is whole", out === "ab", JSON.stringify(out));
  }

  // ══ Observability ═══════════════════════════
  console.log("\n=== a budget stop is recorded ===");
  {
    t("the taxonomy has a request-budget outcome", (obs.TRACE_OUTCOMES as readonly string[]).includes("request_budget_exceeded"));
    t("…a daily one", (obs.TRACE_OUTCOMES as readonly string[]).includes("daily_budget_exceeded"));
    t("…and an unavailable one", (obs.TRACE_OUTCOMES as readonly string[]).includes("budget_unavailable"));
    t("a cost ceiling maps to request_budget_exceeded", obs.outcomeForBudgetStop("request_cost_ceiling") === "request_budget_exceeded");
    t("a daily ceiling maps to daily_budget_exceeded", obs.outcomeForBudgetStop("daily_ceiling") === "daily_budget_exceeded");
    t("unreadable state maps to budget_unavailable", obs.outcomeForBudgetStop("budget_state_unavailable") === "budget_unavailable");
    t("unknown pricing maps to budget_unavailable, not a ceiling", obs.outcomeForBudgetStop("pricing_unknown") === "budget_unavailable");
    t(
      "a hit ceiling and an unreadable budget are NOT the same outcome",
      obs.outcomeForBudgetStop("daily_ceiling") !== obs.outcomeForBudgetStop("budget_state_unavailable")
    );

    const counter = installFakeModel([
      { text: "a", tool: { name: "search_products", input: { query: "x" } } },
      { text: "b" },
    ]);
    void counter;
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: MODEL, emit: (x) => emitted.push(x) });
    const budget = new RequestBudget(MODEL, { ...limitsMod.AI_LIMITS.request, maxModelCalls: 1 });
    let stop: string | null = null;
    await drain(streamChat([{ role: "user", content: "hi" }], { recorder: rec, budget, onBudgetStop: (r) => (stop = r) }));
    rec.finish(obs.outcomeForBudgetStop(stop ?? ""));
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;
    t("the trace records the budget stop", tr.outcome === "request_budget_exceeded", tr.outcome);
    t("and still carries the tokens actually spent", tr.total_tokens > 0, `${tr.total_tokens}`);
  }

  // ══ Fail-closed quota ═══════════════════════
  console.log("\n=== chat quota fails closed ===");
  {
    const src = fs.readFileSync("lib/chatQuota.ts", "utf8");
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    t("no failure path returns allowed: true", !/allowed:\s*true/.test(bare), "only the RPC's own verdict may allow");
    t("the error branch denies", /error\)\s*\{[\s\S]{0,200}allowed:\s*false/.test(bare));
    t("the catch branch denies", /catch[\s\S]{0,220}allowed:\s*false/.test(bare));
    t(
      "quotaMessage(null) is a customer-safe line",
      (await import("../lib/chatQuota")).quotaMessage(null).includes("WhatsApp")
    );
    t(
      "…that does not mention a database",
      !/database|db|supabase|error/i.test((await import("../lib/chatQuota")).quotaMessage(null))
    );

    // Blast radius: this limiter is Ask Wovenne's alone.
    const callers = ["app", "lib", "components"]
      .flatMap((d) => listFiles(d))
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => f !== "lib/chatQuota.ts")
      .filter((f) => fs.readFileSync(f, "utf8").includes("consumeChatQuota"));
    t(
      "consumeChatQuota has exactly one caller, so failing closed is local",
      callers.length === 1 && callers[0] === "app/api/chat/route.ts",
      callers.join(", ")
    );
  }

  // ══ Untouched ═══════════════════════════════
  console.log("\n=== nothing else changed ===");
  {
    const tools = fs.readFileSync("lib/chatTools.ts", "utf8");
    const bare = tools.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    t("no service client in the tool file", !bare.includes("createServiceClient"));
    t("no writer in the tool file", !/\.(insert|update|upsert|delete)\s*\(/.test(bare));
    t(
      "the tool list is unchanged",
      (await import("../lib/chatTools")).CHAT_TOOL_NAMES.join(",") ===
        "search_products,get_product_details,check_availability,search_brand_knowledge"
    );

    const chat = fs.readFileSync("lib/chat.ts", "utf8");
    t("MAX_TOOL_ROUNDS is unchanged", /MAX_TOOL_ROUNDS = 4/.test(chat));
    t("the model is unchanged", /CHAT_MODEL = "claude-sonnet-5"/.test(chat));
    t("the privileged tool is still session-gated", /MY_ORDER_TOOL\.name && Boolean\(opts\.email\)/.test(chat));

    const wa = fs.readFileSync("app/api/whatsapp/webhook/route.ts", "utf8");
    t("the WhatsApp path passes no budget", !/budget/.test(wa));
    t("the WhatsApp path passes no recorder", !/recorder/.test(wa));
    t("the WhatsApp path still calls the shared loop", /streamChat\(parsed\.messages\)/.test(wa));

    // 0059 exists as of Phase 1.6 and is approved. 0058 must still not — it
    // belongs to parked PR #117 and a collision there turns a rebase into an
    // untangle.
    const migs = listFiles("supabase/migrations");
    t("0058 is still not taken on main", migs.filter((f) => /\/0058_/.test(f)).length === 0);
    t("0059 is the AI daily spend migration", migs.filter((f) => /\/0059_ai_daily_spend\.sql$/.test(f)).length === 1);
    t("no migration beyond 0059 was created", migs.filter((f) => /\/00[6-9]\d_/.test(f)).length === 0);

    const pay = fs.readFileSync("app/api/checkout/razorpay/route.ts", "utf8");
    t("payment code is untouched by this work", !/ai\/budget|ai\/limits|ai\/observability/.test(pay));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
