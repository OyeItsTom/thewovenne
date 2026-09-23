import type { Metadata } from "next";

/**
 * The cart's metadata.
 *
 * IN A LAYOUT BECAUSE THE PAGE IS A CLIENT COMPONENT. page.tsx opens with
 * "use client" — it reads the cart out of a browser store — and Next refuses a
 * `metadata` export from a client module. A layout is the server half of the
 * same route, so the directive lands on the page without the page having to
 * stop being interactive. The route itself is untouched.
 *
 * NOINDEX, FOLLOW. This page was both submitted in the sitemap and fully
 * indexable, and with no title of its own it inherited the root layout's —
 * so the shop was advertising a second page titled "THE WOVENNE | Woven in
 * India. Worn for life." to compete with its own homepage. There is nothing
 * here to index: it is empty for anyone who is not the visitor whose bag it is.
 *
 * FOLLOW, though, unlike checkout. A cart with something in it is a page full
 * of live product links, and there is no reason to tell a crawler to ignore
 * them.
 */
export const metadata: Metadata = {
  title: "Your Cart | THE WOVENNE",
  robots: { index: false, follow: true },
};

export default function CartLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
