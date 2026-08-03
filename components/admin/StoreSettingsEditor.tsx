"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { DEFAULT_SETTINGS, type StoreSettings } from "@/lib/storeSettings";

/**
 * Switches and thresholds that change how the shop behaves.
 *
 * Saved to BOTH value and draft_value, so they take effect immediately rather
 * than waiting for Publish — and so they never appear in the publish queue as a
 * pending change.
 *
 * That is deliberate, and the same reasoning as per-size stock: these are
 * operational, not editorial. A switch to hide the concierge is pressed because
 * something is wrong now, and one that needed a second click in another tab
 * would be a switch that does not work.
 */
export default function StoreSettingsEditor({ onChange }: { onChange?: () => void }) {
  const [settings, setSettings] = useState<StoreSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBrowserSupabase()
      .from("site_content")
      .select("value")
      .eq("key", "store_settings")
      .maybeSingle()
      .then(({ data }) => {
        if (data?.value) {
          setSettings({ ...DEFAULT_SETTINGS, ...(data.value as object) });
        }
        setLoading(false);
      });
  }, []);

  async function save(next: StoreSettings) {
    setSettings(next);
    setSaving(true);
    setError(null);
    setSaved(false);

    const { error: saveError } = await getBrowserSupabase()
      .from("site_content")
      .update({
        value: next,
        draft_value: next,
        updated_at: new Date().toISOString(),
      })
      .eq("key", "store_settings");

    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onChange?.();
  }

  const set = <K extends keyof StoreSettings>(key: K, value: StoreSettings[K]) =>
    save({ ...settings, [key]: value });

  if (loading) return <p className="text-ink/60">Loading settings…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-heading text-2xl text-ink">Store settings</h2>
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
        title="Ask Wovenne"
        hint="The concierge widget on the storefront. Switching it off also stops the endpoint answering, not just hiding the button."
      >
        <Toggle
          label="Show Ask Wovenne to customers"
          checked={settings.ask_wovenne_enabled}
          onChange={(v) => set("ask_wovenne_enabled", v)}
        />
      </Block>

      <Block
        title="VIP customers"
        hint="A customer counts as VIP at EITHER threshold. Orders alone would miss someone who bought one expensive piece; spend alone would miss a loyal repeat buyer of small ones."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Num
            label="Orders placed (at least)"
            value={settings.vip_min_orders}
            onChange={(v) => set("vip_min_orders", v)}
          />
          <Num
            label="Lifetime spend, ₹ (at least)"
            value={settings.vip_min_spend_inr}
            onChange={(v) => set("vip_min_spend_inr", v)}
          />
        </div>
      </Block>

      <Block
        title="Loyalty points"
        hint="Off until you turn it on. Nothing accrues and nothing can be redeemed while this is off."
      >
        <Toggle
          label="Enable loyalty points"
          checked={settings.loyalty_enabled}
          onChange={(v) => set("loyalty_enabled", v)}
        />
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Num
            label="Points earned per ₹1"
            value={settings.loyalty_points_per_inr}
            step="0.1"
            onChange={(v) => set("loyalty_points_per_inr", v)}
          />
          <Num
            label="₹ value per point"
            value={settings.loyalty_inr_per_point}
            step="0.05"
            onChange={(v) => set("loyalty_inr_per_point", v)}
          />
          <Num
            label="Minimum points to redeem"
            value={settings.loyalty_min_redeem}
            onChange={(v) => set("loyalty_min_redeem", v)}
          />
        </div>
        <p className="mt-3 text-xs text-ink/50">
          At these rates, ₹1,000 spent earns{" "}
          {Math.round(1000 * settings.loyalty_points_per_inr)} points, worth{" "}
          ₹{Math.round(1000 * settings.loyalty_points_per_inr * settings.loyalty_inr_per_point)}{" "}
          off a later order.
        </p>
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
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="text-xs font-medium text-ink/60">{label}</span>
      <input
        type="number"
        min="0"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
    </label>
  );
}
