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

/**
 * And what a signed-in customer gets.
 *
 * THE UPGRADE PATH THE ORIGINAL COMMENT PROMISED. Until now the cap was the same
 * number for everybody — a customer who had created an account, verified an email
 * and bought something was rate-limited exactly like a passing scraper, and the
 * "full access requires login" behaviour did not actually exist anywhere in the
 * code. It does now, and it is the same mechanism with a different number rather
 * than a second system: a login raises the allowance, it does not unlock a
 * different concierge.
 *
 * Not unlimited. An account costs an email address and nothing else, so an
 * uncapped signed-in tier is one signup away from being an uncapped anonymous
 * tier. Forty is a long conversation and a poor harvesting tool.
 */
export const SIGNED_IN_MESSAGE_LIMIT = 40;
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

/**
 * Who is asking, and what they are allowed.
 *
 * The quota key is opaque to the database — chat_consume takes text — so a
 * signed-in customer is keyed by their own id rather than their address. That
 * matters in both directions: two customers behind one office NAT no longer eat
 * each other's allowance, and someone who signs out cannot start again on a fresh
 * count, because the anonymous key was never the one being spent.
 */
export interface ChatCaller {
  key: string;
  limit: number;
  signedIn: boolean;
}

/** A visitor we know nothing about: keyed on the address, low allowance. */
export function anonymousCaller(req: NextRequest): ChatCaller {
  return { key: `ip:${ipHash(req)}`, limit: ANON_MESSAGE_LIMIT, signedIn: false };
}

/**
 * A signed-in customer: keyed on their own id, higher allowance.
 *
 * The id comes from a verified Supabase session read on the server, never from
 * anything the browser sent — a caller who could name a user id would otherwise
 * be able to claim the larger allowance by typing one.
 */
export function signedInCaller(userId: string): ChatCaller {
  return {
    key: `user:${crypto.createHash("sha256").update(IP_SALT + userId).digest("hex")}`,
    limit: SIGNED_IN_MESSAGE_LIMIT,
    signedIn: true,
  };
}

export interface QuotaResult {
  allowed: boolean;
  remaining: number;
  resetAt: string | null;
}

/**
 * Spend one message from this caller's allowance.
 *
 * ══ IT NOW FAILS CLOSED, AND THAT IS A REVERSAL ══
 *
 * This used to return `{allowed: true}` on any database error, on the reasoning
 * that a concierge which stops answering is worse than a few uncounted
 * messages. That reasoning was sound when the counter was the only thing at
 * stake. It is not sound now, for two reasons the Phase 1 baseline made
 * concrete:
 *
 *   1. This is the ONLY rate limit on a public, unauthenticated endpoint that
 *      spends real money — roughly $0.03 on a worst-case turn. "Fail open" on
 *      a rate limiter guarding a paid API means a database outage removes the
 *      spend ceiling entirely, at precisely the moment nobody is watching.
 *   2. The failure it was protecting against is the *cheap* one. A visitor who
 *      cannot use the concierge during a Supabase outage is offered WhatsApp,
 *      which is the same escalation every other failure path offers. A bill
 *      run up during that outage cannot be handed back.
 *
 * The blast radius of the reversal is deliberately small: `consumeChatQuota`
 * has exactly one caller, `app/api/chat/route.ts`, so this changes Ask Wovenne
 * and nothing else in the shop. It is not a shared limiter.
 *
 * `allowed: false` with `resetAt: null` is the shape a caller already handles —
 * `quotaMessage(null)` returns the generic "reached the limit for now" line
 * plus the WhatsApp offer. The customer is not told a database is down, because
 * that is not their problem and not their business.
 */
export async function consumeChatQuota(caller: ChatCaller): Promise<QuotaResult> {
  const limit = caller.limit;
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc("chat_consume", {
      // Still called p_ip_hash in the database (migration 0019) and now carrying
      // either an address digest or a customer digest. Renaming the parameter
      // would mean a migration to change a word; the prefix in the key says
      // which it is.
      p_ip_hash: caller.key,
      p_limit: limit,
      p_window: `${QUOTA_WINDOW_HOURS} hours`,
    });

    if (error) {
      console.error("consumeChatQuota (failing closed):", error.message);
      return { allowed: false, remaining: 0, resetAt: null };
    }

    const row = data as { allowed: boolean; remaining: number; reset_at: string };
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      resetAt: row.reset_at ?? null,
    };
  } catch (e) {
    // Same verdict as an error result: a counter we cannot reach is a counter
    // that is not protecting anything.
    console.error("consumeChatQuota threw (failing closed):", e);
    return { allowed: false, remaining: 0, resetAt: null };
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
