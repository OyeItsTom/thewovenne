/**
 * When the product page's mobile sticky Add to Cart bar shows.
 *
 * Three facts, each reported by its own IntersectionObserver in
 * components/product/ProductOptions — no scroll listener, no pixel offsets:
 *
 *   ctaHasBeenSeen  the real Add to Cart has been on screen at least once, so a
 *                   bar never appears on a page that loaded scrolled past it.
 *   ctaVisible      the real Add to Cart is on screen now. The bar would only
 *                   duplicate it.
 *   footerVisible   any part of the site footer is on screen. The bar is about
 *                   this product; the footer is about the shop. Pinned over it,
 *                   the bar covered links and read as stuck (seen on an iPhone).
 *
 * Shown only between the two: below the purchase area, above the footer —
 * product details, care, reviews and recommendations. Scrolling back up out of
 * the footer brings it back; reaching the real button again hides it.
 *
 * No hysteresis is needed. The bar is position:fixed, so showing or hiding it
 * never moves the footer, and the observer only reports when the boundary is
 * crossed — there is no feedback loop to flicker on.
 */
export function showStickyCta({
  ctaHasBeenSeen,
  ctaVisible,
  footerVisible,
}: {
  ctaHasBeenSeen: boolean;
  ctaVisible: boolean;
  footerVisible: boolean;
}): boolean {
  return ctaHasBeenSeen && !ctaVisible && !footerVisible;
}

/**
 * The site footer, marked explicitly rather than found as "the first <footer>",
 * so an article or review that grows its own <footer> cannot take its place.
 */
export const SITE_FOOTER_SELECTOR = "[data-site-footer]";
