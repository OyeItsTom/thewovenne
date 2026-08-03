"use client";

import { useEffect, useRef } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import { useCartStore, type CartItem } from "@/lib/store";

/**
 * Keeps a signed-in customer's cart on the server.
 *
 * Only when signed in. A guest's cart stays in their browser and is never
 * uploaded — catching guests would mean recording what signed-out visitors
 * browse, and they cannot be emailed anyway, so the reach given up is reach
 * that could not be acted on.
 *
 * Renders nothing.
 */
const DEBOUNCE_MS = 1500;

export default function CartSync() {
  const items = useCartStore((s) => s.items);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restored = useRef(false);

  // On sign-in, bring back what they left — but only into an EMPTY cart.
  // Merging would silently resurrect items someone had deliberately removed on
  // another device, and an item reappearing in a cart is worse than one lost.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;

    (async () => {
      const supabase = getBrowserSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      if (useCartStore.getState().items.length > 0) return;

      const { data } = await supabase
        .from("carts")
        .select("items")
        .eq("user_id", user.id)
        .maybeSingle();

      const saved = (data as { items?: CartItem[] } | null)?.items;
      if (Array.isArray(saved) && saved.length > 0) {
        useCartStore.setState({ items: saved });
      }
    })();
  }, []);

  // Push changes up, debounced — a quantity stepper would otherwise write on
  // every click.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const supabase = getBrowserSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

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
  }, [items]);

  return null;
}
