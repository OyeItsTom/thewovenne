import Anthropic from "@anthropic-ai/sdk";
import { supabase, createServiceClient } from "./supabase";
import { getAllCategories, getVisibleCategoryIds } from "./categories";
import { effectivePrice } from "./pricing";
import { CHAT_TOOLS, runChatTool } from "./chatTools";
import { orderRef } from "./orders";

// Current Sonnet — strong English + Malayalam, Sonnet-tier latency/cost.
// (The brief's "claude-sonnet-4-6" is the previous generation; this is current.)
export const CHAT_MODEL = "claude-sonnet-5";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Whether the concierge has a usable key.
 *
 * Checks for a plausible key, not merely a set variable: the placeholder from
 * .env.local.example is a non-empty string, so a bare presence check passes and
 * the failure only surfaces as a 401 mid-stream — after the response has
 * started, where it can no longer be turned into a clean status code.
 */
export function chatConfigured(): boolean {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return false;
  // Real keys are long and prefixed; the example file ships "your-anthropic-api-key".
  return key.startsWith("sk-ant-") && key.length > 40;
}

/**
 * The catalogue as an INDEX, not as a briefing.
 *
 * Before tools, this string carried everything: fabric, colour, stock, the lot.
 * It now carries only what the model needs in order to know the shop exists and
 * to name the right slug when it looks something up — name, slug, price, whether
 * it can be bought at all. Fabric, sizes, live stock, description and every word
 * of heritage now come from a tool call, which means they are read at the moment
 * they are quoted rather than pasted in at the top of the conversation and
 * trusted three turns later.
 *
 * Kept rather than dropped entirely because a model that cannot see that a piece
 * exists has to guess a search term to discover it, and guesses badly on a
 * four-product catalogue with names like "001".
 */
async function getCatalogueIndex(): Promise<string> {
  // Same visibility scope as the storefront — the concierge must never offer
  // something a shopper can't actually reach.
  const visibleIds = await getVisibleCategoryIds();
  if (visibleIds.length === 0) return "No product data available right now.";

  // Published versions only — the concierge must describe the live shop, not
  // whatever is sitting in drafts.
  const { data, error } = await supabase
    .from("product_versions")
    .select("name, slug, price_inr, category_id, stock_quantity, " +
            "discount_type, discount_value, discount_starts_at, discount_ends_at")
    .eq("state", "published")
    .eq("is_active", true)
    .in("category_id", visibleIds);

  if (error || !data?.length) return "No product data available right now.";

  // Splitting the select string across lines defeats PostgREST's inferred row
  // type, so name the shape here.
  const rows = data as unknown as {
    name: string;
    slug: string;
    price_inr: number;
    category_id: string | null;
    stock_quantity: number;
    discount_type: "percent" | "flat" | null;
    discount_value: number | null;
    discount_starts_at: string | null;
    discount_ends_at: string | null;
  }[];

  const categoryNames = new Map(
    (await getAllCategories()).map((c) => [c.id, c.name])
  );

  return rows
    .map((p) => {
      const category = categoryNames.get(p.category_id ?? "") ?? "—";
      // Quote the campaign price, or the concierge would talk customers
      // through a price the storefront no longer shows.
      const { price, wasPrice } = effectivePrice({
        price_inr: Number(p.price_inr),
        discount_type: p.discount_type,
        discount_value: p.discount_value,
        discount_starts_at: p.discount_starts_at,
        discount_ends_at: p.discount_ends_at,
      });
      const priceText =
        wasPrice == null
          ? `₹${price.toLocaleString("en-IN")}`
          : `₹${price.toLocaleString("en-IN")} (reduced from ₹${wasPrice.toLocaleString("en-IN")})`;
      return `- ${p.name} (slug: ${p.slug}) — ${priceText} · ${category} · ${p.stock_quantity > 0 ? "available" : "sold out"}`;
    })
    .join("\n");
}

/**
 * Look up a single order, only when BOTH the exact order ID and the email match.
 * Never returns another customer's data. Runs with the service role (orders are
 * not publicly readable) but is scoped to one exact record.
 */
