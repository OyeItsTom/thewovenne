/**
 * Where the browser goes after Razorpay's checkout handler returns.
 *
 * WHY THIS IS A MODULE AND NOT AN IF-CHAIN IN THE FORM. The decision it makes
 * is the last safety rule in the payment path: everything before it refuses to
 * record a payment it cannot prove, and this decides what the person who just
 * paid is told about that. It used to live inside CheckoutForm's handler,
 * where it could not be tested without a browser, and it got the dangerous
 * case wrong — see below. A pure function can be exercised headlessly, one
 * outcome at a time, which is the only way "no pay button survives a payment"
 * is a fact rather than an intention.
 *
 * THE RULE THIS ENFORCES: a customer whose money MAY have moved is never shown
 * a way to pay again. Only two outcomes are allowed to leave that door open —
 * "settled", where the order is done, and "failed_payment", where Razorpay's
 * own API has said the payment failed, which is the one statement that
 * establishes no money was captured. Everything else, including everything
 * this file does not recognise, is a hold.
 *
 * NOTHING HERE DECIDES WHETHER A PAYMENT SUCCEEDED. lib/settleOrder does that
 * by asking Razorpay, and this reads its answer.
 */

/**
 * A state in which the customer must not be offered payment again.
 *
 * Five map one-to-one onto settlement outcomes. `unverified` does not: it is
 * the response whose SIGNATURE did not check out, which used to be treated as
 * "no payment was taken". It is not that, and the difference matters —
 * see resolvePaymentOutcome.
 */
export type PaymentHoldState =
  | "pending_capture"
  | "indeterminate"
  | "mismatch"
  | "refunded"
  | "unknown_status"
  | "unverified";

export type PaymentDestination =
  | { action: "success" }
  | { action: "cancel" }
  | { action: "hold"; state: PaymentHoldState };

export const PENDING_PATH = "/in/checkout/pending";

const HOLD_STATES: readonly PaymentHoldState[] = [
  "pending_capture",
  "indeterminate",
  "mismatch",
  "refunded",
  "unknown_status",
  "unverified",
];

/**
 * The verify route's answer, read defensively.
 *
 * It is parsed JSON from our own server, but the failure mode of assuming its
 * shape is "show a pay button to someone who has paid", so nothing is
 * assumed. An answer this cannot read is a hold, not a retry.
 */
export function resolvePaymentOutcome(verify: unknown): PaymentDestination {
  if (typeof verify !== "object" || verify === null) {
    return { action: "hold", state: "unverified" };
  }

  const body = verify as { verified?: unknown; outcome?: unknown };

  // A SIGNATURE THAT DOES NOT CHECK OUT IS NOT PROOF THAT NOBODY PAID.
  //
  // This branch used to send the customer to /in/checkout/cancel, which says
  // "No payment was taken" and offers the cart back. That sentence cannot be
  // supported: Razorpay's handler only fires AFTER a payment, and
  // verifyPaymentSignature returns false for a missing or rotated
  // RAZORPAY_KEY_SECRET exactly as it does for a forgery. Rotating that secret
  // is step one of Live activation, so the single most likely way to reach
  // here is a real payment during a key change — and the old behaviour would
  // have told that customer their money was safe and handed them a pay button.
  if (body.verified !== true) {
    return { action: "hold", state: "unverified" };
  }

  const outcome = typeof body.outcome === "string" ? body.outcome : null;

  // Captured, bound to the order, recorded. A recording problem after capture
  // is deliberately not a reason to withhold the confirmation — settleOrder
  // flags those for a human rather than telling a paying customer it failed.
  if (outcome === "settled") return { action: "success" };

  // The one outcome that establishes no money was captured: Razorpay's API
  // reports the payment itself as failed. Retrying is safe and correct.
  if (outcome === "failed_payment") return { action: "cancel" };

  if (HOLD_STATES.includes(outcome as PaymentHoldState)) {
    return { action: "hold", state: outcome as PaymentHoldState };
  }

  // An outcome this build does not know — a newer server, or a response that
  // is not what it claims. Treated as a status we cannot read, never a retry.
  return { action: "hold", state: "unknown_status" };
}

/**
 * Razorpay's ids are `order_`/`pay_` plus base62. Anything else is not one of
 * theirs and does not go in a URL: the reference is shown to the customer and
 * quoted to support, so it is worth nothing if it can carry something else.
 */
export function isSafeGatewayRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^[A-Za-z0-9_]{1,64}$/.test(ref);
}

/** The durable URL for a hold. The reference is dropped if it is not clean. */
export function holdHref(state: PaymentHoldState, ref: unknown): string {
  const params = new URLSearchParams({ state });
  if (isSafeGatewayRef(ref)) params.set("ref", ref);
  return `${PENDING_PATH}?${params.toString()}`;
}

/**
 * The state named in a URL, which anybody can type.
 *
 * An unreadable one falls back to `unknown_status` — the copy that asserts
 * least and still says not to pay again. It never falls back to a reassuring
 * state, because a hand-typed URL must not be able to produce "we have your
 * payment".
 */
