"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Heart, Mail, MailX, RefreshCw, ShoppingBag } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";
import {
  getCustomers, marketable, SEGMENT_BLURB, SEGMENT_LABEL,
  type CustomerRow, type Segment,
} from "@/lib/customers";

/**
 * Who buys from the shop, and which of them may be emailed.
 *
 * Guests appear alongside account-holders: someone who has bought three times
 * without signing up is a real customer, and a list of account-holders only
 * would misrepresent the shop. But they are marked, and they can never be
 * marketed to — a guest has no account and cannot have consented.
 *
 * The consent filter is not a convenience. It is the thing that makes the
 * DPDP rule operable rather than merely recorded, which was the point of
 * capturing consent at all.
 */
export default function CustomersManager() {
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [segment, setSegment] = useState<Segment | "all">("all");
  const [consentOnly, setConsentOnly] = useState(false);

  const load = useCallback(async () => {
    setRows(await getCustomers(getBrowserSupabase()));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    let out = rows ?? [];
    if (segment !== "all") out = out.filter((r) => r.segment === segment);
    // Uses the shared helper rather than re-testing the fields here, so no
    // screen can invent its own idea of who is marketable.
    if (consentOnly) out = marketable(out);
    return out;
  }, [rows, segment, consentOnly]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows?.length ?? 0 };
    for (const r of rows ?? []) c[r.segment] = (c[r.segment] ?? 0) + 1;
    return c;
  }, [rows]);

  if (rows === null) return <p className="text-ink/60">Loading customers…</p>;

  const consented = marketable(rows).length;
  const guests = rows.filter((r) => !r.has_account).length;

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-ink/10 bg-linen/40 p-10 text-center">
        <p className="font-heading text-2xl text-ink">No customers yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink/60">
          Anyone who creates an account or places an order appears here, with
          their segment worked out from what they&apos;ve bought.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-heading text-2xl text-ink">
          {rows.length} customer{rows.length === 1 ? "" : "s"}
        </h2>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/50 hover:text-terracotta"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Can be emailed" value={String(consented)} hint="Account + opted in" />
        <Stat label="Guest checkouts" value={String(guests)} hint="No account — never marketable" />
        <Stat
          label="VIP"
          value={String(counts.vip ?? 0)}
          hint="Thresholds are in Settings"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "vip", "regular", "new", "prospect"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSegment(s)}
            className={
              segment === s
                ? "rounded-full bg-ink px-4 py-1.5 text-xs uppercase tracking-wider text-cream"
                : "rounded-full border border-ink/15 px-4 py-1.5 text-xs uppercase tracking-wider text-ink/60 hover:border-ink"
            }
          >
            {s === "all" ? "Everyone" : SEGMENT_LABEL[s]} ({counts[s] ?? 0})
          </button>
        ))}

        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={consentOnly}
            onChange={(e) => setConsentOnly(e.target.checked)}
            className="h-4 w-4 accent-terracotta"
          />
          <span className="text-ink/70">Only those who agreed to marketing</span>
        </label>
      </div>

      {segment !== "all" && (
        <p className="text-xs text-ink/50">{SEGMENT_BLURB[segment]}</p>
      )}

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-ink/50">
          {consentOnly
            ? "Nobody in this group has agreed to marketing email."
            : "Nobody in this group yet."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-cream">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-xs uppercase tracking-wider text-ink/50">
                <th className="px-5 py-3 font-medium">Customer</th>
                <th className="px-5 py-3 font-medium">Segment</th>
                <th className="px-5 py-3 text-right font-medium">Orders</th>
                <th className="px-5 py-3 text-right font-medium">Spend</th>
                <th className="px-5 py-3 text-center font-medium">Email OK</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.email} className="border-b border-ink/5 last:border-0">
                  <td className="px-5 py-3">
                    <span className="block text-ink">{r.name || r.email}</span>
                    {r.name && (
                      <span className="block text-xs text-ink/50">{r.email}</span>
                    )}
                    <span className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink/50">
                      {!r.has_account && (
                        <span className="inline-flex items-center gap-1">
                          <ShoppingBag className="h-3 w-3" /> guest
                        </span>
                      )}
                      {r.wishlist_count > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Heart className="h-3 w-3" /> {r.wishlist_count} saved
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="rounded-full bg-linen px-2.5 py-1 text-xs text-ink">
                      {SEGMENT_LABEL[r.segment]}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-ink/80">{r.order_count}</td>
                  <td className="px-5 py-3 text-right text-ink/80">
                    {formatINR(r.spend)}
                  </td>
                  <td className="px-5 py-3 text-center">
                    {r.has_account && r.marketing_consent ? (
                      <Mail className="mx-auto h-4 w-4 text-terracotta" aria-label="Agreed to marketing" />
                    ) : (
                      <MailX
                        className="mx-auto h-4 w-4 text-ink/25"
                        aria-label={r.has_account ? "Has not agreed" : "Guest — cannot be marketed to"}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="rounded-lg bg-linen/60 px-4 py-3 text-xs leading-relaxed text-ink/60">
        Marketing email may only go to customers with an account who have opted
        in — the tick above. Guests are never marketable, however much they have
        spent, because they have no account and were never asked. Order
        confirmations and delivery updates are separate: those concern an order
        someone placed, not marketing. Opening this page is recorded in the
        activity log.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-ink/10 bg-cream p-4">
      <p className="text-xs uppercase tracking-wider text-ink/50">{label}</p>
      <p className="mt-1 font-heading text-2xl text-ink">{value}</p>
      <p className="mt-0.5 text-xs text-ink/50">{hint}</p>
    </div>
  );
}
