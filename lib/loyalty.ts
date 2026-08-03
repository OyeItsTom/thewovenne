import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "./supabase";

/**
 * Loyalty points.
 *
 * Every figure that decides money is computed in the database (migration 0029)
 * and read here. Nothing about a balance or a discount is ever taken from the
 * browser: a points balance the client can claim is a discount anyone can mint.
 */

export interface LoyaltySettings {
  enabled: boolean;
  points_per_inr: number;
  inr_per_point: number;
  min_redeem: number;
}

export interface LedgerEntry {
  id: string;
  points: number;
  reason: string;
  created_at: string;
  order_id: string | null;
}

export async function getLoyaltySettings(
  client: SupabaseClient
): Promise<LoyaltySettings> {
  const { data, error } = await client.rpc("loyalty_settings");
  if (error || !data) {
    return { enabled: false, points_per_inr: 1, inr_per_point: 0.25, min_redeem: 200 };
  }
  return data as LoyaltySettings;
}

/** The signed-in customer's own balance and history. RLS scopes both. */
export async function getMyLoyalty(
  client: SupabaseClient
): Promise<{ balance: number; entries: LedgerEntry[] }> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { balance: 0, entries: [] };

  const [{ data: balance }, { data: entries }] = await Promise.all([
    client.rpc("loyalty_balance", { p_user_id: user.id }),
    client
      .from("loyalty_ledger")
      .select("id, points, reason, created_at, order_id")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  return {
    balance: Number(balance ?? 0),
    entries: (entries as LedgerEntry[]) ?? [],
  };
}

/** What a number of points is worth, in whole rupees. */
export function pointsValue(points: number, settings: LoyaltySettings): number {
  return Math.floor(points * settings.inr_per_point);
}

export interface RedemptionPlan {
  points: number;
  discount: number;
  error: string | null;
}

/**
 * Work out what a customer may actually redeem against this order.
 *
 * Server-side only. Clamped to the goods total so points can never produce a
 * negative charge or pay for postage, and floored at zero.
 */
export async function planRedemption(
  email: string | null,
  requestedPoints: number,
  goodsTotal: number
): Promise<RedemptionPlan> {
  const none: RedemptionPlan = { points: 0, discount: 0, error: null };
  if (!email || !requestedPoints || requestedPoints <= 0) return none;

  const supabase = createServiceClient();
  const settings = await getLoyaltySettings(supabase);
  if (!settings.enabled) return none;

  // Points belong to an account; a guest has none to spend.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .eq("is_admin", false)
    .maybeSingle();
  if (!profile) return none;

  const { data: balanceRaw } = await supabase.rpc("loyalty_balance", {
    p_user_id: (profile as { id: string }).id,
  });
  const balance = Number(balanceRaw ?? 0);

  const points = Math.min(Math.floor(requestedPoints), balance);
  if (points < settings.min_redeem) {
    return {
      points: 0,
      discount: 0,
      error: `You need at least ${settings.min_redeem} points to redeem.`,
    };
  }

  // Never more than the goods are worth — points must not pay for delivery,
  // and a discount larger than the order would mean charging a negative amount.
  const discount = Math.min(pointsValue(points, settings), Math.floor(goodsTotal));
  if (discount <= 0) return none;

  return { points, discount, error: null };
}
