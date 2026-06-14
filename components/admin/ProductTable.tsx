"use client";

import Image from "next/image";
import type { Product } from "@/lib/types";
import { cn, formatGBP } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import StockEditor from "./StockEditor";

export default function ProductTable({
  products,
  onUpdate,
}: {
  products: Product[];
  onUpdate: (product: Product) => void;
}) {
  const updateProduct = async (product: Product, patch: Partial<Product>) => {
    const { data, error } = await supabase
      .from("products")
      .update(patch)
      .eq("id", product.id)
      .select()
      .single();

    if (!error && data) onUpdate(data as Product);
  };

  if (products.length === 0) {
    return (
      <p className="rounded-2xl bg-linen/60 p-8 text-center text-ink/60">
        No products yet. Add your first one above.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-ink/10">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-linen/60 text-xs uppercase tracking-wider text-ink/60">
          <tr>
            <th className="px-4 py-3">Product</th>
            <th className="px-4 py-3">Category</th>
            <th className="px-4 py-3">Price</th>
            <th className="px-4 py-3">Stock</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/10">
          {products.map((product) => (
            <tr key={product.id}>
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="relative h-12 w-10 shrink-0 overflow-hidden rounded bg-linen">
                    {product.image_url && (
                      <Image
                        src={product.image_url}
                        alt={product.name}
                        fill
                        sizes="40px"
                        className="object-cover"
                      />
                    )}
                  </div>
                  <span className="font-medium text-ink">{product.name}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-ink/70">
                {product.category ?? "—"}
              </td>
              <td className="px-4 py-3 text-ink/70">
                {formatGBP(product.price_gbp)}
              </td>
              <td className="px-4 py-3">
                <StockEditor
                  value={product.stock_quantity}
                  onSave={(value) =>
                    updateProduct(product, { stock_quantity: value })
                  }
                />
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() =>
                    updateProduct(product, { is_active: !product.is_active })
                  }
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider transition-colors",
                    product.is_active
                      ? "bg-gold/15 text-ink hover:bg-gold/25"
                      : "bg-ink text-cream hover:bg-ink-light"
                  )}
                >
                  {product.is_active ? "Active" : "Out of Stock"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
