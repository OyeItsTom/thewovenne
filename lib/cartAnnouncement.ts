/**
 * What a screen reader hears after Add to Cart.
 *
 * BEFORE: the drawer opened and announced "Your Bag, dialog" — nothing said
 * whether the piece had gone in, and a customer could not hear the difference
 * between a successful add and a merge that was capped at what is left.
 *
 * The sentence is built from what the cart ACTUALLY did, not what was asked
 * for: the store caps a line at the stock hint, so asking for three of a piece
 * with one left adds one, and asking again adds none. Saying "Added" in that
 * second case would be untrue.
 *
 * Read out as the cart drawer's accessible description (aria-describedby), so
 * it is spoken together with the dialog's name when focus lands on it. Nothing
 * on screen changes — the line itself is in the drawer for anyone sighted.
 */

/** Sizes that are not really a choice and would only add noise when spoken. */
const UNSIZED = new Set(["", "one size"]);

export function cartAddAnnouncement({
  name,
  size,
  added,
  inBag,
}: {
  name: string;
  size: string;
  /** How many units the cart actually gained — 0 when capped or refused. */
  added: number;
  /** Whether the bag holds this piece and size after the add. */
  inBag: boolean;
}): string {
  const sized = UNSIZED.has(size.trim().toLowerCase()) ? "" : `, size ${size.trim()}`;
  // "Added Zari Dhoti, size M, quantity 2, to your bag." — the details are a
  // parenthetical, so they close with a comma before the verb resumes.

  if (added <= 0) {
    // The button is disabled for a sold-out size, so this is a stale page —
    // but if it happens, the sentence must not claim a success.
    return inBag
      ? `${name}${sized}${sized ? "," : ""} is already in your bag at the most we have available.`
      : `${name}${sized}${sized ? "," : ""} could not be added — none are available.`;
  }
  const details = `${sized}${added > 1 ? `, quantity ${added}` : ""}`;
  return `Added ${name}${details}${details ? "," : ""} to your bag.`;
}