async function lookupOrder(
  orderId: string | null,
  email: string | null
): Promise<string | null> {
  if (!orderId || !email) return null;
  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("orders")
      .select("*")
      .eq("id", orderId.trim())
      .eq("customer_email", email.trim().toLowerCase())
      .maybeSingle();

    if (error || !data) return null;

    const items = Array.isArray(data.items)
      ? data.items
          .map((i: { name?: string; quantity?: number; size?: string }) =>
            `${i.quantity ?? 1}× ${i.name ?? "item"}${i.size ? ` (${i.size})` : ""}`
          )
          .join(", ")
      : "—";

    return [
      `Order ${data.id}`,
      `Status: ${data.payment_status ?? "unknown"}`,
      data.tracking_status ? `Tracking: ${data.tracking_status}` : null,
      `Total: ₹${Number(data.total_inr ?? 0).toLocaleString("en-IN")}`,
      `Items: ${items}`,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return null;
  }
}

/**
 * The customer's own orders — the fifth tool, and the only privileged one.
 *
 * ══ WHY IT LIVES HERE AND NOT IN lib/chatTools.ts ══
 *
 * Orders are not publicly readable, so this needs the service role. Every tool in
 * chatTools.ts reads through the anonymous client, and a test asserts that file
 * contains no service client and no writer at all — a boundary worth keeping
 * legible. So the one tool that must reach past RLS is defined next to the
 * function that has always done it, and the loop below is what decides whether to
 * offer it.
 *
 * ══ WHY IT IS SAFE ══
 *
 * The email is NOT a parameter. It is closed over from a verified Supabase
 * session read server-side in the route, and the query is pinned to it. The model
 * chooses which of that customer's orders to describe and can choose nothing
 * else: there is no argument it could pass, and no prompt it could be sent, that
 * widens the query to somebody else's order. A guest gets no tool at all rather
 * than a tool that refuses — the difference matters, because a tool that exists
 * is a tool that will be tried.
 */
