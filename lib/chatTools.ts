import type Anthropic from "@anthropic-ai/sdk";
import { ANON_CTX } from "./readCtx";
import { getBrandKnowledge, hasBrandKnowledge } from "./products";
import { getProductBySlug } from "./products";
import { searchBrandKnowledge, searchProducts } from "./search";
import { getProductSizes, hasAnyStock } from "./sizes";
import { effectivePrice } from "./pricing";

/**
 * The four things Ask Wovenne is allowed to look up.
 *
 * ══ WHAT THIS IS AND IS NOT ══
 *
 * It is a set of READS the model may ask for by name. It is not an agent: there
 * is no tool here that writes, no tool that acts, and no tool that takes a query
 * language. The model chooses which question to ask and with what arguments; the
 * answer is produced by this file, from the same helpers the storefront renders
 * itself with.
 *
 * ══ WHY THAT IS SAFE, STRUCTURALLY ══
 *
 * Every executor below reads through ANON_CTX — the anonymous Supabase client,
 * subject to RLS, scoped by getVisibleCategoryIds() the same way every public
 * page is. Not "we didn't write an UPDATE": the client it holds cannot write, and
 * cannot see a hidden category, so neither can the concierge. The one privileged
 * read in the chat path (an order, matched on exact id AND email, with the
 * service key) stays where it is in lib/chat.ts and is deliberately NOT a tool —
 * the model must not be able to decide to go looking for orders.
 *
 * No SQL is generated anywhere. Each tool takes typed parameters and builds a
 * PostgREST query from them; there is no path from a model's output to a
 * statement.
 *
 * ══ WHY THE DESCRIPTIONS READ LIKE INSTRUCTIONS ══
 *
 * Each says WHEN to call it, not just what it does. On current models a
 * prescriptive description is what actually moves the call rate — a tool
 * described only by its return value gets reached for far less often than one
 * that names the question it answers.
 */

/** The reply, as text the model reads. Keep it dense; it is context, not prose. */
export interface ToolOutcome {
  text: string;
  /** For logging: did this actually find anything? */
  found: boolean;
}

const NOT_FOUND = (what: string): ToolOutcome => ({
  text: `No match for ${what}. Do not guess — say we don't have it, and offer to pass the question to a person on WhatsApp.`,
  found: false,
});

/** Price as the storefront shows it today, campaign included. */
function priceLine(product: {
  price_inr: number;
  discount_type: "percent" | "flat" | null;
  discount_value: number | null;
  discount_starts_at: string | null;
  discount_ends_at: string | null;
}): string {
  const { price, wasPrice } = effectivePrice(product);
  const now = `₹${price.toLocaleString("en-IN")}`;
  return wasPrice == null
    ? now
    : `${now} (reduced from ₹${wasPrice.toLocaleString("en-IN")})`;
}

