/**
 * The tool loop itself, driven by a fake model.
 *
 *   npx tsx scripts/chat-loop.test.ts
 *
 * WHY A FAKE AND NOT THE REAL THING. Two separate questions live in this upgrade:
 * whether the loop is wired correctly (deterministic, ours, testable) and whether
 * the model chooses to use it (a property of the prompt, only answerable against
 * the live API — see scripts/concierge-live.ts). This file answers the first, and
 * it answers it without a key, so it runs in any checkout.
 *
 * The four things asserted here are the ones that break silently:
 *   1. text from every round reaches the caller, in order;
 *   2. the assistant's tool_use blocks are appended before the results, or the
 *      next request has results answering nothing;
 *   3. ALL results go back in ONE user message — splitting them teaches the model
 *      to stop asking for tools in parallel;
 *   4. the loop stops, and the last round is asked with tools switched OFF so the
 *      customer gets an answer rather than silence.
 *
 * It patches Messages.prototype.stream before lib/chat is imported. That reaches
 * into the SDK's shape deliberately: lib/chat builds its client at module load,
 * which is the right thing for a server module and leaves no seam to inject. If a
 * future SDK renames that method this test fails loudly, which is the correct
 * outcome — it is testing the integration.
 */
import fs from "node:fs";
import Module from "node:module";

const require_ = Module.createRequire(import.meta.url);

process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-for-a-fake-client-0000000000000000";
// Anon Supabase creds are needed only because lib/chat builds the catalogue index
// on the way in; the fake below never depends on what it says.
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const key = t.slice(0, i).trim();
  if (key === "ANTHROPIC_API_KEY") continue;
  process.env[key] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

/** One scripted turn: what the fake model says, and whether it asks for a tool. */
interface Scripted {
  text: string;
  tool?: { name: string; input: Record<string, unknown> };
}

interface Recorded {
  hadTools: boolean;
  toolChoice: unknown;
  messages: { role: string; content: unknown }[];
}

function installFakeModel(script: Scripted[], recorded: Recorded[]) {
  const { Messages } = require_("@anthropic-ai/sdk/resources/messages/messages.js");

  Messages.prototype.stream = function fakeStream(params: Record<string, unknown>) {
    const turn = script[recorded.length] ?? { text: "(no more script)" };
    recorded.push({
      hadTools: Array.isArray(params.tools) && (params.tools as unknown[]).length > 0,
      toolChoice: params.tool_choice,
      messages: JSON.parse(JSON.stringify(params.messages)),
    });

    const content: Record<string, unknown>[] = [{ type: "text", text: turn.text }];
    if (turn.tool) {
      content.push({
        type: "tool_use",
        id: `toolu_${recorded.length}`,
        name: turn.tool.name,
        input: turn.tool.input,
      });
    }

    return {
      // The loop reads text deltas off the async iterator…
      async *[Symbol.asyncIterator]() {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: turn.text },
        };
      },
      // …then asks for the assembled message to decide what to do next.
      async finalMessage() {
        return {
          role: "assistant",
          content,
          stop_reason: turn.tool ? "tool_use" : "end_turn",
        };
      },
    };
  };
}

