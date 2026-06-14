"use client";

import { useState } from "react";
import type { Product } from "@/lib/types";
import SizeSelector from "./SizeSelector";
import AddToCart from "./AddToCart";

const CLOTHING_SIZES = ["S", "M", "L", "XL"];
const ONE_SIZE = ["One Size"];

export default function ProductOptions({ product }: { product: Product }) {
  const sizes = product.category === "Home" ? ONE_SIZE : CLOTHING_SIZES;
  const [size, setSize] = useState(sizes[0]);

  return (
    <div className="space-y-6">
      <SizeSelector sizes={sizes} selected={size} onSelect={setSize} />
      <AddToCart product={product} size={size} />
    </div>
  );
}
