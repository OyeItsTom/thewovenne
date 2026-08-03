import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The admin's view of who buys from the shop.
 *
 * Unlike the analytics aggregates, this returns contact details — an admin
 * needs them to fulfil and support orders. Every read is logged to the audit
 * trail by admin_customers() (migration 0027), because looking at a customer
 * list is an act worth recording.
 */

export type Segment = "vip" | "regular" | "new" | "prospect";

export interface CustomerRow {
  email: string;
  name: string | null;
  has_account: boolean;
  marketing_consent: boolean;
  order_count: number;
  spend: number;
  wishlist_count: number;
  joined_at: string | null;
  first_order_at: string | null;
  last_order_at: string | null;
  segment: Segment;
}

export const SEGMENT_LABEL: Record<Segment, string> = {
  vip: "VIP",
  regular: "Regular",
  new: "New",
  prospect: "No orders yet",
};

export const SEGMENT_BLURB: Record<Segment, string> = {
  vip: "Past the order or spend threshold you set in Settings.",
  regular: "More than one order.",
  new: "Exactly one order so far.",
  prospect: "Has an account but hasn't bought anything yet.",
};

export async function getCustomers(client: SupabaseClient): Promise<CustomerRow[]> {
  const { data, error } = await client.rpc("admin_customers");
  if (error) {
    console.error("getCustomers:", error.message);
    return [];
  }
  return (data as CustomerRow[]) ?? [];
}

/**
 * Who may be sent marketing.
 *
 * The single place that answers this, so no screen can build its own idea of
 * eligibility. Requires an account AND an explicit opt-in: a guest has no
 * account and cannot have consented to anything, so a guest is never eligible
 * however much they have spent.
 */
export function marketable(rows: CustomerRow[]): CustomerRow[] {
  return rows.filter((r) => r.has_account && r.marketing_consent);
}
