import type { Metadata } from "next";
import { Cormorant_Garamond, DM_Sans, Tiro_Devanagari_Hindi } from "next/font/google";
import "./globals.css";

const heading = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-heading",
  display: "swap",
});

const body = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-body",
  display: "swap",
});

const script = Tiro_Devanagari_Hindi({
  subsets: ["latin", "devanagari"],
  weight: ["400"],
  variable: "--font-script",
  display: "swap",
});

export const metadata: Metadata = {
  // Resolves relative OG/icon URLs to absolute ones for social crawlers.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://www.thewovenne.com"
  ),
  title: "THE WOVENNE | Woven in India. Worn for life.",
  description:
    "Authentic handloom Indian linen, direct from the source. Premium, sustainable, body-friendly garments for the UK.",
  openGraph: {
    type: "website",
    siteName: "THE WOVENNE",
    // Square mark in a 1.91:1 slot — placeholder until a proper OG card exists.
    images: ["/logo_illustrated.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${heading.variable} ${body.variable} ${script.variable}`}
    >
      {/* Chrome lives in the route-group layouts: the storefront gets the
          navbar/footer/chat, the admin gets its own header. Putting it here
          meant /admin shipped the customer-facing nav, cart and chat widget. */}
      <body className="flex min-h-screen flex-col">{children}</body>
    </html>
  );
}
