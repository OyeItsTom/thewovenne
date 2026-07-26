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
  addItem: (item: Omit<CartItem, "quantity">, quantity?: number) => void;
  removeItem: (id: string, size: string) => void;
  updateQuantity: (id: string, size: string, quantity: number) => void;
  clearCart: () => void;
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
      openCart: () => set({ isOpen: true }),
      closeCart: () => set({ isOpen: false }),
      toggleCart: () => set((state) => ({ isOpen: !state.isOpen })),
      subtotal: () =>
        get().items.reduce((sum, i) => sum + i.price_inr * i.quantity, 0),
      totalItems: () => get().items.reduce((sum, i) => sum + i.quantity, 0),
    }),
    { name: "wovenne-cart" }
  )
);
