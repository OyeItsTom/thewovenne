/**
 * Whose cart is this, and what should happen to it?
 *
 * The cart is persisted in localStorage, so it outlives a sign-out and is still
 * there for whoever uses the device next. This decides what to do about that.
 * It is pulled out of CartSync deliberately: it is the rule that stops one
 * customer's cart reaching another, and a rule that matters that much should be
 * readable on its own and testable without a browser.
 *
 * Pure. No storage, no network, no React.
 */

export interface CartDecision {
  /** Empty the cart before doing anything else. */
  clear: boolean;
  /** Who the cart belongs to afterwards. */
  claim: string | null;
  /** May the server-side cart be restored into it, if it ends up empty? */
  mayRestore: boolean;
  /** May local changes be uploaded for this owner? */
  mayUpload: boolean;
  /** Why — for the test names, and for anyone reading a decision later. */
  reason: string;
}

/**
 * @param storedOwner who the cart on this device says it belongs to (null = guest)
 * @param sessionUser who is signed in right now (null = nobody)
 */
export function decideCart(
  storedOwner: string | null,
  sessionUser: string | null
): CartDecision {
  if (sessionUser === null) {
    // A guest who was always a guest. Leave their cart alone — this runs on
    // every page load, and clearing here would mean a guest could never keep a
    // cart at all. Nothing is leaking: there is no identity attached to it.
    if (storedOwner === null) {
      return {
        clear: false,
        claim: null,
        mayRestore: false,
        mayUpload: false,
        reason: "guest, still a guest — leave it",
      };
    }

    // A CUSTOMER's cart with no session: they signed out. It goes, because the
    // next person to open this browser is not necessarily the last one.
    return {
      clear: true,
      claim: null,
      mayRestore: false,
      mayUpload: false,
      reason: "customer signed out — empty and disown",
    };
  }

  // A guest who was already shopping and has now signed in. Their cart is
  // theirs; taking it away at the login step would lose real work.
  if (storedOwner === null) {
    return {
      clear: false,
      claim: sessionUser,
      mayRestore: true,
      mayUpload: true,
      reason: "guest cart carried into their own session",
    };
  }

  // Their own cart, back again.
  if (storedOwner === sessionUser) {
    return {
      clear: false,
      claim: sessionUser,
      mayRestore: true,
      mayUpload: true,
      reason: "same customer — keep",
    };
  }

  // Someone else's. This is the case the whole module exists for: without it
  // the previous customer's items stay in the cart, block the new customer's
  // own cart from being restored, and are then uploaded to the new customer's
  // row by the sync — one person's cart silently becoming another's.
  return {
    clear: true,
    claim: sessionUser,
    mayRestore: true,
    mayUpload: true,
    reason: "different customer — empty, then restore theirs",
  };
}
