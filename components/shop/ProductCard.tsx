"use client";

import { MouseEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Plus } from "lucide-react";
import type { Product } from "@/lib/types";
import { formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import { productHref } from "@/lib/urls";
import { fadeUp } from "@/lib/motion";
import { useCartStore } from "@/lib/store";
import Badge from "@/components/ui/Badge";

export default function ProductCard({ product }: { product: Product }) {
  const reduced = useReducedMotion();
  const addItem = useCartStore((s) => s.addItem);
  const openCart = useCartStore((s) => s.openCart);

  const outOfStock = product.stock_quantity <= 0;
  // The campaign price, so the card, the cart and the charge all agree. The
  // server re-resolves this at checkout regardless — see the checkout route.
  const { price, wasPrice } = effectivePrice(product);
  const lowStock = product.stock_quantity > 0 && product.stock_quantity <= 5;

  const handleQuickAdd = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    addItem({
      id: product.id,
      slug: product.slug,
      name: product.name,
      price_inr: price,
      image_url: product.image_url,
      size: "One Size",
    });
    openCart();
  };

  return (
    <motion.div
      variants={fadeUp(reduced)}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-50px" }}
      className="group"
    >
      <Link href={productHref(product)} className="block">
        <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-linen">
          {product.image_url && (
            <Image
              src={product.image_url}
              alt={product.name}
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
              className="object-cover transition-transform duration-700 group-hover:scale-105"
            />
          )}

          {outOfStock ? (
            <Badge tone="danger" className="absolute left-3 top-3">
              Out of Stock
            </Badge>
          ) : lowStock ? (
            <Badge tone="warning" className="absolute left-3 top-3">
              Only {product.stock_quantity} left
            </Badge>
          ) : null}

          {!outOfStock && (
            <button
              onClick={handleQuickAdd}
              aria-label={`Quick add ${product.name} to cart`}
              className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-cream text-ink opacity-0 shadow-soft transition-all duration-300 group-hover:opacity-100 hover:bg-terracotta hover:text-cream focus-visible:opacity-100"
            >
              <Plus className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="mt-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="font-heading text-lg leading-tight text-ink">
              {product.name}
            </h3>
            {product.category && (
              <p className="mt-0.5 text-xs uppercase tracking-wider text-ink/50">
                {product.category}
              </p>
            )}
          </div>
          <span className="flex items-baseline gap-2 whitespace-nowrap font-body text-sm font-medium">
            <span className="text-ink">{formatINR(price)}</span>
            {wasPrice != null && (
              <span className="text-xs font-normal text-ink/40 line-through">
                {formatINR(wasPrice)}
              </span>
            )}
          </span>
        </div>
      </Link>
    </motion.div>
  );
}
