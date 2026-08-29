/**
 * What one Ask Wovenne conversation costs, before it is switched on.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/ai-cost-baseline.ts
 *
 * ══ HOW IT MEASURES WITHOUT SPENDING ══
 *
 * No text is generated. The script patches the SDK's stream method the way the
 * test suites do, runs the REAL streamChat loop against the REAL production
 * catalogue, and captures the request bodies the loop would have sent. Those
 * are the thing worth measuring: the system prompt carries a catalogue index
 * that grows with the shop, and it is resent on every round.
 *
 * Input tokens are then MEASURED with `messages.countTokens`, which does no
 * generation and is not billed. If no usable key is present the script falls
 * back to a character heuristic and says so on every line it prints — an
 * estimate labelled as one is useful; an estimate mistaken for a measurement is
 * how a budget gets set wrongly.
 *
 * Output tokens cannot be measured this way — nothing is generated — so they
 * are modelled from the prompt's own instruction ("1-3 short paragraphs") and
 * the 1024 `max_tokens` ceiling, and are labelled ESTIMATED throughout.
 *
 * ══ WHY THE ROUND COUNT IS THE HEADLINE ══
 *
 * A turn is 1 to 5 model calls. Because the conversation is resent each round,
 * input is paid again every time — so the difference between a no-tool answer
 * and a four-lookup answer is not 4x the tokens of one lookup, it is roughly
 * 5x the system prompt plus the accumulated tool results. That multiplier is
 * the single most important number for anyone setting a budget.
 */
import fs from "node:fs";
import Module from "node:module";

const require_ = Module.createRequire(import.meta.url);

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const i = s.indexOf("=");
  process.env[s.slice(0, i).trim()] = s
    .slice(i + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

const REAL_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const KEY_USABLE = REAL_KEY.startsWith("sk-ant-") && REAL_KEY.length > 40;

interface Captured {
  system: string;
  tools: unknown[];
  messages: unknown[];
}

interface Scripted {
  text: string;
  tool?: { name: string; input: Record<string, unknown> };
}

function installFakeModel(script: Scripted[], captured: Captured[]) {
  const { Messages } = require_("@anthropic-ai/sdk/resources/messages/messages.js");
  let call = 0;

  Messages.prototype.stream = function fakeStream(params: Record<string, unknown>) {
    const turn = script[call] ?? { text: "…" };
    call++;
    captured.push({
      system: String(params.system ?? ""),
      tools: (params.tools as unknown[]) ?? [],
      messages: JSON.parse(JSON.stringify(params.messages ?? [])),
    });

    const content: Record<string, unknown>[] = [{ type: "text", text: turn.text }];
    if (turn.tool) {
      content.push({ type: "tool_use", id: `toolu_${call}`, name: turn.tool.name, input: turn.tool.input });
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
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    };
  };
}

/** Measured where possible; heuristic where not. Always says which. */
let countTokens: (c: Captured) => Promise<{ tokens: number; measured: boolean }>;

async function setupCounter() {
  if (!KEY_USABLE) {
    countTokens = async (c) => ({
      tokens: Math.round((c.system.length + JSON.stringify(c.tools).length + JSON.stringify(c.messages).length) / 4),
      measured: false,
    });
    return;
  }
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: REAL_KEY });
  countTokens = async (c) => {
    try {
      const r = await client.messages.countTokens({
        model: (await import("../lib/chat")).CHAT_MODEL,
        system: c.system,
        tools: c.tools as never,
        messages: c.messages as never,
      });
      return { tokens: r.input_tokens, measured: true };
    } catch (e) {
      console.error("  (countTokens failed, falling back to the heuristic)", (e as Error).message);
      return {
        tokens: Math.round((c.system.length + JSON.stringify(c.tools).length + JSON.stringify(c.messages).length) / 4),
        measured: false,
      };
    }
  };
}

interface Scenario {
  name: string;
  note: string;
  script: Scripted[];
}

/**
 * Output tokens per model call, ESTIMATED.
 *
 * A round that asks for a tool emits a sentence plus a small JSON argument; a
 * round that answers emits the 1-3 short paragraphs the prompt asks for. The
 * high figure is what a chatty answer looks like, well under the 1024 ceiling.
 */
const OUT_TOOL_ROUND = { low: 40, high: 90 };
const OUT_FINAL_ROUND = { low: 120, high: 320 };

