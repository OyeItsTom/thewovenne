import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CartItem {
  id: string;
  slug: string;
  name: string;
  price_inr: number;
  image_url: string | null;
  size: string;
  quantity: number;
}

interface CartState {
  items: CartItem[];
  isOpen: boolean;
  /**
   * Who this cart belongs to — a user id, or null for a guest.
   *
   * Persisted alongside the items, and the whole reason this store is safe on a
   * shared device. The cart survives in localStorage by design, so without a
   * recorded owner there is nothing to compare a new session against and one
   * person's cart is simply handed to the next.
   */
  ownerId: string | null;
  addItem: (item: Omit<CartItem, "quantity">, quantity?: number) => void;
  removeItem: (id: string, size: string) => void;
  updateQuantity: (id: string, size: string, quantity: number) => void;
  clearCart: () => void;
  /** Empty the cart and disown it. Call on sign-out, never on a purchase. */
  resetForSignOut: () => void;
  /** Record who the current cart belongs to. */
  claimFor: (userId: string | null) => void;
  openCart: () => void;
  closeCart: () => void;
  toggleCart: () => void;
  subtotal: () => number;
  totalItems: () => number;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      isOpen: false,
      ownerId: null,
      addItem: (item, quantity = 1) =>
        set((state) => {
          const existing = state.items.find(
            (i) => i.id === item.id && i.size === item.size
          );
          if (existing) {
            return {
              items: state.items.map((i) =>
                i.id === item.id && i.size === item.size
                  ? { ...i, quantity: i.quantity + quantity }
                  : i
              ),
            };
          }
          return { items: [...state.items, { ...item, quantity }] };
        }),
      removeItem: (id, size) =>
        set((state) => ({
          items: state.items.filter(
            (i) => !(i.id === id && i.size === size)
          ),
        })),
      updateQuantity: (id, size, quantity) =>
        set((state) => ({
          items: state.items
            .map((i) =>
              i.id === id && i.size === size ? { ...i, quantity } : i
            )
            .filter((i) => i.quantity > 0),
        })),
      clearCart: () => set({ items: [] }),
      // Sign-out, and the handover point on a shared device. Drops the items
      // AND the owner, so the next person starts as a guest with an empty cart
      // rather than inheriting the last one's.
      resetForSignOut: () => set({ items: [], ownerId: null, isOpen: false }),
      claimFor: (userId) => set({ ownerId: userId }),
      openCart: () => set({ isOpen: true }),
      closeCart: () => set({ isOpen: false }),
      toggleCart: () => set((state) => ({ isOpen: !state.isOpen })),
      subtotal: () =>
        get().items.reduce((sum, i) => sum + i.price_inr * i.quantity, 0),
      totalItems: () => get().items.reduce((sum, i) => sum + i.quantity, 0),
    }),
    {
      name: "wovenne-cart",
      // Bumped when ownerId was introduced. Carts already sitting in
      // localStorage were written before anyone was tracking whose they were,
      // so there is no way to tell a customer's from the stranger's who used
      // the device before them. They are dropped rather than guessed at: this
      // is a privacy fix, and it should flush what is already out there.
      // The cost is one lost cart per device, once.
      version: 1,
      // Flushing the carts that are ALREADY on people's devices has to happen
      // here, in merge, and not in `migrate` — which is where it belongs and
      // where it does not work. zustand only calls migrate when the stored blob
      // carries a NUMERIC version field; carts written before this change have
      // no version at all, so it takes the "use as stored" branch and migrate
      // is never called for precisely the carts that need clearing. Verified in
      // a browser: with migrate alone, a pre-fix cart survived a reload.
      //
      // merge runs on every rehydrate, so the legacy shape can be caught by the
      // absence of ownerId. Those carts were written before anyone tracked
      // whose they were, so a customer's is indistinguishable from the
      // stranger's who used the device before them — they are dropped rather
      // than guessed at. One lost cart per device, once.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<CartState>;
        if (!("ownerId" in stored)) {
          return { ...current, items: [], ownerId: null };
        }
        return { ...current, ...stored };
      },
      // The drawer being open is view state, not the cart. Persisting it meant
      // a cart that was open when you closed the tab reopened itself on an
      // unrelated page days later.
      partialize: (state) => ({ items: state.items, ownerId: state.ownerId }),
      // Rehydration alone does not write back, so a flushed legacy cart would
      // stay readable in localStorage until the customer next touched
      // something — item names and prices sitting on a shared device after we
      // had decided to drop them. This forces the write immediately.
      onRehydrateStorage: () => (state) => {
        state?.claimFor(state.ownerId ?? null);
      },
    }
  )
);
