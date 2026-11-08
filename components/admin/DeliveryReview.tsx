"use client";

import { useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import { DEFAULT_SHIPPING, quoteShipping, type ShippingConfig } from "@/lib/shipping";
import type { Order } from "@/lib/orders";

/**
 * The delivery review an order needs after its PIN was corrected (OS-2b, 0079).
 *
 * The database opened the review and holds the order: it cannot be shipped or
 * marked delivered until this is recorded. Nothing here decides anything — the
 * screen collects what the admin checked and admin_decide_delivery_review
 * refuses an approval that is missing any of it. The charge the customer paid
 * is never changed; the published rate for the new PIN is shown so a
 * difference is seen, not silently absorbed.
 */
interface Review {
  id: number;
  status: "pending" | "approved" | "refused" | "superseded";
  trigger_kind: string;
  previous_pin: string | null;
  new_pin: string | null;
  order_state: string | null;
  charged_delivery_inr: number | null;
  listed_unserviceable_prefix: string | null;
  /** WP-09: States/UTs the new PIN's postal circle can belong to (first two digits). ADVISORY only (WP-09B). */
  pin_circle_states: string[] | null;
  decision_reason: string | null;
  decided_by_email: string | null;
  serviceability_source: string | null;
}

const MIN_REASON = 10;

export default function DeliveryReview({
  order,
  busy,
  onDone,
}: {
  order: Order;
  busy: boolean;
  onDone: (message: string | null, error: string | null) => Promise<void> | void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [shipping, setShipping] = useState<ShippingConfig>(DEFAULT_SHIPPING);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pinOk, setPinOk] = useState(false);
  const [stateOk, setStateOk] = useState(false);
  // WP-09B: typed from the lookup of the full PIN — never pre-filled with what
  // the customer typed, which is what it is checked against, not proof.
  const [verifiedPin, setVerifiedPin] = useState("");
  const [lookupSource, setLookupSource] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [circleNote, setCircleNote] = useState("");
  const [serviceable, setServiceable] = useState<"" | "yes" | "no">("");
  const [source, setSource] = useState("");
  const [reference, setReference] = useState("");
  const [courierCost, setCourierCost] = useState("");
  const [costOk, setCostOk] = useState(false);
  const [listedOk, setListedOk] = useState(false);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    const supabase = getBrowserSupabase();
    void (async () => {
      const { data, error } = await supabase
        .from("order_delivery_reviews")
        .select(
          "id, status, trigger_kind, previous_pin, new_pin, order_state, charged_delivery_inr, " +
            "listed_unserviceable_prefix, pin_circle_states, decision_reason, decided_by_email, serviceability_source"
        )
        .eq("order_id", order.id)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!live) return;
      if (error) setLoadError(error.message);
      else setReview((data as unknown as Review) ?? null);
      const { data: cfg } = await supabase.from("site_content").select("value").eq("key", "shipping").maybeSingle();
      if (live && cfg?.value) setShipping({ ...DEFAULT_SHIPPING, ...(cfg.value as object) } as ShippingConfig);
    })();
    return () => {
      live = false;
    };
  }, [order.id, order.delivery_hold]);

  if (!order.delivery_hold) return null;

  const goods = order.items.reduce((sum, i) => sum + Number(i.price_inr) * Number(i.quantity), 0);
  const pin = review?.new_pin ?? order.shipping_address?.postal_code ?? "";
  const published = quoteShipping({ postal_code: pin, country: "IN" }, goods, shipping).cost;
  const charged = Number(review?.charged_delivery_inr ?? order.shipping_cost_inr);
  const cost = courierCost.trim() === "" ? null : Number(courierCost);
  const reasonOk = reason.trim().length >= MIN_REASON;
  // WP-09B: the State comes from a lookup of the full six-digit PIN. A looked-up
  // State that differs from the order's is never approvable (the database
  // refuses it too): refuse and escalate. The two-digit circle table is only
  // advisory — when it disagrees or knows no circle, the order stays held
  // until a manual verification note is written.
  const pinDigits = String(pin).replace(/\D/g, "");
  const orderStateKey = stateKey(order.shipping_address?.state ?? "");
  const pinMatches = verifiedPin.replace(/\s/g, "") === pinDigits && /^[1-9][0-9]{5}$/.test(pinDigits);
  const crossState = state.trim() !== "" && orderStateKey !== "" && stateKey(state) !== orderStateKey;
  const circle = review?.pin_circle_states ?? null;
  const circleConcern = circle !== null && (circle.length === 0 || !circle.includes(orderStateKey));
  const noteOk = !circleConcern || circleNote.trim().length >= 20;
  const canApprove =
    review?.status === "pending" && !crossState && orderStateKey !== "" &&
    pinOk && pinMatches && lookupSource.trim().length >= 3 && noteOk &&
    stateOk && state.trim() !== "" && city.trim() !== "" &&
    serviceable === "yes" && source.trim().length >= 3 &&
    cost !== null && Number.isInteger(cost) && cost >= 0 && costOk &&
    (!review.listed_unserviceable_prefix || listedOk) && reasonOk;
  const canRefuse = review?.status === "pending" && reasonOk;

  async function decide(decision: "approve" | "refuse") {
    if (!review) return;
    setWorking(true);
    try {
      const { error } = await getBrowserSupabase().rpc("admin_decide_delivery_review", {
        p_review_id: review.id,
        p_decision: decision,
        p_evidence: {
          pin_verified: pinOk,
          verified_pin: verifiedPin.replace(/\s/g, ""),
          pin_lookup_source: lookupSource.trim(),
          state_city_verified: stateOk,
          verified_state: state.trim(),
          verified_city: city.trim(),
          circle_conflict_note: circleNote.trim(),
          // Unanswered is left out, not sent as null: a refusal need not answer it.
          ...(serviceable === "" ? {} : { serviceable: serviceable === "yes" }),
          serviceability_source: source.trim(),
          serviceability_reference: reference.trim(),
          published_rate_inr: published,
          courier_cost_estimate_inr: cost,
          cost_difference_reviewed: costOk,
          listed_exclusion_overridden: listedOk,
        },
        p_reason: reason.trim(),
      });
      if (error) throw new Error(error.message);
      await onDone(
        decision === "approve"
          ? "Delivery review approved: the hold is cleared and the order can be dispatched. Your checks and reason are kept with the order."
          : "Delivery review refused: the order stays held. Correct the address again, or escalate (cancel and re-order, or a separately approved correction).",
        null
      );
    } catch (e) {
      await onDone(null, e instanceof Error ? e.message : "That review was refused.");
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;

  return (
    <div className="mt-4 rounded-lg border border-terracotta/40 bg-linen/60 p-3 text-sm" data-testid="delivery-review">
      <h4 className="text-xs uppercase tracking-wider text-terracotta-dark">
        {order.delivery_hold === "refused" ? "Delivery refused — held" : "Held: delivery PIN changed"}
      </h4>
      {loadError && <p className="mt-2 text-xs text-terracotta-dark">{loadError}</p>}
      {review && (
        <p className="mt-2 text-xs text-ink/70">
          PIN {review.previous_pin ?? "—"} → <strong>{review.new_pin ?? "—"}</strong> · order State{" "}
          {review.order_state || "none"} · charged ₹{charged} · published rate for the new PIN ₹{published}
          {published !== charged && (
            <span className="text-terracotta-dark"> (difference ₹{published - charged}; the customer is not charged again)</span>
          )}
        </p>
      )}
      {review && circle && (
        <p className={`mt-1 text-xs ${circleConcern ? "text-terracotta-dark" : "text-ink/60"}`} data-testid="pin-circle">
          {circle.length === 0
            ? `The postal-circle table knows no circle for prefix ${String(review.new_pin ?? "").slice(0, 2)}. Look up the full PIN; approving needs a manual verification note.`
            : circleConcern
              ? `Prefix ${String(review.new_pin ?? "").slice(0, 2)} is usually ${circle.join(" / ")}, not ${order.shipping_address?.state || "no State"}. This is a rough table, not a decision: look up the full PIN. If it is in another State, refuse and escalate; if it is in ${order.shipping_address?.state || "the order's State"}, write what you checked in the manual verification note.`
              : `Prefix ${String(review.new_pin ?? "").slice(0, 2)} is usually ${circle.join(" / ")} (a rough check: two digits are a postal circle, not a State).`}
        </p>
      )}
      {review?.status === "pending" && crossState && (
        <p className="mt-1 text-xs text-terracotta-dark" data-testid="cross-state">
          The lookup puts PIN {pinDigits} in {state.trim()}, but the order is for {order.shipping_address?.state}. A delivery in
          another State is not approved here: refuse this review and escalate (cancel and re-order, or a separately approved
          correction). The charge and invoice stay as issued.
        </p>
      )}
      {review?.listed_unserviceable_prefix && (
        <p className="mt-1 text-xs text-terracotta-dark">
          This PIN matches &ldquo;{review.listed_unserviceable_prefix}&rdquo; in the &ldquo;we don&apos;t deliver here&rdquo; list.
        </p>
      )}
      {order.delivery_hold === "refused" && review?.status === "refused" && (
        <p className="mt-2 text-xs text-ink/70">
          Refused by {review.decided_by_email ?? "an admin"}: {review.decision_reason}. Correct the address again (a new
          review opens) or cancel the order.
        </p>
      )}
      {review?.status === "pending" && (
        <div className="mt-3 space-y-2">
          <Check label={`I checked PIN ${review.new_pin ?? ""} exists (India Post PIN search)`} value={pinOk} onChange={setPinOk} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Full PIN you looked up (all six digits)" value={verifiedPin} onChange={setVerifiedPin} />
            <Field label="Where you looked it up (e.g. India Post PIN search)" value={lookupSource} onChange={setLookupSource} />
            <Field label="State the lookup gives for that PIN" value={state} onChange={setState} />
            <Field label="City / post office the lookup gives" value={city} onChange={setCity} />
          </div>
          <Check label="The State and city above are what the lookup of the full PIN shows" value={stateOk} onChange={setStateOk} />
          {circleConcern && (
            <Field label="Manual verification note (required to approve, at least 20 characters: what record showed this PIN is in the order's State)"
              value={circleNote} onChange={setCircleNote} />
          )}
          <label className="block">
            <span className="text-xs font-medium text-ink/60">Does the courier deliver there?</span>
            <select value={serviceable} onChange={(e) => setServiceable(e.target.value as "" | "yes" | "no")}
              className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm">
              <option value="">Choose…</option>
              <option value="yes">Yes — serviceable</option>
              <option value="no">No — not serviceable</option>
            </select>
          </label>
          <Field label="Where you confirmed it (e.g. India Post PIN search, Speed Post counter)" value={source} onChange={setSource} />
          <Field label="Reference (optional: a link, a counter receipt, who you spoke to)" value={reference} onChange={setReference} />
          <Field label="Expected courier cost for the new PIN, ₹" value={courierCost} onChange={setCourierCost} />
          <Check label={`I reviewed the cost: charged ₹${charged}, published ₹${published}, courier ₹${cost ?? "?"}`} value={costOk} onChange={setCostOk} />
          {review.listed_unserviceable_prefix && (
            <Check label="The courier serves it despite the list entry (say so in the reason)" value={listedOk} onChange={setListedOk} />
          )}
          <Field label={`Reason (required, at least ${MIN_REASON} characters, kept with the order)`} value={reason} onChange={setReason} />
          <div className="flex gap-3">
            <button type="button" onClick={() => decide("approve")} disabled={disabled || !canApprove}
              className="rounded-full bg-ink px-4 py-2 text-xs text-cream disabled:opacity-40">
              Approve and clear the hold
            </button>
            <button type="button" onClick={() => decide("refuse")} disabled={disabled || !canRefuse}
              className="text-xs text-terracotta-dark hover:underline disabled:opacity-40">
              Refuse (stays held)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The same reduction as the database's indian_state_key (0079), for display only. */
function stateKey(raw: string): string {
  const k = raw.toLowerCase().replace(/&/g, " and ").replace(/[^a-z]+/g, " ").trim();
  const alias: Record<string, string> = {
    "new delhi": "delhi", "nct of delhi": "delhi", "delhi ncr": "delhi", orissa: "odisha",
    pondicherry: "puducherry", uttaranchal: "uttarakhand", "j and k": "jammu and kashmir",
    "jammu kashmir": "jammu and kashmir", "andaman and nicobar": "andaman and nicobar islands",
    "dadra and nagar haveli": "dadra and nagar haveli and daman and diu",
    "daman and diu": "dadra and nagar haveli and daman and diu",
  };
  return alias[k] ?? k;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-ink/60">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none" />
    </label>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-xs text-ink/80">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span>{label}</span>
    </label>
  );
}
