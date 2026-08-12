"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import {
  DEFAULT_DELIVERY,
  type DeliveryConfig,
  type DeliveryZone,
} from "@/lib/delivery";
import { DEFAULT_SHIPPING, type ShippingConfig } from "@/lib/shipping";

/**
 * The delivery estimator's rules, in one place an operator can actually use.
 *
 * TWO KEYS, ONE SCREEN. Charges live in site_content.shipping because that is
 * what checkout already charges from, and times and zones live in
 * site_content.delivery. Splitting them was not a choice — moving the charge
 * fields would mean touching the money path — but the operator should not have
 * to know that, so both are edited here together.
 *
 * SHIPPING WAS NOT EDITABLE AT ALL BEFORE THIS. The flat rate, the free-delivery
 * threshold and the free regions could only be changed by writing JSON straight
 * into the database. That is the more significant half of this component.
 *
 * Immediate apply, matching StoreSettingsEditor: no draft state, no publish
 * step, a saving indicator and a confirmation. Delivery rules are operational
 * rather than editorial — when a courier changes its price you want it live, not
 * queued behind a publish.
 */

export default function DeliverySettingsEditor({ onChange }: { onChange?: () => void }) {
  const [delivery, setDelivery] = useState<DeliveryConfig>(DEFAULT_DELIVERY);
  const [shipping, setShipping] = useState<ShippingConfig>(DEFAULT_SHIPPING);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const db = getBrowserSupabase();
    Promise.all([
      db.from("site_content").select("value").eq("key", "delivery").maybeSingle(),
      db.from("site_content").select("value").eq("key", "shipping").maybeSingle(),
    ]).then(([d, s]) => {
      if (d.data?.value) setDelivery({ ...DEFAULT_DELIVERY, ...(d.data.value as object) });
      if (s.data?.value) setShipping({ ...DEFAULT_SHIPPING, ...(s.data.value as object) });
      setLoading(false);
    });
  }, []);

  async function persist(key: "delivery" | "shipping", value: unknown) {
    setSaving(true);
    setError(null);
    setSaved(false);

    const db = getBrowserSupabase();
    // Upsert rather than update: `delivery` may not have a row yet, and a
    // silent no-op update would look like a successful save.
    const { error: saveError } = await db
      .from("site_content")
      .upsert(
        { key, value, draft_value: value, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );

    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onChange?.();
  }

  const setD = <K extends keyof DeliveryConfig>(key: K, value: DeliveryConfig[K]) => {
    const next = { ...delivery, [key]: value };
    setDelivery(next);
    persist("delivery", next);
  };

  const setS = <K extends keyof ShippingConfig>(key: K, value: ShippingConfig[K]) => {
    const next = { ...shipping, [key]: value };
    setShipping(next);
    persist("shipping", next);
  };

  const setZone = (index: number, patch: Partial<DeliveryZone>) => {
    const zones = delivery.zones.map((z, i) => (i === index ? { ...z, ...patch } : z));
    setD("zones", zones);
  };

  if (loading) return <p className="text-ink/60">Loading delivery settings…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-heading text-2xl text-ink">Delivery</h2>
        <span className="text-xs text-ink/50">
          {saving ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </span>
          ) : saved ? (
            "Saved ✓"
          ) : (
            "Changes apply immediately"
          )}
        </span>
      </div>

      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      <Block
        title="Estimator"
        hint="The pincode check on the product page. Switching this off removes it from the page entirely and stops the endpoint answering — it is not merely hidden."
      >
        <div className="space-y-3">
          <Toggle
            label="Delivery estimator enabled"
            checked={delivery.estimator_enabled}
            onChange={(v) => setD("estimator_enabled", v)}
          />
          <Toggle
            label="Show it on product pages"
            checked={delivery.estimator_on_pdp}
            onChange={(v) => setD("estimator_on_pdp", v)}
          />
        </div>
      </Block>

      <Block
        title="What delivery costs"
        hint="These are the figures CHECKOUT CHARGES. The product page reads the same values, so the two cannot disagree. Free-delivery regions are matched on the start of a pincode — 67, 68, 69 covers Kerala."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Num
            label="Standard delivery charge, ₹"
            value={shipping.flat_rate_inr}
            onChange={(v) => setS("flat_rate_inr", v)}
          />
          <Num
            label="Free above this order value, ₹ (0 = never)"
            value={shipping.free_above_inr}
            onChange={(v) => setS("free_above_inr", v)}
          />
        </div>
        <div className="mt-4">
          <Csv
            label="Free-delivery pincode prefixes"
            hint="Comma separated. Anything starting with one of these delivers free."
            value={shipping.free_pin_prefixes}
            onChange={(v) => setS("free_pin_prefixes", v)}
          />
        </div>
      </Block>

      <Block
        title="How long delivery takes"
        hint="Working days, shown as a range. LEAVE AT 0 UNTIL YOU KNOW: with 0 the page shows your fallback wording instead of a number, which is better than a promise you cannot keep."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Num
            label="Default minimum days"
            value={delivery.default_min_days}
            onChange={(v) => setD("default_min_days", v)}
          />
          <Num
            label="Default maximum days"
            value={delivery.default_max_days}
            onChange={(v) => setD("default_max_days", v)}
          />
        </div>
        <div className="mt-4">
          <Text
            label="Wording when no time is known"
            value={delivery.fallback_note}
            onChange={(v) => setD("fallback_note", v)}
          />
        </div>
      </Block>

      <Block
        title="Regions with their own delivery time"
        hint="A zone overrides the default range for pincodes starting with its prefixes. The most specific prefix wins, so 682 beats 68."
      >
        <div className="space-y-4">
          {delivery.zones.length === 0 && (
            <p className="text-sm text-ink/50">
              No zones yet — every pincode uses the default range above.
            </p>
          )}

          {delivery.zones.map((zone, i) => (
            <div key={i} className="rounded-xl border border-ink/10 p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-3">
                  <Text
                    label="Zone name (for you, not customers)"
                    value={zone.name}
                    onChange={(v) => setZone(i, { name: v })}
                  />
                  <Csv
                    label="Pincode prefixes"
                    value={zone.prefixes}
                    onChange={(v) => setZone(i, { prefixes: v })}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Num
                      label="Minimum days"
                      value={zone.min_days}
                      onChange={(v) => setZone(i, { min_days: v })}
                    />
                    <Num
                      label="Maximum days"
                      value={zone.max_days}
                      onChange={(v) => setZone(i, { max_days: v })}
                    />
                  </div>
                </div>
                <button
                  onClick={() =>
                    setD("zones", delivery.zones.filter((_, idx) => idx !== i))
                  }
                  aria-label={`Remove zone ${zone.name || i + 1}`}
                  className="shrink-0 rounded-lg p-2 text-ink/40 transition-colors hover:bg-terracotta/10 hover:text-terracotta"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}

          <button
            onClick={() =>
              setD("zones", [
                ...delivery.zones,
                { name: "", prefixes: [], min_days: 0, max_days: 0 },
              ])
            }
            className="inline-flex items-center gap-2 rounded-lg border border-ink/15 px-4 py-2 text-sm text-ink transition-colors hover:border-terracotta hover:text-terracotta"
          >
            <Plus className="h-4 w-4" /> Add a zone
          </button>
        </div>
      </Block>

      <Block
        title="Places we do not deliver"
        hint="Checked before zones, so an excluded prefix inside a covered region is still refused. The customer is told plainly, with no charge or time shown."
      >
        <Csv
          label="Excluded pincode prefixes"
          value={delivery.unserviceable_prefixes}
          onChange={(v) => setD("unserviceable_prefixes", v)}
        />
      </Block>
    </div>
  );
}

function Block({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h3 className="font-heading text-xl text-ink">{title}</h3>
      {hint && <p className="mt-1 text-xs leading-relaxed text-ink/50">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-terracotta"
      />
      <span className="font-medium text-ink/80">{label}</span>
    </label>
  );
}

function Num({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-xs font-medium text-ink/60">{label}</span>
      <input
        type="number"
        min="0"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
    </label>
  );
}

function Text({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <label className="block text-sm">
      <span className="text-xs font-medium text-ink/60">{label}</span>
      <input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        // Saved on blur, not per keystroke: this writes straight to live
        // settings, and a save per character would be a write storm.
        onBlur={() => local !== value && onChange(local)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
    </label>
  );
}

function Csv({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [local, setLocal] = useState(value.join(", "));
  useEffect(() => setLocal(value.join(", ")), [value]);
  return (
    <label className="block text-sm">
      <span className="text-xs font-medium text-ink/60">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-ink/40">{hint}</span>}
      <input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() =>
          onChange(
            local
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
          )
        }
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 font-mono text-sm text-ink focus:border-terracotta focus:outline-none"
      />
    </label>
  );
}
