"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

/**
 * The search input itself, without the expanding-icon behaviour.
 *
 * A plain GET form to /search: it works before hydration, the results are
 * linkable and shareable, and the back button behaves. The nav wraps this in
 * the icon-expands interaction; the results page uses it bare.
 */
export default function SearchField({
  initialQuery = "",
  autoFocus = false,
  onSubmitted,
}: {
  initialQuery?: string;
  autoFocus?: boolean;
  onSubmitted?: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
    onSubmitted?.();
  }

  return (
    <form onSubmit={submit} role="search" className="relative">
      <label htmlFor="product-search" className="sr-only">
        Search products
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40"
      />
      <input
        id="product-search"
        type="search"
        name="q"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Linen, indigo, saree…"
        maxLength={120}
        className="w-full rounded-full border border-ink/15 bg-cream py-2.5 pl-10 pr-4 text-sm text-ink placeholder:text-ink/35 focus:border-terracotta focus:outline-none"
      />
    </form>
  );
}
