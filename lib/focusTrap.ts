/**
 * Keeping Tab inside a modal dialog.
 *
 * The decision is split from the DOM walk so it can be tested headlessly
 * (scripts/focus-trap.test.ts): given the dialog's focusable elements, where
 * focus is now, and which way Tab is going, where — if anywhere — must focus
 * be sent instead of letting the browser move it?
 */

/** Anything that can take focus from the keyboard. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog's Tab stops, in document order, walked fresh on every keypress:
 * forms inside a dialog add and remove fields while it is open. Elements with
 * no box (display:none, a collapsed section) are skipped — the browser would
 * skip them too, so treating one as "last" would let Tab fall out.
 */
export function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0
  );
}

/**
 * Where focus must go for this Tab press, or null to let the browser move it.
 *
 *   - No focusable content: hold focus on the dialog itself.
 *   - Focus outside the dialog (it should not be, but a click on a backdrop or
 *     a browser without `inert` can put it there): bring it back to the first
 *     or last stop, by direction.
 *   - Forward from the last stop: wrap to the first.
 *   - Backward from the first stop, or from the dialog container that holds
 *     focus on open: wrap to the last.
 *   - Anything else is an ordinary move between two stops inside the dialog,
 *     which the browser already gets right.
 */
export function nextTrapTarget<T>(
  focusable: readonly T[],
  active: unknown,
  container: T & { contains(other: never): boolean },
  backward: boolean
): T | null {
  if (focusable.length === 0) return container;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const inside =
    active === container ||
    (active != null && container.contains(active as never));

  if (!inside) return backward ? last : first;
  if (backward && (active === first || active === container)) return last;
  if (!backward && active === last) return first;
  return null;
}
