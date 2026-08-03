import { create } from "zustand";
import { getBrowserSupabase } from "./supabase";

/**
 * The signed-in customer's saved products.
 *
 * Loaded once per page and shared, rather than each product card asking the
 * database whether it is saved — a grid of twenty would otherwise fire twenty
 * queries to render twenty hearts.
 *
 * Writes are optimistic. A heart that waits for a round trip feels broken, and
 * the cost of being wrong is that one item's state flickers back, which the
 * revert below handles.
 */

type ToggleResult = "added" | "removed" | "signin" | "error";

interface WishlistState {
  ids: Set<string>;
  loaded: boolean;
  signedIn: boolean;
  load: () => Promise<void>;
  toggle: (productId: string) => Promise<ToggleResult>;
}

export const useWishlistStore = create<WishlistState>((set, get) => ({
  ids: new Set(),
  loaded: false,
  signedIn: false,

  load: async () => {
    if (get().loaded) return;
    const supabase = getBrowserSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      set({ loaded: true, signedIn: false, ids: new Set() });
      return;
    }

    // RLS limits this to the caller's own rows, so no user_id filter is needed
    // — adding one would imply the policy were optional.
    const { data, error } = await supabase.from("wishlists").select("product_id");
    if (error) {
      console.error("wishlist load:", error.message);
      set({ loaded: true, signedIn: true });
      return;
    }
    set({
      loaded: true,
      signedIn: true,
      ids: new Set((data ?? []).map((r) => r.product_id as string)),
    });
  },

  toggle: async (productId: string) => {
    const { signedIn, ids, loaded } = get();
    if (!loaded) await get().load();
    if (!get().signedIn && !signedIn) return "signin";

    const saved = ids.has(productId);
    const next = new Set(ids);
    if (saved) next.delete(productId);
    else next.add(productId);
    set({ ids: next });

    const supabase = getBrowserSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      set({ ids, signedIn: false });
      return "signin";
    }

    const { error } = saved
      ? await supabase
          .from("wishlists")
          .delete()
          .eq("product_id", productId)
          .eq("user_id", user.id)
      : await supabase
          .from("wishlists")
          .insert({ product_id: productId, user_id: user.id });

    if (error) {
      // Put it back: a heart that stays filled after a failed save is a lie.
      console.error("wishlist toggle:", error.message);
      set({ ids });
      return "error";
    }
    return saved ? "removed" : "added";
  },
}));
