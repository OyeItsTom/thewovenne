import crypto from "crypto";
import type { NextRequest } from "next/server";
import { createServiceClient } from "./supabase";

/**
 * How much of the concierge a visitor may use.
 *
 * A cap, not a login wall. The widget's value lands before trust exists, so
 * making people sign up to ask "is this real handloom?" costs more in
 * conversions than it saves in API spend. The first several messages are free;
 * only sustained use is stopped, which is what actually protects the bill.
 */

/**
 * Messages per window for an anonymous visitor. Enough for a real
 * pre-purchase conversation, short of what a script would want.
 *
 * When customer accounts land, a signed-in customer should get a higher number
 * here rather than a different mechanism — that is the whole upgrade path.
 */
export const ANON_MESSAGE_LIMIT = 10;
export const QUOTA_WINDOW_HOURS = 1;

/**
 * Salt for the IP digest. A constant, not a secret: it stops the table holding
 * anything directly readable, which is the point, but anyone with the source
 * could confirm a guessed address. Fine for a rate limiter; move it to an
 * environment variable if this ever needs to resist that.
 */
const IP_SALT = "wovenne:chat-quota:v1";

/**
 * The caller's address, as far as it can be known behind a proxy.
 *
 * x-forwarded-for is a client-supplied header everywhere except the hop your
 * own edge sets, so only the FIRST entry is meaningful on Vercel — taking the
 * last, or trusting the whole chain, lets a caller spoof a fresh identity per
 * request and walk straight through the limit.
 */
function callerIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export function ipHash(req: NextRequest): string {
  return crypto
    .createHash("sha256")
    .update(IP_SALT + callerIp(req))
    .digest("hex");
}

export interface QuotaResult {
  allowed: boolean;
  remaining: number;
  resetAt: string | null;
}

/**
 * Spend one message from this caller's allowance.
 *
 * Fails OPEN on a database error: a concierge that stops answering because the
 * counter is unreachable is a worse outcome than a few uncounted messages, and
 * the error is logged for Sentry either way.
 */
export async function consumeChatQuota(
  req: NextRequest,
  limit: number = ANON_MESSAGE_LIMIT
): Promise<QuotaResult> {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc("chat_consume", {
      p_ip_hash: ipHash(req),
      p_limit: limit,
      p_window: `${QUOTA_WINDOW_HOURS} hours`,
    });

    if (error) {
      console.error("consumeChatQuota:", error.message);
      return { allowed: true, remaining: limit, resetAt: null };
    }

    const row = data as { allowed: boolean; remaining: number; reset_at: string };
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      resetAt: row.reset_at ?? null,
    };
  } catch (e) {
    console.error("consumeChatQuota threw:", e);
    return { allowed: true, remaining: limit, resetAt: null };
  }
}

/** What the visitor is told when the allowance runs out. */
export function quotaMessage(resetAt: string | null): string {
  const base =
    "You've reached the limit for now — I can pick this up again shortly.";
  const help =
    " In the meantime, message us on WhatsApp and one of us will answer personally.";

  if (!resetAt) return base + help;

  const mins = Math.max(
    1,
    Math.ceil((new Date(resetAt).getTime() - Date.now()) / 60000)
  );
  return `You've reached the limit for now — try again in about ${mins} minute${
    mins === 1 ? "" : "s"
  }.${help}`;
}
