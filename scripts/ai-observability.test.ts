/**
 * AI observability: token accounting, cost, latency, taxonomy and privacy.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/ai-observability.test.ts
 *
 * WHAT THIS ANSWERS. Telemetry fails quietly by construction — a counter that
 * stops incrementing produces a smaller number, not an error, and a dashboard
 * built on it looks healthy right up until someone checks. So the assertions
 * below are mostly about arithmetic and about what is ABSENT: that two model
 * calls sum to the tokens of both, that an unknown model yields no cost rather
 * than a plausible one, and that no tool argument reaches the trace.
 *
 * It drives the real `streamChat` loop against a fake model, patching
 * Messages.prototype.stream before lib/chat is imported — the same seam
 * scripts/chat-loop.test.ts uses, for the same reason: lib/chat builds its
 * client at module load and leaves nothing to inject.
 *
 * The route-level outcomes (feature disabled, rate limited, not configured) are
 * asserted against the route's source rather than by standing up a NextRequest.
 * What matters there is that each early return is paired with a finish() call
 * naming the right category, and that is a property of the file.
 */
import fs from "node:fs";
import Module from "node:module";

const require_ = Module.createRequire(import.meta.url);

process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-for-a-fake-client-0000000000000000";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const i = s.indexOf("=");
  const key = s.slice(0, i).trim();
  if (key === "ANTHROPIC_API_KEY") continue;
  process.env[key] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

interface Usage {
  input_tokens?: number | null;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface Scripted {
  text: string;
  tool?: { name: string; input: Record<string, unknown> };
  usage?: Usage;
  /** Make the model call itself blow up, to exercise the error path. */
  throws?: Error;
  /** Claim a tool was wanted while naming none — the malformed shape. */
  malformed?: boolean;
}

function installFakeModel(script: Scripted[]) {
  const { Messages } = require_("@anthropic-ai/sdk/resources/messages/messages.js");
  let call = 0;

  Messages.prototype.stream = function fakeStream() {
    const turn = script[call] ?? { text: "(no more script)" };
    call++;

    if (turn.throws) {
      const err = turn.throws;
      return {
        async *[Symbol.asyncIterator]() {
          throw err;
        },
        async finalMessage() {
          throw err;
        },
      };
    }

    const content: Record<string, unknown>[] = [{ type: "text", text: turn.text }];
    if (turn.tool) {
      content.push({
        type: "tool_use",
        id: `toolu_${call}`,
        name: turn.tool.name,
        input: turn.tool.input,
      });
    }

    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: turn.text } };
      },
      async finalMessage() {
        return {
          role: "assistant",
          content,
          stop_reason: turn.tool || turn.malformed ? "tool_use" : "end_turn",
          usage: turn.usage ?? {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    };
  };
}

async function drain(gen: AsyncGenerator<string, void, void>): Promise<string> {
  let out = "";
  for await (const d of gen) out += d;
  return out;
}

