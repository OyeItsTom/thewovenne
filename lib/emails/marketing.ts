import type { MarketingTrigger } from "../marketing";

/**
 * The two marketing emails.
 *
 * Quiet, short, and honest about why they arrived — a marketing email that does
 * not say why you are receiving it reads as a leak, however legitimate it is.
 * Every one carries the reason and a way out.
 */

const INK = "#1C1F3B";
const TERRACOTTA = "#C2714F";
const MUTED = "#6b6b76";

export interface MarketingItem {
  name: string;
  slug: string;
  stock: number;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const TRIGGER_SUBJECT: Record<MarketingTrigger, string> = {
  wishlist_waiting: "Still thinking it over?",
  low_stock: "Nearly gone — from your wishlist",
  cart_abandoned: "You left something behind",
};

export const TRIGGER_LABEL: Record<MarketingTrigger, string> = {
  wishlist_waiting: "Wishlist waiting",
  low_stock: "Low stock on a saved item",
  cart_abandoned: "Cart left behind",
};

export const TRIGGER_DESCRIPTION: Record<MarketingTrigger, string> = {
  wishlist_waiting:
    "Customers who have saved something that is still available.",
  low_stock:
    "Customers whose saved item has three or fewer left. Sent sparingly — this one has a deadline built in, and it stops being true once stock returns.",
  cart_abandoned:
    "Signed-in customers whose cart has sat untouched for a day and who haven't bought since. Guests aren't included — their cart never leaves their browser.",
};

function shell(body: string, siteUrl: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="padding-bottom:28px;">
          <div style="font-size:20px;letter-spacing:2px;color:${INK};">THE WOVENNE</div>
          <div style="font-size:12px;color:${MUTED};margin-top:4px;">Woven in India. Worn for life.</div>
        </td></tr>
        ${body}
        <tr><td style="border-top:1px solid #eee;padding-top:20px;font-size:11px;line-height:1.6;color:${MUTED};">
          You're receiving this because you asked for updates when you created
          your account. You can turn them off any time in
          <a href="${siteUrl}/account/preferences" style="color:${TERRACOTTA};">your preferences</a>
          — order and delivery emails are separate and will keep arriving.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function itemList(items: MarketingItem[], siteUrl: string): string {
  return items
    .slice(0, 5)
    .map(
      (i) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">
        <a href="${siteUrl}/product/${esc(i.slug)}" style="color:${INK};text-decoration:none;font-size:15px;">${esc(i.name)}</a>
        ${i.stock <= 3 ? `<span style="color:${TERRACOTTA};font-size:12px;"> · only ${i.stock} left</span>` : ""}
      </td></tr>`
    )
    .join("");
}

export function marketingHtml(
  trigger: MarketingTrigger,
  name: string,
  items: MarketingItem[],
  siteUrl: string
): string {
  const greeting = name?.trim() ? `Hello ${esc(name.split(" ")[0])},` : "Hello,";

  const intro =
    trigger === "cart_abandoned"
      ? "You left these in your basket. They're still there if you'd like them — no rush, and nothing has been reserved."
      : trigger === "low_stock"
      ? "Something you saved is nearly gone. We weave in small batches, so when a piece runs out it can be a while before it returns."
      : "You saved these a little while ago, and they're still here. No rush — we just thought you'd want to know they're still available.";

  return shell(
    `<tr><td style="padding-bottom:8px;font-size:22px;color:${INK};">${greeting}</td></tr>
     <tr><td style="padding-bottom:20px;font-size:15px;line-height:1.6;color:${MUTED};">${intro}</td></tr>
     <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemList(items, siteUrl)}</table></td></tr>
     <tr><td style="padding-top:24px;">
       <a href="${siteUrl}${trigger === "cart_abandoned" ? "/cart" : "/account/wishlist"}" style="display:inline-block;background:${INK};color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:13px;letter-spacing:1px;">${trigger === "cart_abandoned" ? "VIEW YOUR BASKET" : "VIEW YOUR WISHLIST"}</a>
     </td></tr>
     <tr><td style="height:28px;"></td></tr>`,
    siteUrl
  );
}

export function marketingText(
  trigger: MarketingTrigger,
  name: string,
  items: MarketingItem[],
  siteUrl: string
): string {
  const lines = items
    .slice(0, 5)
    .map((i) => `- ${i.name}${i.stock <= 3 ? ` (only ${i.stock} left)` : ""}`);
  return [
    name?.trim() ? `Hello ${name.split(" ")[0]},` : "Hello,",
    "",
    trigger === "cart_abandoned"
      ? "You left these in your basket. They're still there if you'd like them."
      : trigger === "low_stock"
      ? "Something you saved is nearly gone. We weave in small batches."
      : "You saved these a little while ago, and they're still available.",
    "",
    ...lines,
    "",
    trigger === "cart_abandoned"
      ? `Your basket: ${siteUrl}/cart`
      : `Your wishlist: ${siteUrl}/account/wishlist`,
    "",
    "You're receiving this because you asked for updates when you created your",
    `account. Turn them off any time: ${siteUrl}/account/preferences`,
    "Order and delivery emails are separate and will keep arriving.",
    "",
    "THE WOVENNE",
  ].join("\n");
}