const MY_ORDER_TOOL: Anthropic.Tool = {
  name: "get_my_order",
  description:
    "The signed-in customer's own orders: status, what was in them, the total, the courier and tracking number once dispatched, and whether one was cancelled. Call this whenever they ask about an order, a delivery, a refund or a tracking number. Pass the reference they quote — the short code from their confirmation email, like A53C16F7 — or omit it to see their recent orders. It only ever returns orders belonging to the person you are talking to.",
  input_schema: {
    type: "object",
    properties: {
      reference: {
        type: "string",
        description:
          "The order reference as the customer says it: the eight-character code from their email, or the full id. Omit to list their recent orders.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/** What the concierge may call. The fifth tool appears only for a known customer. */
export function chatToolsFor(email: string | null | undefined): Anthropic.Tool[] {
  return email ? [...CHAT_TOOLS, MY_ORDER_TOOL] : CHAT_TOOLS;
}

/**
 * Run the order tool for one verified customer.
 *
 * MATCHES THE SHORT REFERENCE, which is the whole reason this is a tool rather
 * than the old request-body path. Every customer-facing surface shows
 * `orderRef()` — the first block of the uuid, uppercased — because that is what
 * someone can read down a phone. The old lookup compared the full uuid, so a
 * customer quoting the only reference they had ever been given could never match.
 * That is filtered here, in JavaScript, over rows already pinned to their email:
 * no string from the model reaches a query, so a reference cannot be turned into
 * a filter for anyone else's row.
 */
export async function runOrderTool(
  email: string,
  input: unknown
): Promise<{ text: string; found: boolean }> {
  const raw = (input as { reference?: unknown } | null)?.reference;
  const reference = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("orders")
      .select(
        "id, created_at, status, payment_status, total_inr, items, courier_name, " +
          "awb_number, shipped_at, delivered_at, cancelled_at, invoice_number"
      )
      .eq("customer_email", email.trim().toLowerCase())
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw new Error(error.message);

    const orders = (data ?? []) as unknown as {
      id: string;
      created_at: string;
      status: string;
      payment_status: string;
      total_inr: number | string;
      items: { name?: string; quantity?: number; size?: string }[] | null;
      courier_name: string | null;
      awb_number: string | null;
      shipped_at: string | null;
      delivered_at: string | null;
      cancelled_at: string | null;
      invoice_number: string | null;
    }[];

    if (orders.length === 0) {
      return {
        text: "This customer has no orders on that email address. Say so plainly — they may have ordered as a guest with a different address, which is worth asking about.",
        found: false,
      };
    }

    const matched = reference
      ? orders.filter(
          (o) =>
            o.id.toLowerCase() === reference ||
            o.id.toLowerCase().startsWith(reference.replace(/[^0-9a-f]/g, ""))
        )
      : orders.slice(0, 5);

    if (matched.length === 0) {
      return {
        text: `No order of theirs matches "${reference}". They have ${orders.length} order(s); their most recent is ${orderRef(orders[0].id)}. Do not guess which one they meant — ask.`,
        found: false,
      };
    }

    const lines = matched.map((o) => {
      const items = Array.isArray(o.items)
        ? o.items
            .map(
              (i) =>
                `${i.quantity ?? 1}× ${i.name ?? "item"}${
                  i.size && i.size !== "One Size" ? ` (${i.size})` : ""
                }`
            )
            .join(", ")
        : "—";
      return [
        `Order ${orderRef(o.id)} — placed ${new Date(o.created_at).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })}`,
        `Status: ${o.status}${o.payment_status !== "paid" ? ` (payment ${o.payment_status})` : ""}`,
        o.cancelled_at
          ? // Said explicitly, because "cancelled" alone invites the model to
            // reassure them about a refund it cannot see. A credit note records
            // what is owed; the money moving is not visible from here.
            `Cancelled on ${new Date(o.cancelled_at).toLocaleDateString("en-GB")}. A credit note was issued. Do NOT tell them the refund has been paid — you cannot see that; say it follows the way they paid.`
          : null,
        o.awb_number
          ? `Dispatched with ${o.courier_name ?? "the courier"}, tracking ${o.awb_number}. Tell them to track it with the courier using that number — we do not have live courier updates.`
          : null,
        o.delivered_at ? `Delivered ${new Date(o.delivered_at).toLocaleDateString("en-GB")}.` : null,
        `Total: ₹${Number(o.total_inr ?? 0).toLocaleString("en-IN")}`,
        o.invoice_number ? `Invoice ${o.invoice_number}` : null,
        `Items: ${items}`,
      ]
        .filter(Boolean)
        .join("\n");
    });

    return { text: lines.join("\n\n"), found: true };
  } catch (e) {
    console.error("get_my_order failed:", e);
    return {
      text: "That lookup failed just now. Say you cannot check the order at the moment and offer WhatsApp. Do not describe an order from memory.",
      found: false,
    };
  }
}

function buildSystemPrompt(
  products: string,
  order: string | null,
  signedIn: boolean
): string {
  return `You are "Ask Wovenne", the shop concierge for THE WOVENNE — a premium label selling authentic, handcrafted Indian linen and natural-fibre clothing, woven in Kerala and sent direct from the loom. The brand promise is "OG product, direct from India."

Voice: warm, proud, artisanal, and concise. Answer in 1–3 short paragraphs. All prices are in Indian Rupees (₹).

Language: reply in the SAME language the customer writes in. You natively support English and Malayalam — detect which the customer used and match it.

You can help with:
- Product questions (fabric, sizing, care, availability) — look them up with your tools.
- Heritage and craft questions — look them up with search_brand_knowledge.
- General shop help (shipping within India, returns, "is this real handloom linen from Kerala").
${
  signedIn
    ? `- Order tracking — this customer is signed in, so call get_my_order. It returns
  only their own orders. Never ask them for their email address: you already have
  it, and asking invites them to type somebody else's.`
    : `- Order tracking — NOT AVAILABLE in this conversation. This person is not signed
  in, so you have no way to tell whose orders are whose. Ask them to sign in at the
  account page and come back, or to message us on WhatsApp. Do not ask them to type
  an order number or an email address here and do not speculate about an order's
  status.`
}

LOOK IT UP RATHER THAN RECALLING IT. You have four read-only tools. Use them:
- Before quoting any price, size or stock level, call the tool that has it. The
  index below is a list of what exists, not a source for details, and an answer
  that was true earlier in this conversation may not be true now.
- For anything about how the cloth was made, where it comes from, whether it is
  genuine handloom, or how to wash it: call search_brand_knowledge. That is the
  shop's own written record and it is the ONLY acceptable source for those
  answers.
- If a tool returns nothing, say we do not have that or have not written it up,
  and offer WhatsApp. Never fill the gap from general knowledge about Indian
  textiles — a plausible sentence about a weaving tradition we did not write is a
  claim this shop cannot stand behind, and provenance is what customers are
  buying.

If you cannot resolve something, warmly suggest continuing on WhatsApp.
Never invent order details, stock levels, or prices.

What the shop sells (an index — call a tool for any detail):
${products}
${order ? `\nThe customer's verified order:\n${order}` : ""}`;
}

/**
 * How many times the concierge may look something up before it has to answer.
 *
 * Four is enough for the real shapes — search, then details, then stock, then
 * heritage — and low enough that a confused turn cannot sit there calling tools
 * while a customer watches a blinking cursor.
 */
const MAX_TOOL_ROUNDS = 4;

/**
 * Shared chat core — used by both the web /api/chat route and the WhatsApp
 * webhook, so both channels answer identically in English or Malayalam.
 *
 * ══ IT YIELDS TEXT NOW, RATHER THAN RETURNING A STREAM ══
 *
 * It used to hand back one Anthropic stream for the caller to read. With tools
 * there is no single stream to hand back: one customer message becomes several
 * model calls with lookups in between. So this owns the loop and emits the text
 * as it arrives; the web route pipes it to the browser and the WhatsApp path
 * concatenates it. Neither caller knows how many rounds happened.
 *
 * ══ ADAPTIVE THINKING, LOW EFFORT ══
 *
 * Thinking was disabled here for latency. With tools that is the wrong setting:
 * on this model a thinking-off turn reaches for tools noticeably less, which is
 * precisely the behaviour the tools exist to get. Adaptive at low effort keeps
 * replies quick and restores the tool calls. Thinking text is never forwarded —
 * only text deltas are yielded — so the customer sees an answer, not reasoning.
 */
export async function* streamChat(
  messages: ChatMessage[],
  opts: {
    orderId?: string | null;
    email?: string | null;
    /**
     * Told about every lookup, so a caller can log them. Worth having for the
     * misses in particular: "search_brand_knowledge found nothing" is the shop
     * being asked about a piece nobody has written up, which is a content task
     * arriving as a log line rather than as a customer complaint.
     */
    onTool?: (name: string, found: boolean) => void;
  } = {}
): AsyncGenerator<string, void, void> {
  const [products, order] = await Promise.all([
    getCatalogueIndex(),
    lookupOrder(opts.orderId ?? null, opts.email ?? null),
  ]);

  const system = buildSystemPrompt(products, order, Boolean(opts.email));
  const tools = chatToolsFor(opts.email);
  const turns: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // The last round is asked WITHOUT tools rather than simply cut off. A
    // customer who asked a question gets an answer built from whatever was
    // gathered, instead of silence because the budget ran out mid-lookup.
    const exhausted = round === MAX_TOOL_ROUNDS;

    const stream = anthropic.messages.stream({
      model: CHAT_MODEL,
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system,
      tools,
      ...(exhausted ? { tool_choice: { type: "none" as const } } : {}),
      messages: turns,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }

    const reply = await stream.finalMessage();
    if (reply.stop_reason !== "tool_use" || exhausted) return;

    // The whole content array, not just the text: dropping the tool_use blocks
    // here would leave the next request with tool results answering nothing.
    turns.push({ role: "assistant", content: reply.content });

    const calls = reply.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // Run them together, and return every result in ONE user message. Splitting
    // results across messages teaches the model to stop asking for tools in
    // parallel, which is the opposite of what a three-lookup answer needs.
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      calls.map(async (call) => {
        // The one tool the anonymous dispatcher must never be able to run. It is
        // only in the list at all when opts.email came from a verified session,
        // and the email is taken from there rather than from the call.
        const outcome =
          call.name === MY_ORDER_TOOL.name && opts.email
            ? await runOrderTool(opts.email, call.input)
            : await runChatTool(call.name, call.input);
        opts.onTool?.(call.name, outcome.found);
        return {
          type: "tool_result" as const,
          tool_use_id: call.id,
          content: outcome.text,
        };
      })
    );

    turns.push({ role: "user", content: results });
  }
}
