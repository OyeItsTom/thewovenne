import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminProducts } from "./products";
import { metaFromProduct, type Diagnostics, type Grain, type ProductMeta, type Reconcile, type Report } from "./analyticsDashboard";

/**
 * Everything Admin Analytics reads, and the only place it reads from.
 *
 * Three database functions, all behind can_read_analytics() → the hardened
 * is_admin() (staff + aal2 + a live session, 0067), called with the signed-in
 * admin's own token — so the dashboard has no access of its own, and there is
 * no reporting endpoint to protect separately:
 *
 *   analytics_report(from, to, grain)   finished-day aggregates (1B)
 *   analytics_reconcile(day)            freshness, the nightly job, reconciliation
 *   analytics_diagnostics(from, to)     the collection switch and today's live
 *                                       count — always called for today only
 *
 * plus the admin product list, for each product's category and whether it is
 * live today.
 *
 * Every call THROWS on error. The old order dashboard turned a failed read into
 * an empty list; here an error must not be mistaken for "no customer activity".
 */
export interface AnalyticsSource {
  report<R = unknown>(from: string, to: string, grain: Grain): Promise<Report<R>>;
  reconcile(day: string): Promise<Reconcile>;
  diagnostics(from: Date, to: Date): Promise<Diagnostics>;
  products(): Promise<ProductMeta[]>;
}

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message);
  if (data === null || data === undefined) throw new Error(`${fn} returned nothing`);
  return data as T;
}

export function supabaseAnalyticsSource(client: SupabaseClient): AnalyticsSource {
  return {
    report: (from, to, grain) => rpc(client, "analytics_report", { p_from: from, p_to: to, p_grain: grain }),
    reconcile: (day) => rpc(client, "analytics_reconcile", { p_day: day }),
    diagnostics: (from, to) =>
      rpc(client, "analytics_diagnostics", { p_from: from.toISOString(), p_to: to.toISOString() }),
    products: async () => {
      const rows = await getAdminProducts(client, { onError: "throw" });
      return rows.map(metaFromProduct);
    },
  };
}
