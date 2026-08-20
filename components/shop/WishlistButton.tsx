"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWishlistStore } from "@/lib/wishlistStore";

/**
 * Save a product, or take it off the list.
 *
 * Shown to everyone, including signed-out visitors: hiding it would mean the
 * feature only exists for people who already know it exists. A guest who taps
 * it is sent to log in and returned here, rather than being told they can't.
 */
export default function WishlistButton({
  productId,
  productName,
  className,
  size = "md",
  appearance = "disc",
}: {
  productId: string;
  productName: string;
  className?: string;
  size?: "sm" | "md";
  appearance?: "disc" | "overlay";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const load = useWishlistStore((s) => s.load);
  const toggle = useWishlistStore((s) => s.toggle);
  const saved = useWishlistStore((s) => s.ids.has(productId));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleClick(e: React.MouseEvent) {
    // Product cards wrap this in a link to the product. Without these the tap
    // saves the item AND navigates away from the page you were browsing.
    e.preventDefault();
    e.stopPropagation();

    setBusy(true);
    const result = await toggle(productId);
    setBusy(false);

    if (result === "signin") {
      router.push(`/in/login?from=${encodeURIComponent(pathname)}`);
    }
  }

  const px = size === "sm" ? "h-8 w-8" : "h-10 w-10";
  const icon = size === "sm" ? "h-4 w-4" : "h-5 w-5";

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      aria-pressed={saved}
      aria-label={
        saved ? `Remove ${productName} from your wishlist` : `Save ${productName} to your wishlist`
      }
      title={saved ? "Saved" : "Save for later"}
      className={cn(
        // NO POSITIONING HERE. `cn()` is a plain join with no conflict
        // resolution (this project has no tailwind-merge), so a base `relative`
        // and a caller's `absolute` BOTH land in the class attribute — and
        // Tailwind emits `.relative` after `.absolute`, so the base silently
        // wins. On the product card that turned `right-2` into `left: -8px` and
        // hung the heart outside the photograph, where overflow-hidden clipped
        // it. Positioning is the caller's job; `tap-44` only needs SOME
        // positioned box, and every caller supplies one.
        "tap-44 flex items-center justify-center rounded-full transition-colors",
        appearance === "overlay"
          ? "bg-transparent text-white shadow-none [filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.8))]"
          : "bg-cream/90 text-ink shadow-soft backdrop-blur",
        "hover:text-terracotta disabled:opacity-60",
        px,
        className
      )}
    >
      <Heart
        className={cn(
          icon,
          "transition-all",
          saved &&
            (appearance === "overlay"
              ? "fill-white text-white"
              : "fill-terracotta text-terracotta")
        )}
        strokeWidth={1.5}
      />
    </button>
  );
}