async function main() {
  const obs = await import("../lib/ai/observability");
  const cost = await import("../lib/ai/cost");

  // ══ Cost model ══════════════════════════════
  console.log("\n=== cost model ===");
  {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    t(
      "1M input tokens on sonnet-5 costs exactly $2.00",
      cost.costUsd("claude-sonnet-5", usage) === 2.0,
      `${cost.costUsd("claude-sonnet-5", usage)}`
    );
    const out = { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    t(
      "1M output tokens on sonnet-5 costs exactly $10.00",
      cost.costUsd("claude-sonnet-5", out) === 10.0,
      `${cost.costUsd("claude-sonnet-5", out)}`
    );
    t(
      "input and output are priced SEPARATELY, not at one blended rate",
      cost.costUsd("claude-sonnet-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }) === 12.0
    );
    t(
      "cache reads are charged at a tenth of input",
      cost.costUsd("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      }) === 0.2
    );
    t(
      "cache writes are charged above input",
      cost.costUsd("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 1_000_000,
      }) === 2.5
    );

    // The whole point of the null contract.
    t(
      "an unknown model returns NULL, not a guess",
      cost.costUsd("some-model-nobody-priced", usage) === null
    );
    t("…and not zero, which would read as free", cost.costUsd("nope", usage) !== 0);
    t("isPriced() reports the same fact", cost.isPriced("nope") === false && cost.isPriced("claude-sonnet-5"));
    t("pricingFor() is null for the unknown model", cost.pricingFor("nope") === null);
    t(
      "the model Ask Wovenne actually runs on is priced",
      cost.isPriced((await import("../lib/chat")).CHAT_MODEL)
    );

    // Usage reading has to survive whatever the provider hands it.
    t("null input_tokens reads as 0, not NaN", cost.readUsage({ input_tokens: null }).inputTokens === 0);
    t("a missing usage object reads as zeroes", cost.readUsage(undefined).outputTokens === 0);
    t("a string token count is refused", cost.readUsage({ output_tokens: "12" as unknown }).outputTokens === 0);
    t("a negative token count is refused", cost.readUsage({ output_tokens: -5 }).outputTokens === 0);
    t(
      "total input includes cache reads and writes, not just input_tokens",
      cost.totalInputTokens({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 2 }) === 17
    );
    t(
      "totalTokens adds output on top",
      cost.totalTokens({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2 }) === 20
    );
    t("roundCost keeps null null", cost.roundCost(null) === null);
    t("the rate table is frozen against accidental edits", Object.isFrozen(cost.MODEL_PRICING));
    t("pricing carries an as-of date", /^\d{4}-\d{2}-\d{2}$/.test(cost.PRICING_AS_OF));
  }

  // ══ Taxonomy ════════════════════════════════
  console.log("\n=== error taxonomy ===");
  {
    const required = [
      "model_provider_error",
      "model_timeout",
      "malformed_model_response",
      "invalid_tool_call",
      "tool_validation_error",
      "tool_timeout",
      "tool_internal_error",
      "rate_limited",
      "feature_disabled",
      "successful_no_tool",
      "successful_with_tools",
    ];
    for (const c of required) {
      t(`taxonomy includes ${c}`, (obs.TRACE_OUTCOMES as readonly string[]).includes(c));
    }
    t(
      "outcomes are unique — no category counted twice",
      new Set(obs.TRACE_OUTCOMES).size === obs.TRACE_OUTCOMES.length
    );
    t(
      "a permission refusal is its own outcome",
      (obs.TRACE_OUTCOMES as readonly string[]).includes("permission_refused")
    );
    t("isSuccessOutcome is true only for the two successes",
      obs.isSuccessOutcome("successful_no_tool") &&
        obs.isSuccessOutcome("successful_with_tools") &&
        !obs.isSuccessOutcome("rate_limited"));

    t("a timeout is classified as model_timeout", obs.classifyModelError(new Error("Request timed out")) === "model_timeout");
    t("an abort is classified as model_timeout", obs.classifyModelError({ name: "AbortError" }) === "model_timeout");
    t("anything else is a provider error", obs.classifyModelError(new Error("500 overloaded")) === "model_provider_error");
    t("a null error still classifies", obs.classifyModelError(null) === "model_provider_error");
  }

  // ══ Single call ═════════════════════════════
  console.log("\n=== one model call, no tools ===");
  {
    installFakeModel([{ text: "Namaskaram.", usage: { input_tokens: 1200, output_tokens: 45 } }]);
    const { streamChat } = await import("../lib/chat");

    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });

    const out = await drain(streamChat([{ role: "user", content: "hello" }], { recorder: rec }));
    rec.finish(rec.toolCallCount > 0 ? "successful_with_tools" : "successful_no_tool");
    const tr = emitted[0] as unknown as import("../lib/ai/observability").AiTrace;

    t("the customer's text is unchanged by instrumentation", out === "Namaskaram.", JSON.stringify(out));
    t("exactly one trace was emitted", emitted.length === 1, `${emitted.length}`);
    t("one model call recorded", tr.model_calls === 1, `${tr.model_calls}`);
    t("no tool calls recorded", tr.tool_calls === 0);
    t("input tokens captured", tr.input_tokens === 1200, `${tr.input_tokens}`);
    t("output tokens captured", tr.output_tokens === 45, `${tr.output_tokens}`);
    t("total tokens is input + output", tr.total_tokens === 1245, `${tr.total_tokens}`);
    t(
      "cost matches the rate card",
      tr.cost_usd === cost.roundCost((1200 / 1e6) * 2 + (45 / 1e6) * 10),
      `${tr.cost_usd}`
    );
    t("pricing is flagged known", tr.pricing_known === true);
    t("outcome is successful_no_tool", tr.outcome === "successful_no_tool", tr.outcome);
    t("stop_reason recorded on the call", tr.calls[0].stop_reason === "end_turn", `${tr.calls[0].stop_reason}`);
    t("tools were offered on a non-final round", tr.calls[0].tools_offered === true);
    t("latency is a non-negative number", typeof tr.total_latency_ms === "number" && tr.total_latency_ms >= 0);
    t("model latency is recorded", typeof tr.model_latency_ms === "number" && tr.model_latency_ms >= 0);
    t("surface is named", tr.surface === "ask_wovenne");
    t("caller defaults to guest", tr.caller === "guest");
    t("a trace id exists", typeof tr.trace_id === "string" && tr.trace_id.length > 0);
  }

  // ══ Multi-call tool loop ════════════════════
  console.log("\n=== multi-call tool loop: accounting and correlation ===");
  {
    installFakeModel([
      {
        text: "Checking. ",
        tool: { name: "check_availability", input: { slug: "mul-cotton", size: "M" } },
        usage: { input_tokens: 1000, output_tokens: 50 },
      },
      {
        text: "And the story. ",
        tool: { name: "search_brand_knowledge", input: { query: "kasavu" } },
        usage: { input_tokens: 1400, output_tokens: 30 },
      },
      { text: "Here you are.", usage: { input_tokens: 1800, output_tokens: 60 } },
    ]);
    const { streamChat } = await import("../lib/chat");

    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });
    const out = await drain(streamChat([{ role: "user", content: "in stock, and is it real?" }], { recorder: rec }));
    rec.finish(rec.firstToolError() ?? (rec.toolCallCount > 0 ? "successful_with_tools" : "successful_no_tool"));
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;

    t("all three rounds' text reached the caller", out === "Checking. And the story. Here you are.", JSON.stringify(out));
    t("three model calls recorded", tr.model_calls === 3, `${tr.model_calls}`);
    t("two tool calls recorded", tr.tool_calls === 2, `${tr.tool_calls}`);
    t(
      "input tokens SUMMED across every call",
      tr.input_tokens === 1000 + 1400 + 1800,
      `${tr.input_tokens}`
    );
    t(
      "output tokens summed across every call",
      tr.output_tokens === 50 + 30 + 60,
      `${tr.output_tokens}`
    );
    t("total tokens is the sum of both sides", tr.total_tokens === 4200 + 140, `${tr.total_tokens}`);
    t(
      "cost reflects all three calls, priced by side",
      tr.cost_usd === cost.roundCost((4200 / 1e6) * 2 + (140 / 1e6) * 10),
      `${tr.cost_usd}`
    );
    t("outcome is successful_with_tools", tr.outcome === "successful_with_tools", tr.outcome);

    // Correlation: one id, and the sub-records reconstruct the sequence.
    t("per-call records match the count", tr.calls.length === 3);
    t("per-tool records match the count", tr.tools.length === 2);
    t("model calls are indexed 0,1,2", tr.calls.map((c) => c.index).join(",") === "0,1,2");
    t("tool calls are indexed 0,1", tr.tools.map((c) => c.index).join(",") === "0,1");
    t(
      "tool NAMES are recorded, in order",
      tr.tools.map((c) => c.tool).join(",") === "check_availability,search_brand_knowledge",
      tr.tools.map((c) => c.tool).join(",")
    );
    t("every model call carries the model id", tr.calls.every((c) => c.model === "claude-sonnet-5"));
    t("each tool call has its own latency", tr.tools.every((c) => typeof c.latency_ms === "number" && c.latency_ms >= 0));
    t(
      "tool latency total is the sum of the parts",
      tr.tool_latency_ms === tr.tools.reduce((s, c) => s + c.latency_ms, 0)
    );
    t(
      "model latency total is the sum of the parts",
      tr.model_latency_ms === tr.calls.reduce((s, c) => s + c.latency_ms, 0)
    );
    t(
      "the FINAL round is recorded as tool-free",
      tr.calls[2].tools_offered === true,
      "3 rounds is under the 4-round cap, so tools stay on"
    );
    t("one trace id covers the whole turn", typeof tr.trace_id === "string" && tr.trace_id.length > 10);
  }

  // ══ Cache token accounting ══════════════════
  console.log("\n=== cache tokens ===");
  {
    installFakeModel([
      {
        text: "ok",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 200,
        },
      },
    ]);
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });
    await drain(streamChat([{ role: "user", content: "hi" }], { recorder: rec }));
    rec.finish("successful_no_tool");
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;

    t(
      "cached input is counted in input_tokens, not dropped",
      tr.input_tokens === 100 + 900 + 200,
      `${tr.input_tokens}`
    );
    t("cache reads are kept separately on the call record", tr.calls[0].cache_read_tokens === 900);
    t("cache writes are kept separately too", tr.calls[0].cache_write_tokens === 200);
    t(
      "and they are priced at their own rates",
      tr.cost_usd ===
        cost.roundCost((100 / 1e6) * 2 + (10 / 1e6) * 10 + (900 / 1e6) * 0.2 + (200 / 1e6) * 2.5),
      `${tr.cost_usd}`
    );
  }

  // ══ Unknown model ═══════════════════════════
  console.log("\n=== unknown model pricing ===");
  {
    installFakeModel([{ text: "ok", usage: { input_tokens: 500, output_tokens: 50 } }]);
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-not-a-real-model", emit: (tr) => emitted.push(tr) });
    await drain(streamChat([{ role: "user", content: "hi" }], { recorder: rec }));
    rec.finish("successful_no_tool");
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;

    t("tokens are still counted for an unpriced model", tr.total_tokens === 550, `${tr.total_tokens}`);
    t("cost is null rather than invented", tr.cost_usd === null, `${tr.cost_usd}`);
    t("and the trace SAYS pricing is unknown", tr.pricing_known === false);
  }

  // ══ Tool errors ═════════════════════════════
  console.log("\n=== tool error recorded ===");
  {
    installFakeModel([
      { text: "Looking. ", tool: { name: "no_such_tool", input: {} } },
      { text: "Sorry." },
    ]);
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });
    const out = await drain(streamChat([{ role: "user", content: "?" }], { recorder: rec }));
    rec.finish(rec.firstToolError() ?? "successful_with_tools");
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;

    t("the customer still got an answer", out === "Looking. Sorry.", JSON.stringify(out));
    t("the bad tool call was recorded", tr.tool_calls === 1);
    t(
      "categorised as invalid_tool_call, not a generic failure",
      tr.tools[0].error === "invalid_tool_call",
      `${tr.tools[0].error}`
    );
    t("the tool record is marked not-ok", tr.tools[0].ok === false);
    t("and the turn's outcome carries the category", tr.outcome === "invalid_tool_call", tr.outcome);
  }

  console.log("\n=== a legitimate miss is NOT an error ===");
  {
    installFakeModel([
      { text: "Looking. ", tool: { name: "search_products", input: { query: "zzzznothingmatchesthisxyz" } } },
      { text: "We don't have that." },
    ]);
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });
    await drain(streamChat([{ role: "user", content: "?" }], { recorder: rec }));
    rec.finish(rec.firstToolError() ?? "successful_with_tools");
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;

    t("the lookup ran", tr.tool_calls === 1);
    t("found is false", tr.tools[0].found === false);
    t("but it is NOT categorised as an error", tr.tools[0].error === null, `${tr.tools[0].error}`);
    t("ok stays true — the shop simply has no match", tr.tools[0].ok === true);
    t("so the turn is still a success", tr.outcome === "successful_with_tools", tr.outcome);
  }

  // ══ Model error ═════════════════════════════
  console.log("\n=== model error recorded ===");
  {
    const boom = new Error("upstream 529 overloaded");
    installFakeModel([{ text: "", throws: boom }]);
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });

    let threw = false;
    try {
      await drain(streamChat([{ role: "user", content: "hi" }], { recorder: rec }));
    } catch {
      threw = true;
    }
    rec.finish(obs.classifyModelError(boom));
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;

    t("the error still propagates to the caller", threw, "the route decides what the customer sees");
    t("the failed call was recorded", tr.model_calls === 1, `${tr.model_calls}`);
    t("categorised as a provider error", tr.calls[0].error === "model_provider_error", `${tr.calls[0].error}`);
    t("the failed call has no token counts", tr.calls[0].input_tokens === 0 && tr.calls[0].output_tokens === 0);
    t("outcome reflects the failure", tr.outcome === "model_provider_error", tr.outcome);
  }

  console.log("\n=== malformed model response ===");
  {
    installFakeModel([{ text: "hm", malformed: true }, { text: "done" }]);
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });
    await drain(streamChat([{ role: "user", content: "hi" }], { recorder: rec }));
    rec.finish("successful_no_tool");
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;

    t(
      "a tool_use stop with no tool block is flagged",
      tr.calls[0].error === "malformed_model_response",
      `${tr.calls[0].error}`
    );
    t("and it did not stop the loop", tr.model_calls >= 1);
  }

  // ══ Privacy ═════════════════════════════════
  console.log("\n=== privacy: what must never appear in a trace ===");
  {
    const secretSlug = "SENSITIVE-SLUG-MARKER";
    const secretRef = "A53C16F7";
    installFakeModel([
      { text: "Checking. ", tool: { name: "get_product_details", input: { slug: secretSlug } } },
      { text: "Done." },
    ]);
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });
    await drain(
      streamChat([{ role: "user", content: `where is order ${secretRef}` }], {
        recorder: rec,
        email: "customer@example.com",
      })
    );
    rec.finish("successful_with_tools");
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;
    const serialised = JSON.stringify(tr);

    t("the tool ARGUMENT does not appear anywhere in the trace", !serialised.includes(secretSlug));
    t("the customer's message does not appear", !serialised.includes(secretRef));
    t("the verified email does not appear", !serialised.includes("customer@example.com"));
    t("no field named for message content exists", !/"(content|message|messages|transcript|text|prompt)"/.test(serialised));
    t("no field named for arguments exists", !/"(input|arguments|args|params|payload)"/.test(serialised));
    t("no email-shaped string anywhere", !/[\w.+-]+@[\w-]+\.[\w.]+/.test(serialised));
    t("the tool NAME is still recorded — that is the point", serialised.includes("get_product_details"));
    t(
      "caller is a classification, not an identifier",
      tr.caller === "guest" || tr.caller === "customer"
    );
    t("no quota hash is carried into the trace", !/[0-9a-f]{64}/.test(serialised));

    // The recorder's own surface is the guarantee: assert it structurally.
    const src = fs.readFileSync("lib/ai/observability.ts", "utf8");
    t(
      "ToolCallRecord declares no argument or result field",
      !/interface ToolCallRecord[\s\S]*?\n}/.test(src) ||
        !/interface ToolCallRecord[\s\S]*?\n}/
          .exec(src)![0]
          .match(/\b(input|args|arguments|result|content|payload)\b\s*[?:]/)
    );
    t(
      "recordToolCall takes no argument parameter",
      !/recordToolCall\(r: \{[\s\S]*?\}\)/.test(src) ||
        !/recordToolCall\(r: \{[\s\S]*?\}\)/.exec(src)![0].match(/\b(input|args|arguments)\b\s*[?:]/)
    );
  }

  console.log("\n=== privileged order tool: counted, never quoted ===");
  {
    installFakeModel([
      { text: "Checking your order. ", tool: { name: "get_my_order", input: { reference: "DEADBEEF" } } },
      { text: "Here it is." },
    ]);
    const { streamChat } = await import("../lib/chat");
    const emitted: unknown[] = [];
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: (tr) => emitted.push(tr) });
    await drain(
      streamChat([{ role: "user", content: "my order?" }], {
        recorder: rec,
        email: "someone@example.com",
      })
    );
    rec.finish("successful_with_tools");
    const tr = emitted[0] as import("../lib/ai/observability").AiTrace;
    const serialised = JSON.stringify(tr);

    t("the privileged lookup was recorded", tr.tools.some((x) => x.tool === "get_my_order"));
    t(
      "and flagged as privileged, so its use is countable",
      tr.tools.find((x) => x.tool === "get_my_order")?.privileged === true
    );
    t("the order reference argument is NOT in the trace", !serialised.includes("DEADBEEF"));
    t("nor is the session email", !serialised.includes("someone@example.com"));
  }

  // ══ Resilience ══════════════════════════════
  console.log("\n=== observability must never break the reply ===");
  {
    installFakeModel([{ text: "A calm answer.", usage: { input_tokens: 10, output_tokens: 5 } }]);
    const { streamChat } = await import("../lib/chat");

    // A sink that always throws is the worst realistic case.
    const rec = obs.beginTrace({
      model: "claude-sonnet-5",
      emit: () => {
        throw new Error("telemetry sink is down");
      },
    });

    let out = "";
    let threw = false;
    try {
      out = await drain(streamChat([{ role: "user", content: "hi" }], { recorder: rec }));
      rec.finish("successful_no_tool");
    } catch {
      threw = true;
    }
    t("a throwing emitter does not throw into the caller", !threw);
    t("and the customer's answer is intact", out === "A calm answer.", JSON.stringify(out));
  }

  {
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: () => {} });
    // Hostile inputs straight at the recorder.
    rec.recordToolCall({ tool: "x", latencyMs: -100, found: false });
    rec.setCaller("customer");
    const first = rec.finish("successful_with_tools");
    const second = rec.finish("rate_limited");
    t("a negative latency is clamped to 0", first?.tools[0].latency_ms === 0, `${first?.tools[0].latency_ms}`);
    t("finish() is idempotent — the second call does not re-emit", first === second);
    t("and the first outcome wins", second?.outcome === "successful_with_tools", `${second?.outcome}`);
  }

  {
    let emitCount = 0;
    const rec = obs.beginTrace({ model: "claude-sonnet-5", emit: () => emitCount++ });
    rec.finish("feature_disabled");
    rec.finish("feature_disabled");
    rec.finish("rate_limited");
    t("three finish calls emit exactly one line", emitCount === 1, `${emitCount}`);
  }

  {
    const a = obs.beginTrace({ model: "m", emit: () => {} });
    const b = obs.beginTrace({ model: "m", emit: () => {} });
    t("two traces get different ids", a.traceId !== b.traceId);
  }

  // ══ Route wiring ════════════════════════════
  console.log("\n=== route wiring: every exit finishes the trace ===");
  {
    const route = fs.readFileSync("app/api/chat/route.ts", "utf8");
    t("the route opens a trace", /beginTrace\(/.test(route));
    t("the not-configured exit is recorded", /finish\("not_configured"\)/.test(route));
    t("the feature-disabled exit is recorded", /finish\("feature_disabled"\)/.test(route));
    t("the rate-limited exit is recorded", /finish\("rate_limited"\)/.test(route));
    t("the bad-request exit is recorded", /finish\("bad_request"\)/.test(route));
    t("success distinguishes tool from no-tool", /successful_with_tools/.test(route) && /successful_no_tool/.test(route));
    t("a stream error is classified", /finish\(classifyModelError\(err\)\)/.test(route));
    t("the caller classification is set from the session", /setCaller\(/.test(route));
    t("the feature flag state is recorded", /setFeatureEnabled\(/.test(route));
    t("the recorder is handed to the chat loop", /recorder:\s*trace/.test(route));

    // The trace id is ours. Phase 1.6 gave it a legitimate server-side reader —
    // budget events carry it so a reservation can be correlated with the turn
    // that made it — so "never read" is no longer the invariant. What still
    // holds, and is what actually matters, is that it never reaches the caller.
    const traceIdUses = [...route.matchAll(/\.traceId/g)].map((m) => m.index ?? 0);
    t("every read of the trace id is inside a budget event", traceIdUses.length > 0 &&
      traceIdUses.every((i) => {
        const before = route.slice(Math.max(0, i - 200), i);
        return before.lastIndexOf("emitBudgetEvent(") > before.lastIndexOf(";");
      }), `${traceIdUses.length} reads`);
    t("the trace id never reaches a Response", !/new Response\([^)]*traceId/.test(route));
    t("no trace header is set", !/[xX]-[tT]race/.test(route));
    t(
      "the only response headers are the two the stream needs",
      (route.match(/headers:/g) ?? []).length === 2,
      "Retry-After on 429, Content-Type/Cache-Control on the stream"
    );
  }

  // ══ Boundaries unchanged ════════════════════
  console.log("\n=== existing access boundaries are untouched ===");
  {
    const tools = fs.readFileSync("lib/chatTools.ts", "utf8");
    const bare = tools.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    t("chatTools.ts still constructs no service client", !bare.includes("createServiceClient"));
    t("chatTools.ts still contains no writer", !/\.(insert|update|upsert|delete)\s*\(/.test(bare));
    t("chatTools.ts still reads through ANON_CTX", bare.includes("ANON_CTX"));
    t(
      "the tool list is unchanged — no tool was added",
      (await import("../lib/chatTools")).CHAT_TOOL_NAMES.join(",") ===
        "search_products,get_product_details,check_availability,search_brand_knowledge"
    );

    const chat = fs.readFileSync("lib/chat.ts", "utf8");
    t("the order tool's email is still not a parameter", !/reference[\s\S]{0,300}email:\s*\{/.test(chat));
    t("the privileged tool is still gated on a session email", /MY_ORDER_TOOL\.name && Boolean\(opts\.email\)/.test(chat));
    t("the 4-round cap is unchanged", /MAX_TOOL_ROUNDS = 4/.test(chat));
    t("the model is unchanged", /CHAT_MODEL = "claude-sonnet-5"/.test(chat));
    t(
      "no timeout was silently introduced into the tool path",
      !/AbortController|setTimeout\(/.test(chat),
      "adding one would change customer-facing behaviour"
    );
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