async function main() {
  console.log("\n=== one lookup, then an answer ===");
  {
    const recorded: Recorded[] = [];
    installFakeModel(
      [
        { text: "Let me check. ", tool: { name: "check_availability", input: { slug: "mul-cotton" } } },
        { text: "Yes — eleven available." },
      ],
      recorded
    );
    const { streamChat } = await import("../lib/chat");

    const seen: string[] = [];
    const tools: string[] = [];
    let out = "";
    for await (const delta of streamChat([{ role: "user", content: "in stock?" }], {
      onTool: (name) => tools.push(name),
    })) {
      out += delta;
      seen.push(delta);
    }

    t("two rounds ran", recorded.length === 2, `${recorded.length}`);
    t("the tool was executed", tools.join(",") === "check_availability", tools.join(","));
    t(
      "text from BOTH rounds reached the caller, in order",
      out === "Let me check. Yes — eleven available.",
      JSON.stringify(out)
    );

    // Round two's message list is where the wiring shows.
    const second = recorded[1].messages;
    t("the second request has three turns", second.length === 3, `${second.length}`);
    t("turn 2 is the assistant", second[1].role === "assistant");
    const assistantBlocks = second[1].content as { type: string }[];
    t(
      "and carries its tool_use block, not just its text",
      Array.isArray(assistantBlocks) && assistantBlocks.some((b) => b.type === "tool_use"),
      JSON.stringify(assistantBlocks.map((b) => b.type))
    );
    t("turn 3 is a user message", second[2].role === "user");
    const results = second[2].content as { type: string; tool_use_id: string }[];
    t(
      "holding the tool_result, matched to the call id",
      results.length === 1 && results[0].type === "tool_result" && results[0].tool_use_id === "toolu_1",
      JSON.stringify(results.map((r) => r.type))
    );
    t("and the round-two request still offers the tools", recorded[1].hadTools);
    t("with no forced choice", recorded[1].toolChoice === undefined);
  }

  console.log("\n=== two lookups in one turn ===");
  {
    // The parallel case. Both results must ride the same user message; one per
    // message trains the model out of asking for two at once.
    const recorded: Recorded[] = [];
    const { Messages } = require_("@anthropic-ai/sdk/resources/messages/messages.js");
    Messages.prototype.stream = function twoCalls(params: Record<string, unknown>) {
      const round = recorded.length;
      recorded.push({
        hadTools: Array.isArray(params.tools),
        toolChoice: params.tool_choice,
        messages: JSON.parse(JSON.stringify(params.messages)),
      });
      const content: Record<string, unknown>[] =
        round === 0
          ? [
              { type: "text", text: "Checking both. " },
              { type: "tool_use", id: "toolu_a", name: "get_product_details", input: { slug: "mul-cotton" } },
              { type: "tool_use", id: "toolu_b", name: "check_availability", input: { slug: "mul-cotton" } },
            ]
          : [{ type: "text", text: "Both look good." }];
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } };
        },
        async finalMessage() {
          return { role: "assistant", content, stop_reason: round === 0 ? "tool_use" : "end_turn" };
        },
      };
    };

    const { streamChat } = await import("../lib/chat");
    const tools: string[] = [];
    for await (const _ of streamChat([{ role: "user", content: "details and stock?" }], {
      onTool: (name) => tools.push(name),
    })) {
      void _;
    }

    t("both tools ran", tools.length === 2, tools.join(","));
    const results = recorded[1].messages[2].content as { type: string; tool_use_id: string }[];
    t(
      "both results came back in ONE user message",
      results.length === 2,
      `${results.length} block(s) in the single user turn`
    );
    t(
      "each matched to its own call id",
      results.map((r) => r.tool_use_id).sort().join(",") === "toolu_a,toolu_b",
      results.map((r) => r.tool_use_id).join(",")
    );
  }

  console.log("\n=== a model that will not stop asking ===");
  {
    // Every round asks for another lookup. The loop must end, and must end with a
    // round that has no tools to reach for, so the customer gets prose.
    const recorded: Recorded[] = [];
    installFakeModel(
      Array.from({ length: 12 }, () => ({
        text: "",
        tool: { name: "search_products", input: { query: "linen" } },
      })),
      recorded
    );
    const { streamChat } = await import("../lib/chat");

    const tools: string[] = [];
    for await (const _ of streamChat([{ role: "user", content: "loop forever" }], {
      onTool: (name) => tools.push(name),
    })) {
      void _;
    }

    t("the loop terminates", recorded.length <= 6, `${recorded.length} model calls`);
    t("after a bounded number of lookups", tools.length <= 5, `${tools.length} lookups`);
    const last = recorded[recorded.length - 1];
    t(
      "and the final round forbids tools so an answer has to come out",
      JSON.stringify(last.toolChoice) === JSON.stringify({ type: "none" }),
      JSON.stringify(last.toolChoice)
    );
    t(
      "no lookup ran after that final round",
      tools.length === recorded.length - 1,
      `${tools.length} lookups across ${recorded.length} calls`
    );
  }

  console.log("\n=== no tools needed at all ===");
  {
    const recorded: Recorded[] = [];
    installFakeModel([{ text: "We ship across India in 3–5 days." }], recorded);
    const { streamChat } = await import("../lib/chat");
    let out = "";
    const tools: string[] = [];
    for await (const delta of streamChat([{ role: "user", content: "do you ship to Kochi?" }], {
      onTool: (n) => tools.push(n),
    })) {
      out += delta;
    }
    t("one model call", recorded.length === 1, `${recorded.length}`);
    t("no lookups", tools.length === 0);
    t("the answer is passed straight through", out === "We ship across India in 3–5 days.");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
