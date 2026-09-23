import type { Metadata } from "next";

/**
 * Nothing about a completed order belongs in a search index.
 *
 * Follows /in/checkout and /in/checkout/pending, which have always carried
 * this. This page and its sibling /cancel were the two that did not — and
 * with no metadata of their own they served the homepage's exact title,
 * which is how a "thank you" page ends up competing with the shop front.
 *
 * In a layout rather than the page for the same reason as the cart: page.tsx
 * is a client component, and a client module cannot export metadata.
 */
export const metadata: Metadata = {
  title: "Order confirmed | THE WOVENNE",
  robots: { index: false, follow: false },
};

export default function CheckoutSuccessLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