export function parseHoldState(raw: unknown): PaymentHoldState {
  return HOLD_STATES.includes(raw as PaymentHoldState)
    ? (raw as PaymentHoldState)
    : "unknown_status";
}

export interface HoldCopy {
  /** "confirming" reassures; "uncertain" asks them to talk to us. */
  tone: "confirming" | "uncertain";
  title: string;
  body: string;
  /** What we are doing about it, or what we need from them. */
  next: string;
}

/**
 * One message per outcome, because they are genuinely different facts and a
 * customer who is told the vague version cannot tell whether to worry.
 *
 * Every one of them says not to pay again, and none of them names an action
 * that could start another charge. scripts/checkout-pending.test.ts asserts
 * both of those properties over this table rather than trusting the prose.
 */
export const HOLD_COPY: Record<PaymentHoldState, HoldCopy> = {
  pending_capture: {
    tone: "confirming",
    title: "Payment received",
    body:
      "Razorpay has your payment and is confirming it. This usually takes a few minutes, and nothing more is needed from you. Please do not pay again.",
    next: "Your confirmation email will arrive as soon as it clears. If nothing has arrived within an hour, message us with the reference below and we will find it.",
  },
  indeterminate: {
    tone: "uncertain",
    title: "Confirming your payment",
    body:
      "We could not reach Razorpay to confirm this payment just now, so we cannot yet tell you whether it went through. Please do not pay again — if it did, a second attempt would charge you twice.",
    next: "We keep checking on our side and will email you once we know. If you have heard nothing within an hour, message us with the reference below.",
  },
  mismatch: {
    tone: "uncertain",
    title: "This payment needs a look",
    body:
      "The payment Razorpay returned does not match this order, so we have not completed it. Nothing has been dispatched and no stock has been taken. Please do not pay again.",
    next: "Message us with the reference below and we will trace the payment and put it right by hand.",
  },
  refunded: {
    tone: "uncertain",
    title: "This payment was refunded",
    // NO TIMING PROMISE. It used to say "five to seven working days", which
    // nothing here can guarantee — the wait depends on the method and the
    // issuing bank, and a card refund, a UPI reversal and a netbanking return
    // are not the same journey. A number we cannot stand behind turns a
    // refund into a complaint on day eight.
    body:
      "Razorpay reports this payment as refunded, so the order has not been completed. If money did leave your account it is on its way back — how long it takes to appear depends on your bank and the method you paid with. Please do not pay again before we have spoken.",
    next: "Message us with the reference below and we will confirm what happened and how you would like to proceed.",
  },
  unknown_status: {
    tone: "uncertain",
    title: "We cannot confirm this payment",
    body:
      "Razorpay returned a status we cannot read, so we do not know whether this payment went through. Please do not pay again until we have checked.",
    next: "Message us with the reference below and we will confirm whether anything was taken.",
  },
  unverified: {
    tone: "uncertain",
    title: "We cannot confirm this payment",
    body:
      "We could not verify the confirmation that came back from Razorpay, so we cannot tell you whether your payment went through. Please do not pay again — assume it may have.",
    next: "Message us with the reference below and we will check the payment against Razorpay directly.",
  },
};

/**
 * What a hold says once its detail is too old to repeat.
 *
 * The block does not lift — see PAYMENT_HOLD_FRESH_MS — but the specific
 * claim does. "Razorpay has your payment and is confirming it" is a statement
 * about a moment; repeating it to someone three days later asserts something
 * nobody has checked since. This says only what is still true: we cannot
 * confirm it from here, do not pay again, talk to us.
 */
export const STALE_COPY: HoldCopy = {
  tone: "uncertain",
  title: "We cannot confirm this payment",
  body:
    "We can no longer automatically confirm what happened to this payment. Please do not make another payment — if the first one went through, a second would charge you twice.",
  next: "Message us with the reference below and we will check it against Razorpay directly and place your order by hand if it did go through.",
};

/** The copy a hold should actually show, given how old it is. */
export function holdCopyFor(state: PaymentHoldState, stale: boolean): HoldCopy {
  return stale ? STALE_COPY : HOLD_COPY[state];
}

/* ────────────────────────────────────────────────────────────────────────
   The hold itself
   ──────────────────────────────────────────────────────────────────────── */

export const PAYMENT_HOLD_KEY = "wovenne-payment-hold";

/**
 * How long the DETAIL of a hold is worth repeating. NOT how long it blocks.
 *
 * THIS IS THE CORRECTION THAT MATTERS. It was first written as a TTL after
 * which readPaymentHold returned null — which meant that two hours after a
 * payment we could not confirm, the Pay button came back on its own. Elapsed
 * time is not evidence. Nobody asked Razorpay anything in those two hours,
 * and the payment that could not be confirmed at 14:00 is exactly as
 * unconfirmed at 16:00; the only thing that changed is that the customer has
 * had longer to forget they already paid. That is the double payment this
 * whole path exists to prevent, just delayed.
 *
 * So the clock now governs WORDING ONLY. Past it, the hold is `stale`: the
 * specific claim is dropped for STALE_COPY, and the block stands.
 */
