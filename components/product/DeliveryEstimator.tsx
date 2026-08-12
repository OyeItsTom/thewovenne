"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { formatINR } from "@/lib/utils";
import type { Country } from "@/lib/country";
import { postalLabel, postalIsNumeric, type DeliveryVerdict } from "@/lib/delivery";

/**
 * Where does this go, what does it cost, how long.
 *
 * NOT A MARKETPLACE WIDGET. A label, a field, a word, and one or two lines of
 * answer in the page's own type. No truck, no badge, no green tick, no coloured
 * panel. The most emphatic thing it is allowed to say is "Free delivery", and it
 * says that in the same ink as everything else.
 *
 * THE SERVER DECIDES EVERYTHING. This posts a postcode and renders what comes
 * back. It does not know the flat rate, the threshold or the zones, and cannot
 * be made to claim free delivery by editing anything in the browser — see
 * app/api/delivery/check. Checkout re-quotes regardless.
 *
 * THE LAST ANSWER IS REMEMBERED, but only the postcode, only in sessionStorage,
 * and only so somebody comparing three pieces does not retype it on each one.
 * It is gone when the tab closes. No cookie, no account, no tracking.
 */

const STORAGE_KEY = "wovenne-delivery-postal";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "answered"; verdict: DeliveryVerdict }
  | { kind: "error" };

export default function DeliveryEstimator({
  market,
  orderValueInr,
}: {
  market: Country;
  orderValueInr: number;
}) {
  const [postal, setPostal] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const label = postalLabel(market);
  const numeric = postalIsNumeric(market);

  // Restore the code, NOT the answer. Prices and zones can change between page
  // views, and a remembered verdict could be quietly stale; a remembered
  // postcode is just saved typing.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) setPostal(saved);
    } catch {
      // Private browsing can throw on sessionStorage. Not worth a word.
    }
  }, []);

  async function check(event: React.FormEvent) {
    event.preventDefault();
    if (!postal.trim() || state.kind === "checking") return;

    setState({ kind: "checking" });
    try {
      sessionStorage.setItem(STORAGE_KEY, postal);
    } catch {
      /* ignore */
    }

    try {
      const res = await fetch("/api/delivery/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, postalCode: postal, orderValueInr }),
      });
      if (!res.ok) throw new Error("bad response");
      setState({ kind: "answered", verdict: (await res.json()) as DeliveryVerdict });
    } catch {
      // A dropped connection is not the customer's problem to diagnose.
      setState({ kind: "error" });
    }
  }

  return (
    <div className="border-t border-ink/10 pt-5">
      <h3 className="font-heading text-sm uppercase tracking-wider text-ink/60">
        Delivery
      </h3>

      <form onSubmit={check} className="mt-3 flex gap-2">
        <label className="sr-only" htmlFor="delivery-postal">
          {label}
        </label>
        <input
          id="delivery-postal"
          value={postal}
          onChange={(e) => {
            setPostal(e.target.value);
            // A stale answer beside a changed code is worse than no answer.
            if (state.kind !== "idle") setState({ kind: "idle" });
          }}
          // A numeric keypad where the market's codes are digits, and an
          // autocomplete hint so a saved address can fill it. text-base keeps
          // it at 16px so iOS does not zoom the page on focus.
          inputMode={numeric ? "numeric" : "text"}
          autoComplete="postal-code"
          enterKeyHint="search"
          maxLength={12}
          placeholder={label}
          className="min-w-0 flex-1 rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-base text-ink placeholder:text-ink/35 focus:border-terracotta focus:outline-none sm:text-sm"
        />
        <button
          type="submit"
          disabled={state.kind === "checking" || !postal.trim()}
          className="shrink-0 rounded-lg border border-ink/15 px-4 py-2.5 text-xs uppercase tracking-wider text-ink transition-colors hover:border-terracotta hover:text-terracotta disabled:opacity-40"
        >
          {state.kind === "checking" ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            "Check"
          )}
        </button>
      </form>

      {/* aria-live so the answer is announced rather than silently appearing.
          min-h reserves the first line's height, so a result does not shove the
          Add to Bag button down the page as it arrives. */}
      <div
        aria-live="polite"
        className="mt-2.5 min-h-[1.5rem] text-sm leading-relaxed text-ink/70"
      >
        {state.kind === "checking" && <p>Checking…</p>}
        {state.kind === "error" && (
          <p>We could not check that just now. Delivery is confirmed at checkout.</p>
        )}
        {state.kind === "answered" && <Answer verdict={state.verdict} />}
      </div>
    </div>
  );
}

function Answer({ verdict }: { verdict: DeliveryVerdict }) {
  if (verdict.status === "invalid") {
    return <p>That does not look like a complete code. Please check and try again.</p>;
  }
  if (verdict.status === "unserviceable") {
    return <p>We do not currently deliver to this code.</p>;
  }
  if (verdict.status === "unavailable") {
    // The estimator was switched off between render and submit, or the rules
    // could not be read. Say the true thing rather than guessing a time.
    return <p>Delivery is calculated at checkout.</p>;
  }

  return (
    <div className="space-y-0.5">
      {verdict.days ? (
        <p>
          Delivery in {verdict.days.min}–{verdict.days.max} working days
        </p>
      ) : (
        verdict.fallbackNote && <p>{verdict.fallbackNote}</p>
      )}

      <p>
        {verdict.free ? (
          <span className="text-ink">Free delivery</span>
        ) : (
          <>{formatINR(verdict.cost)} delivery</>
        )}
      </p>

      {/* Only when it would change this order — resolveDelivery decides that,
          not this component. */}
      {verdict.freeAboveInr !== null && (
        <p className="text-ink/55">
          Free on orders over {formatINR(verdict.freeAboveInr)}.
        </p>
      )}
    </div>
  );
}