// ══ Definitions ═══════════════════════════════

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_products",
    description:
      "Find pieces in the shop matching a description. Call this whenever the customer asks what we have — by fabric, colour, category, occasion or name — and before saying we do or do not stock something. Returns names, prices, fabric, colour and whether each is in stock. Names returned here are the exact slugs the other tools take.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look for, in the customer's own words: 'linen shirt', 'red saree', 'something for a wedding'. Every word must match somewhere, so keep it to the meaningful terms.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_product_details",
    description:
      "Everything recorded about one piece: price, fabric, colour, category, description, sizes and stock. Call this before describing a specific piece in any detail, and before quoting a price — never quote a price from memory or from an earlier turn.",
    input_schema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The product's slug, exactly as returned by search_products.",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "check_availability",
    description:
      "Live stock for one piece, per size. Call this whenever the customer asks whether something is available, or available in their size, and before saying anything is in or out of stock — stock changes through the day and an answer from earlier in the conversation may already be wrong.",
    input_schema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The product's slug, exactly as returned by search_products.",
        },
        size: {
          type: "string",
          description:
            "Optional. A specific size label such as 'M'. Omit to get every size at once.",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "search_brand_knowledge",
    description:
      "What we have written about how our cloth is made: the weaving tradition, the region, the technique, and how to care for a piece. Call this for any question about heritage, provenance, authenticity, craft, or washing and care — this is the shop's own written record, and it is the only acceptable source for those answers. Pass a slug for one piece, or a query to search across pieces ('kasavu', 'pit loom'). If it returns nothing, say we haven't written it up rather than answering from general knowledge about Indian textiles.",
    input_schema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "A product slug, to get everything written about that piece.",
        },
        query: {
          type: "string",
          description:
            "Words to search for across every piece's notes. Use this when the customer asks about a tradition or technique rather than about one product.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

// ══ Executors ═════════════════════════════════

async function runSearchProducts(input: { query?: unknown }): Promise<ToolOutcome> {
  const query = typeof input.query === "string" ? input.query : "";
  if (!query.trim()) return NOT_FOUND("an empty search");

  const { products } = await searchProducts(query, ANON_CTX, 8);
  if (products.length === 0) return NOT_FOUND(`"${query}"`);

  const lines = products.map(
    (p) =>
      `- ${p.name} (slug: ${p.slug}) — ${priceLine(p)} · ${p.category ?? "—"} · ` +
      `${p.fabric ?? "fabric not recorded"} · ${p.colour ?? "colour not recorded"} · ` +
      `${p.stock_quantity > 0 ? "in stock" : "out of stock"}`
  );
  return { text: `${products.length} match(es) for "${query}":\n${lines.join("\n")}`, found: true };
}

async function runGetProductDetails(input: { slug?: unknown }): Promise<ToolOutcome> {
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (!slug) return NOT_FOUND("a missing slug");

  const product = await getProductBySlug(slug, ANON_CTX);
  if (!product) return NOT_FOUND(`the piece "${slug}"`);

  const sizes = await getProductSizes(product.id, ANON_CTX.client);
  const sizeText = sizes.length
    ? sizes.map((s) => `${s.label} (${s.stock_quantity} left)`).join(", ")
    : "one size only";

  return {
    text: [
      `${product.name} (slug: ${product.slug})`,
      `Price: ${priceLine(product)}`,
      `Category: ${product.category ?? "—"}`,
      `Fabric: ${product.fabric ?? "not recorded"}`,
      `Colour: ${product.colour ?? "not recorded"}`,
      `Sizes: ${sizeText}`,
      `Available: ${hasAnyStock(sizes, product.stock_quantity) ? "yes" : "no — sold out"}`,
      product.description ? `Description: ${product.description}` : null,
      // Said explicitly, so the model doesn't fill the gap itself.
      "Heritage, craft and care are NOT in this reply — call search_brand_knowledge for those.",
    ]
      .filter(Boolean)
      .join("\n"),
    found: true,
  };
}

/**
 * Stock, read the way a sale reads it.
 *
 * PER SIZE WHERE SIZES EXIST, and from the published version's own count where
 * they do not — which is exactly what reserve_stock does. products.stock_quantity
 * looks like the right column and is not the one a sale decrements; quoting it
 * would let the concierge promise a size the till would then refuse.
 */
async function runCheckAvailability(input: {
  slug?: unknown;
  size?: unknown;
}): Promise<ToolOutcome> {
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  const size = typeof input.size === "string" ? input.size.trim() : "";
  if (!slug) return NOT_FOUND("a missing slug");

  const product = await getProductBySlug(slug, ANON_CTX);
  if (!product) return NOT_FOUND(`the piece "${slug}"`);

  const sizes = await getProductSizes(product.id, ANON_CTX.client);

  if (sizes.length === 0) {
    const count = product.stock_quantity;
    return {
      text: `${product.name} has no separate sizes. ${
        count > 0 ? `${count} available.` : "Out of stock."
      }`,
      found: true,
    };
  }

  if (size) {
    const match = sizes.find((s) => s.label.toLowerCase() === size.toLowerCase());
    if (!match) {
      return {
        text: `${product.name} does not come in "${size}". It comes in: ${sizes
          .map((s) => s.label)
          .join(", ")}.`,
        found: true,
      };
    }
    return {
      text: `${product.name} in ${match.label}: ${
        match.stock_quantity > 0 ? `${match.stock_quantity} available` : "out of stock"
      }.`,
      found: true,
    };
  }

  return {
    text: `${product.name} by size — ${sizes
      .map((s) => `${s.label}: ${s.stock_quantity > 0 ? `${s.stock_quantity} available` : "out of stock"}`)
      .join("; ")}.`,
    found: true,
  };
}

function knowledgeLines(k: {
  name: string;
  slug: string;
  heritage: string | null;
  craft: string | null;
  care: string | null;
}): string {
  return [
    `${k.name} (slug: ${k.slug})`,
    k.heritage ? `Heritage: ${k.heritage}` : null,
    k.craft ? `Craft: ${k.craft}` : null,
    k.care ? `Care: ${k.care}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function runSearchBrandKnowledge(input: {
  slug?: unknown;
  query?: unknown;
}): Promise<ToolOutcome> {
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  const query = typeof input.query === "string" ? input.query.trim() : "";

  if (slug) {
    const knowledge = await getBrandKnowledge({ slug }, ANON_CTX);
    if (!knowledge) return NOT_FOUND(`the piece "${slug}"`);
    if (!hasBrandKnowledge(knowledge)) {
      // The distinction matters: the piece exists, we simply have not written
      // it up. Answering from general knowledge about Kerala handloom here is
      // the one thing that would put an unverifiable claim in a customer's hands.
      return {
        text: `${knowledge.name} exists but nothing has been written about its heritage, craft or care yet. Say exactly that — do not describe how it was probably made — and offer to ask the team on WhatsApp.`,
        found: false,
      };
    }
    return { text: knowledgeLines(knowledge), found: true };
  }

  const { entries } = await searchBrandKnowledge(query, ANON_CTX, 4);
  if (entries.length === 0) {
    return {
      text: query
        ? `Nothing written about "${query}". Say we haven't documented that rather than answering from general knowledge, and offer WhatsApp.`
        : "No pieces have been written up yet. Say so plainly if asked about heritage or care.",
      found: false,
    };
  }
  return { text: entries.map(knowledgeLines).join("\n\n"), found: true };
}

// ══ Dispatch ══════════════════════════════════

/**
 * Run one tool the model asked for.
 *
 * An unknown name is answered rather than thrown: a model that hallucinates a
 * tool should be told it does not exist and continue, not kill the reply the
 * customer is waiting on.
 */
export async function runChatTool(
  name: string,
  input: unknown
): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "search_products":
        return await runSearchProducts(args);
      case "get_product_details":
        return await runGetProductDetails(args);
      case "check_availability":
        return await runCheckAvailability(args);
      case "search_brand_knowledge":
        return await runSearchBrandKnowledge(args);
      default:
        return {
          text: `There is no tool called "${name}". Answer from what you already have, or offer WhatsApp.`,
          found: false,
        };
    }
  } catch (e) {
    // Never fatal. A failed lookup becomes a tool result the model can work
    // with, so the customer gets a graceful answer instead of a dropped stream.
    console.error(`chat tool ${name} failed:`, e);
    return {
      text: "That lookup failed just now. Tell the customer you can't check right now and offer WhatsApp. Do not answer from memory.",
      found: false,
    };
  }
}

/** Every tool name, for the loop's own sanity checks and for tests. */
export const CHAT_TOOL_NAMES = CHAT_TOOLS.map((t) => t.name);