export const PAYMENT_HOLD_FRESH_MS = 2 * 60 * 60 * 1000;

export interface PaymentHold {
  state: PaymentHoldState;
  /** Razorpay's order id, or null if it was not usable. */
  ref: string | null;
  /** Epoch ms, for the freshness above. */
  at: number;
  /**
   * The detail is older than PAYMENT_HOLD_FRESH_MS and should not be
   * repeated. THE HOLD STILL BLOCKS — this flag chooses words, never access.
   */
  stale: boolean;
}

/**
 * ONLY AUTHORITATIVE EVIDENCE LIFTS A HOLD, and there are exactly two pieces
 * of it: a settlement, or Razorpay's own API reporting the payment failed.
 * Both arrive through clearPaymentHold in CheckoutForm. Nothing else does —
 * not a refresh, not a new tab, and above all not the passage of time.
 *
 * The cost is real and is accepted: a customer whose payment quietly failed in
 * a way we never got to hear about keeps a closed checkout in that browser
 * until they talk to us. That is the right side to be wrong on, and the
 * recovery already exists — the in-person order screen lets us place it by
 * hand once we have looked the payment up.
 *
 * localStorage, deliberately. It is the smallest thing that survives a refresh
 * AND a back-navigation, and it needs no new endpoint. The alternative —
 * looking the order up on the server by its reference — would mean an
 * unauthenticated route that says whether a given Razorpay order exists and
 * what state it is in, for guests who by definition have no session to check.
 * That is order enumeration with extra steps, and it buys nothing the customer
 * needs: they are being told to contact us, not to self-serve.
 *
 * Every access is wrapped: Safari in private mode throws on setItem, and a
 * checkout that crashed because it could not write a note to itself would be a
 * worse bug than the one this prevents.
 */
export function writePaymentHold(hold: Omit<PaymentHold, "stale">): void {
  try {
    const { state, ref, at } = hold;
    localStorage.setItem(PAYMENT_HOLD_KEY, JSON.stringify({ state, ref, at }));
  } catch {
    /* No durable hold. The in-page redirect still happened, and the pending
       page re-arms one when it finds none. */
  }
}

/**
 * The standing hold, or null only if there genuinely is not one.
 *
 * NULL MEANS "NO HOLD WAS EVER RECORDED, OR WHAT IS THERE IS NOT A HOLD". It
 * never means "there was one and it ran out". A record too old to quote comes
 * back with `stale: true`, still blocking.
 *
 * A stored record that cannot be read is treated as absent rather than as a
 * block: it is indistinguishable from an unrelated key, and refusing to sell
 * to someone because of a corrupt string is not a payment safety measure.
 */
export function readPaymentHold(now: number = Date.now()): PaymentHold | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PAYMENT_HOLD_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { state, ref, at } = parsed as Record<string, unknown>;
  if (!HOLD_STATES.includes(state as PaymentHoldState)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;

  return {
    state: state as PaymentHoldState,
    ref: isSafeGatewayRef(ref) ? ref : null,
    at,
    // A clock that has gone backwards reads as fresh rather than stale. Either
    // way it blocks; this only decides which words are used.
    stale: now - at > PAYMENT_HOLD_FRESH_MS,
  };
}

/**
 * Lift the hold. CALLED ONLY WITH AUTHORITATIVE EVIDENCE — a settled payment
 * or Razorpay reporting the payment failed. See CheckoutForm.
 */
export function clearPaymentHold(): void {
  try {
    localStorage.removeItem(PAYMENT_HOLD_KEY);
  } catch {
    /* Nothing to do. The hold stands, which is the safe direction. */
  }
}

/**
 * May this browser start a charge right now?
 *
 * THE ONE QUESTION THE PAY BUTTON MUST ASK. It lived inside CheckoutForm's
 * submit handler, where the only way to check it was to read the source and
 * hope; this repo has no DOM, no component renderer and no browser driver, so
 * "the guard runs before rzp.open()" was an assertion about text rather than
 * about behaviour. Out here it is executable, and the test exercises the case
 * that matters — a STALE hold still refuses — by calling it.
 *
 * Synchronous on purpose. CheckoutGate hides the form when a hold stands, but
 * only after its first effect has run, and a back-navigation renders the form
 * before then. This sits in front of the single action that can start a
 * charge, so no render timing can get past it.
 */
export type PayAttempt =
  | { allowed: true }
  /** Refused. `href` is where to send them instead — never back to a form. */
  | { allowed: false; href: string };

export function guardPayAttempt(now: number = Date.now()): PayAttempt {
  const held = readPaymentHold(now);
  if (!held) return { allowed: true };
  return { allowed: false, href: holdHref(held.state, held.ref) };
}
