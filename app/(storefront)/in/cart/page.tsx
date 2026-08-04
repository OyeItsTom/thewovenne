"use client";

import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { useCartStore } from "@/lib/store";
import { buttonClassName } from "@/components/ui/Button";
import CartItem from "@/components/cart/CartItem";
import CartSummary from "@/components/cart/CartSummary";

export default function CartPage() {
  const items = useCartStore((s) => s.items);

  return (
    <div className="container-wovenne section-padding">
      <h1 className="font-heading text-4xl text-ink sm:text-5xl">Your Cart</h1>

      {items.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center text-ink/60">
          <ShoppingBag className="mb-4 h-12 w-12" strokeWidth={1.5} />
          <p>Your bag is empty.</p>
          <Link
            href="/in/shop"
            className={buttonClassName("primary", "lg", "mt-6")}
          >
            Explore the Collection
          </Link>
        </div>
      ) : (
        <div className="mt-10 grid gap-12 lg:grid-cols-3 lg:gap-16">
          <div className="divide-y divide-ink/10 lg:col-span-2">
            {items.map((item) => (
              <CartItem key={`${item.id}-${item.size}`} item={item} />
            ))}
          </div>
          <div>
            <CartSummary />
          </div>
        </div>
      )}
    </div>
  );
}
