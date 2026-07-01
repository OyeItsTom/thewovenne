import Anthropic from "@anthropic-ai/sdk";
import { supabase, createServiceClient } from "./supabase";

// Current Sonnet — strong English + Malayalam, Sonnet-tier latency/cost.
// (The brief's "claude-sonnet-4-6" is the previous generation; this is current.)
export const CHAT_MODEL = "claude-sonnet-5";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Compact catalogue context so the assistant can answer fabric/sizing/care/price questions. */
async function getProductContext(): Promise<string> {
  const { data, error } = await supabase
    .from("products")
    .select("name, price_inr, category, fabric, colour, stock_quantity")
    .eq("is_active", true);

  if (error || !data?.length) return "No product data available right now.";

  return data
    .map(
      (p) =>
        `- ${p.name} — ₹${Number(p.price_inr).toLocaleString("en-IN")} · ${p.category ?? "—"} · ${p.fabric ?? "—"} · ${p.colour ?? "—"} · ${p.stock_quantity > 0 ? "in stock" : "out of stock"}`
    )
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

function buildSystemPrompt(products: string, order: string | null): string {
  return `You are "Ask Wovenne", the shop concierge for THE WOVENNE — a premium label selling authentic, handcrafted Indian linen and natural-fibre clothing, woven in Kerala and sent direct from the loom. The brand promise is "OG product, direct from India."

Voice: warm, proud, artisanal, and concise. Answer in 1–3 short paragraphs. All prices are in Indian Rupees (₹).

Language: reply in the SAME language the customer writes in. You natively support English and Malayalam — detect which the customer used and match it.

You can help with:
- Product questions (fabric, sizing, care, availability) — use the catalogue below.
- Order tracking — only when order details are provided in context below.
- General shop help (shipping within India, returns, "is this real handloom linen from Kerala").

If you cannot resolve something, warmly suggest continuing on WhatsApp.
Never invent order details, stock levels, or prices that aren't in the context below.

Current catalogue:
${products}
${order ? `\nThe customer's verified order:\n${order}` : ""}`;
}

/**
 * Shared chat core — used by both the web /api/chat route and (later) the
 * WhatsApp webhook, so both channels answer identically in English or Malayalam.
 * Returns an Anthropic streaming message.
 */
export async function streamChat(
  messages: ChatMessage[],
  opts: { orderId?: string | null; email?: string | null } = {}
) {
  const [products, order] = await Promise.all([
    getProductContext(),
    lookupOrder(opts.orderId ?? null, opts.email ?? null),
  ]);

  return anthropic.messages.stream({
    model: CHAT_MODEL,
    max_tokens: 1024,
    // Latency-sensitive concierge — thinking off for snappy replies.
    thinking: { type: "disabled" },
    system: buildSystemPrompt(products, order),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
}
