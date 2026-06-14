"use client";

import { cn } from "@/lib/utils";

export default function SizeSelector({
  sizes,
  selected,
  onSelect,
}: {
  sizes: string[];
  selected: string;
  onSelect: (size: string) => void;
}) {
  return (
    <div>
      <h3 className="font-heading text-sm uppercase tracking-wider text-ink/60">
        Size
      </h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {sizes.map((size) => (
          <button
            key={size}
            onClick={() => onSelect(size)}
            className={cn(
              "h-12 min-w-12 rounded-full border px-4 text-sm font-medium transition-colors",
              selected === size
                ? "border-ink bg-ink text-cream"
                : "border-ink/15 text-ink hover:border-ink"
            )}
          >
            {size}
          </button>
        ))}
      </div>
    </div>
  );
}
