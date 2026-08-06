"use client";

import { useEffect, useRef, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import { useCartStore, type CartItem } from "@/lib/store";
import { decideCart } from "@/lib/cartOwner";

/**
 * Keeps a signed-in customer's cart on the server, and keeps the cart on this
 * device honest about whose it is.
 *
 * Only uploads when signed in. A guest's cart stays in their browser and is
 * never uploaded — catching guests would mean recording what signed-out
 * visitors browse, and they cannot be emailed anyway, so the reach given up is
 * reach that could not be acted on.
 *
 * THE SHARED-DEVICE RULE. The cart is persisted in localStorage, so it outlives
 * a sign-out. Reconciling it against the current session is what stops one
 * person's cart being handed to the next:
 *
 *   - signed out          → empty it and disown it
 *   - guest cart, sign in → keep it; they were shopping, and it is theirs
 *   - own cart            → keep it, and restore from the server if empty
 *   - SOMEONE ELSE's cart → empty it, then restore the new customer's own
 *
 * Renders nothing.
 */
const DEBOUNCE_MS = 1500;

export default function CartSync() {
  const items = useCartStore((s) => s.items);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Nothing may be uploaded until the cart has been reconciled against the
  // session. Without this the debounced upload races the reconcile and can
  // write the previous person's items into the new customer's row — which is
  // the leak, arriving by a different door.
  const [ownerResolved, setOwnerResolved] = useState(false);
  const syncingFor = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const supabase = getBrowserSupabase();

    /** Bring the local cart into line with whoever is signed in now. */
    async function reconcile(userId: string | null) {
      if (!active) return;
      const store = useCartStore.getState();
      const decision = decideCart(store.ownerId, userId);

      if (!decision.mayUpload) {
        // No session. A signed-out customer's cart is dropped so the next
        // person on this device starts empty; a guest who was never signed in
        // keeps theirs, because there is no identity on it to leak.
        if (decision.clear) store.resetForSignOut();
        syncingFor.current = null;
        setOwnerResolved(true);
        return;
      }

      // A cart that belongs to someone else has no business following them.
      if (decision.clear) useCartStore.setState({ items: [] });

      store.claimFor(decision.claim);
      syncingFor.current = userId;

      // Restore only into an EMPTY cart. Merging would silently resurrect items
      // someone had deliberately removed on another device, and an item
      // reappearing in a cart is worse than one lost. A guest cart carried in
      // at sign-in is theirs and wins for the same reason.
      if (decision.mayRestore && useCartStore.getState().items.length === 0) {
        const { data } = await supabase
          .from("carts")
          .select("items")
          .eq("user_id", userId)
          .maybeSingle();
        if (!active) return;

        const saved = (data as { items?: CartItem[] } | null)?.items;
        // Re-check the owner: an await elapsed, and they may have signed out
        // or switched accounts in another tab while it did.
        if (
          Array.isArray(saved) &&
          saved.length > 0 &&
          useCartStore.getState().ownerId === userId &&
          useCartStore.getState().items.length === 0
        ) {
          useCartStore.setState({ items: saved });
        }
      }

      setOwnerResolved(true);
    }

    supabase.auth.getUser().then(({ data }) => void reconcile(data.user?.id ?? null));

    // Sign-in, sign-out and account switches — including ones that happen in
    // another tab, which is exactly how a shared device gets used.
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      const userId = session?.user?.id ?? null;
      if (userId === syncingFor.current) return;
      setOwnerResolved(false);
      void reconcile(userId);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // Push changes up, debounced — a quantity stepper would otherwise write on
  // every click.
  useEffect(() => {
    if (!ownerResolved) return;
    const owner = syncingFor.current;
    if (!owner) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      // The session can change during the debounce. Upload for the customer
      // this cart was reconciled against, and only if that is still them.
      const supabase = getBrowserSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || user.id !== owner || syncingFor.current !== owner) return;

      const { error } = await supabase.from("carts").upsert(
        {
          user_id: user.id,
          items,
          // Set explicitly: this timestamp is what decides abandonment, so it
          // must move whenever the customer actually touches the cart.
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
      if (error) console.error("cart sync:", error.message);
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [items, ownerResolved]);

  return null;
}
