import { useSyncExternalStore } from "react";

/**
 * False for the server render and for the first client render while React
 * hydrates it; true immediately afterwards, and from the start on any render
 * that is not a hydration (a client-side navigation).
 *
 * WHY THE CART NEEDS IT. The cart store (lib/store.ts) is persisted to
 * localStorage, and zustand's persist rehydrates SYNCHRONOUSLY when the store is
 * created — so in the browser the very first render already holds the saved
 * items, while the server, which has no localStorage, rendered an empty cart.
 * Anything that printed cart contents during hydration therefore disagreed with
 * the server HTML: React threw #418 for each mismatch and #423 as it discarded
 * the whole document and re-rendered it on the client, on every page, for
 * anyone with something in their bag (and, depending on timing, #329 instead).
 *
 * Components that render cart-derived output read it through this: until
 * hydration is complete they render exactly what the server did, then React
 * re-renders them once with the real cart. The store itself, its persistence
 * and CartSync are untouched — only what is PRINTED during hydration waits.
 *
 * useSyncExternalStore rather than a mounted-flag effect: React uses the server
 * snapshot for the hydrating render and switches without a mismatch, and on a
 * client-side navigation it is true on the first render, so there is no blank
 * frame there.
 */
const subscribe = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
