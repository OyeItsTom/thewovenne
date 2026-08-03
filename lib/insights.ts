import { createServiceClient } from "./supabase";
import {
  getLowStock, getRevenue, getSignups, getSummary,
  getTopProducts, getWishlistCounts,
} from "./analytics";

/**
 * The data the insights chat is allowed to see.
 *
 * All six aggregates are gathered here and handed to the model as one compact
 * block. The model is never given a database connection, a query interface, or
 * a tool that takes SQL — so "show me every customer's address" is not something
 * it can be talked into. The capability does not exist.
 *
 * Every value below is a count, a sum, or a product name. No emails, no
 * addresses, no phone numbers, no order ids, no customer names. That is a
 * property of the aggregate functions in migration 0025, not of the prompt —
 * a prompt can be argued with.
 *
 * Pre-computing all six rather than letting the model request them is fine at
 * this size: six small JSON blobs is a smaller payload than a tool-calling
 * round trip. If the catalogue grows enough that this gets long, the fix is
 * tool-use over these same six functions — never widening what they return.
 */
export async function gatherInsightsContext(): Promise<string> {
  const c = createServiceClient();

  const [summary30, summary7, revenue, top, low, wishlist, signups] =
    await Promise.all([
      getSummary(c, 30),
      getSummary(c, 7),
      getRevenue(c, "day", 30),
      getTopProducts(c, 30, 15),
      getLowStock(c, 5),
      getWishlistCounts(c, 15),
      getSignups(c, 30),
    ]);

  return [
    "STORE DATA (all figures in INR; revenue means goods only, postage excluded)",
    "",
    `Last 30 days: ${JSON.stringify(summary30)}`,
    `Last 7 days: ${JSON.stringify(summary7)}`,
    "",
    `Daily revenue, last 30 days: ${JSON.stringify(revenue)}`,
    "",
    `Best sellers, last 30 days: ${JSON.stringify(top)}`,
    "",
    `Stock at or below 5: ${JSON.stringify(low)}`,
    "",
    `Wishlist saves per product: ${JSON.stringify(wishlist)}`,
    "",
    `New customer accounts per day, last 30 days: ${JSON.stringify(signups)}`,
  ].join("\n");
}

export const INSIGHTS_SYSTEM = `You are the analytics assistant for THE WOVENNE, a handloom linen shop in Kerala, India. You are speaking to one of the three owners inside their admin panel.

Answer only from the STORE DATA block provided. It is the complete set of figures you have.

Rules:
- Use the actual numbers. Quote them. Never estimate, extrapolate or invent a figure that is not in the data.
- If the data does not answer the question, say so plainly and say what would be needed. Do not guess.
- Some things are genuinely not tracked: product page views, traffic sources, conversion rate, and the content of customer questions to the storefront concierge. If asked about those, say they are not tracked rather than substituting a proxy without saying so.
- Zero is a real answer. A new shop with no sales yet should be told that, not offered encouragement dressed as analysis.
- Revenue figures exclude shipping. Say so if it could matter to the answer.
- Be brief and concrete. This is a working tool, not a report. Two or three sentences is usually right; use a short list when comparing items.
- Currency is INR, written as ₹.
- Stay on the shop's data. If asked something unrelated, say it is outside what you can see here.`;
