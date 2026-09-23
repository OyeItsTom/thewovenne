import type { Metadata } from "next";

/**
 * The other half of the checkout outcome pair — see ./../success/layout.tsx.
 * An abandoned payment is a private event, not a page.
 */
export const metadata: Metadata = {
  title: "Payment cancelled | THE WOVENNE",
  robots: { index: false, follow: false },
};

export default function CheckoutCancelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
