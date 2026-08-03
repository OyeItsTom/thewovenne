"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { setMarketingConsent } from "@/lib/customerAuth";
import AuthMessage from "./AuthMessage";

/**
 * The marketing opt-in, on and off.
 *
 * Saved on change rather than behind a Save button: a preference with an extra
 * step is a preference people set and then leave unsaved, and for consent the
 * recorded state must match what they actually chose.
 */
export default function MarketingPreference({ initial }: { initial: boolean }) {
  const [consent, setConsent] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setConsent(next);
    setBusy(true);
    setError(null);
    setSaved(false);

    const result = await setMarketingConsent(next);
    setBusy(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      // Put it back — a switch that stays flipped after a failed save is a lie
      // about what was recorded, and consent is the worst place for that.
      setConsent(!next);
      setError(result.error);
    }
  }

  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h2 className="font-heading text-xl text-ink">Email from us</h2>

      <label className="mt-4 flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(e) => toggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-terracotta"
        />
        <span className="text-ink/80">
          Send me updates and offers from THE WOVENNE.
          <span className="mt-1 block text-xs leading-relaxed text-ink/50">
            Off unless you turn it on, and you can turn it off again whenever you
            like. Order confirmations and delivery updates are sent either way —
            those are about orders you placed, not marketing.
          </span>
        </span>
      </label>

      <div className="mt-4 min-h-[1.5rem] text-sm">
        {busy && (
          <span className="inline-flex items-center gap-2 text-ink/50">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
          </span>
        )}
        {saved && !busy && <span className="text-ink/60">Saved.</span>}
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
      </div>
    </section>
  );
}