async function main() {
  await setupCounter();
  const { streamChat } = await import("../lib/chat");
  const cost = await import("../lib/ai/cost");
  const { CHAT_MODEL } = await import("../lib/chat");

  const scenarios: Scenario[] = [
    {
      name: "No tool",
      note: "a greeting or a shipping question the prompt already answers",
      script: [{ text: "Namaskaram! We ship across India." }],
    },
    {
      name: "One tool",
      note: "\"is the mul cotton in stock?\"",
      script: [
        { text: "Let me check. ", tool: { name: "check_availability", input: { slug: "mul-cotton" } } },
        { text: "Yes — available." },
      ],
    },
    {
      name: "Multi tool",
      note: "\"what linen do you have, and is it real handloom?\"",
      script: [
        { text: "Looking. ", tool: { name: "search_products", input: { query: "linen saree" } } },
        { text: "And the story. ", tool: { name: "search_brand_knowledge", input: { query: "handloom" } } },
        { text: "Here you are." },
      ],
    },
    {
      name: "Worst case",
      note: "the 4-round cap, then a forced tool-free answer — 5 model calls",
      script: [
        { text: "a", tool: { name: "search_products", input: { query: "saree" } } },
        { text: "b", tool: { name: "get_product_details", input: { slug: "mul-cotton" } } },
        { text: "c", tool: { name: "check_availability", input: { slug: "mul-cotton" } } },
        { text: "d", tool: { name: "search_brand_knowledge", input: { query: "kasavu" } } },
        { text: "Here is everything." },
      ],
    },
  ];

  const rows: {
    name: string;
    note: string;
    calls: number;
    tools: number;
    inTokens: number;
    measured: boolean;
    outLow: number;
    outHigh: number;
    costLow: number | null;
    costHigh: number | null;
  }[] = [];

  let systemTokens = 0;
  let systemMeasured = false;
  let catalogueProducts = 0;

  for (const s of scenarios) {
    const captured: Captured[] = [];
    installFakeModel(s.script, captured);
    for await (const _ of streamChat([{ role: "user", content: "baseline probe" }], {})) {
      void _;
    }

    // Every round's input, counted separately then summed — this is where the
    // resend multiplier shows up.
    let inTotal = 0;
    let measured = true;
    for (const c of captured) {
      const r = await countTokens(c);
      inTotal += r.tokens;
      measured = measured && r.measured;
    }

    if (systemTokens === 0 && captured[0]) {
      const only = await countTokens({ system: captured[0].system, tools: [], messages: [{ role: "user", content: "x" }] });
      systemTokens = only.tokens;
      systemMeasured = only.measured;
      // Only the index lines. Counting every "- " also swept up the prompt's own
      // bullet lists ("You can help with:"), which reported 40 products against
      // a 34-product catalogue.
      catalogueProducts = (captured[0].system.match(/\(slug: /g) ?? []).length;
    }

    const toolRounds = captured.length - 1;
    const outLow = toolRounds * OUT_TOOL_ROUND.low + OUT_FINAL_ROUND.low;
    const outHigh = toolRounds * OUT_TOOL_ROUND.high + OUT_FINAL_ROUND.high;

    const costLow = cost.costUsd(CHAT_MODEL, {
      inputTokens: inTotal,
      outputTokens: outLow,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const costHigh = cost.costUsd(CHAT_MODEL, {
      inputTokens: inTotal,
      outputTokens: outHigh,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    rows.push({
      name: s.name,
      note: s.note,
      calls: captured.length,
      tools: toolRounds,
      inTokens: inTotal,
      measured,
      outLow,
      outHigh,
      costLow,
      costHigh,
    });
  }

  const label = (m: boolean) => (m ? "MEASURED" : "ESTIMATED");
  const usd = (n: number | null) => (n == null ? "n/a" : `$${n.toFixed(5)}`);
  const per = (n: number | null, mult: number) => (n == null ? "n/a" : `$${(n * mult).toFixed(2)}`);

  const lines: string[] = [];
  const w = (s = "") => lines.push(s);

  w("# Ask Wovenne — cost baseline");
  w();
  w(`Generated ${new Date().toISOString()} · model \`${CHAT_MODEL}\` · pricing as of ${cost.PRICING_AS_OF}`);
  w();
  w("Produced WITHOUT generating any text. The real `streamChat` loop ran against the");
  w("real production catalogue with a fake model; the request bodies it would have sent");
  w("were captured and counted.");
  w();
  w(
    `- Input tokens: **${label(rows.every((r) => r.measured))}**` +
      (KEY_USABLE
        ? " via `messages.countTokens` (no generation, not billed)"
        : " — no usable local API key (`.env.local` holds a placeholder; the real key\n  lives only in Vercel), so a ~4 chars/token heuristic was used. Treat these as\n  order-of-magnitude: the heuristic is typically within ±20% but is not a token count.\n  Re-run this script anywhere the real key is present to turn every input figure into\n  a measurement.")
  );
  w("- Output tokens: **ESTIMATED** — nothing was generated, so these are modelled from");
  w(`  the prompt's "1-3 short paragraphs" instruction (tool round ${OUT_TOOL_ROUND.low}-${OUT_TOOL_ROUND.high} tok, final round ${OUT_FINAL_ROUND.low}-${OUT_FINAL_ROUND.high} tok).`);
  w("- Cost: derived from the measured/estimated tokens by `lib/ai/cost.ts`.");
  w();
  w("## The system prompt is the dominant cost");
  w();
  w(`The system prompt — brand voice plus a catalogue index of **${catalogueProducts} products** — is`);
  w(`**${systemTokens.toLocaleString()} tokens** (${label(systemMeasured)}), and it is **resent on every round**.`);
  w("A five-call turn therefore pays for it five times before a single tool result is counted.");
  w();
  w("## Per request");
  w();
  w("| Scenario | Model calls | Tools | Input tok | Output tok (est) | Cost low | Cost high |");
  w("|---|--:|--:|--:|--:|--:|--:|");
  for (const r of rows) {
    w(
      `| ${r.name} — ${r.note} | ${r.calls} | ${r.tools} | ${r.inTokens.toLocaleString()} | ${r.outLow}–${r.outHigh} | ${usd(r.costLow)} | ${usd(r.costHigh)} |`
    );
  }
  w();
  w("## Per 100 and per 1,000 conversations");
  w();
  w("Assumes one request per conversation. A real conversation is several messages, so");
  w("multiply again by the turns a customer actually takes.");
  w();
  w("| Scenario | 100 requests | 1,000 requests |");
  w("|---|--:|--:|");
  for (const r of rows) {
    w(`| ${r.name} | ${per(r.costLow, 100)} – ${per(r.costHigh, 100)} | ${per(r.costLow, 1000)} – ${per(r.costHigh, 1000)} |`);
  }
  w();

  const mid = rows.find((r) => r.name === "One tool")!;
  const worst = rows.find((r) => r.name === "Worst case")!;
  w("## Quota ceilings, in money");
  w();
  w("The only spend control today is the message cap in `lib/chatQuota.ts`.");
  w();
  w(`- Anonymous: 10 messages/hour. At the one-tool shape that is ${per(mid.costHigh, 10)}/hour per IP.`);
  w(`- Signed in: 40 messages/hour → ${per(mid.costHigh, 40)}/hour per customer.`);
  w(`- Worst case, signed in: 40 × ${usd(worst.costHigh)} = **${per(worst.costHigh, 40)}/hour, per customer**.`);
  w();
  w("There is no daily or monthly ceiling, and `consumeChatQuota` fails OPEN on a database");
  w("error — so a Supabase outage removes the cap entirely. That is the gap worth closing");
  w("before the feature flag is switched on.");
  w();
  w("## Caching is not in use");
  w();
  w("`cache_read` and `cache_write` are zero on every call. The system prompt is large,");
  w("stable, and resent every round — the exact shape prompt caching exists for. Rough");
  w(`order of magnitude: caching the ${systemTokens.toLocaleString()}-token prefix would cut repeat-round input`);
  w("cost by roughly 90% on that portion. Not proposed here — it is a change to the model");
  w("call, not to telemetry — but it is the obvious lever once these numbers are real.");
  w();

  fs.mkdirSync("reports/ai-observability", { recursive: true });
  fs.writeFileSync("reports/ai-observability/cost-baseline.md", lines.join("\n"));

  console.log(lines.join("\n"));
  console.log("\nWritten to reports/ai-observability/cost-baseline.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
