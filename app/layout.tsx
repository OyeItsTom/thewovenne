import type { Metadata } from "next";
import { Cormorant_Garamond, DM_Sans, Tiro_Devanagari_Hindi } from "next/font/google";
import "./globals.css";
import { openGraph } from "@/lib/seo";

const SITE_TITLE = "THE WOVENNE | Chosen piece by piece.";
/*
 * NO "WOVEN IN INDIA" HERE, and the reason is grammar rather than geography.
 *
 * This sentence lists three things, and one of them is jewellery. "Handloom
 * cotton" attaches to "sarees" — the noun beside it — but a trailing "Woven in
 * India" attaches to the whole list, which makes the site-wide description say
 * the necklaces are woven. India IS the right origin claim for the cloth; it is
 * simply not sayable in a sentence that also mentions metal.
 *
 * So the origin claim is left to the pages where it is scoped to cloth, and this
 * one states only what is true of everything listed: where it ships.
 */
const SITE_DESCRIPTION =
  "Handloom cotton sarees, clothing and jewellery from THE WOVENNE. Shipped across India.";

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

/**
 * THE SITE-WIDE FALLBACK, and only that. Every route worth indexing now names
 * its own title and description; what is here is what an unnamed route gets.
 *
 * THE DESCRIPTION IT REPLACES SAID "linen", "direct from the source" AND "for
 * the UK", and inherited down onto the homepage, which had no description of
 * its own. Three claims, none of them supportable: the catalogue is 31 cotton
 * pieces and 2 jewellery pieces with no linen anywhere in it, and the storefront
 * sells into India and nowhere else. Kerala is not the answer either —
 * documented provenance is mixed and most rows store no origin at all.
 *
 * THE STRAPLINE IS "Chosen piece by piece." — the owner's decision, replacing
 * "Woven in India. Worn for life.", which said every piece was woven on a site
 * that also sells jewellery. The new one is true of everything in the shop:
 * each piece is reviewed and chosen individually. It makes no claim of origin,
 * material or scarcity, and should not be edited into one.
 *
 * The openGraph block carries a TITLE AND DESCRIPTION now. Next 14.2.5 does not
 * fill those from the page's own — see lib/seo — so until this line the site
 * emitted og:image and og:site_name and no og:title anywhere at all.
 */
export const metadata: Metadata = {
  // Resolves relative OG/icon URLs to absolute ones for social crawlers.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://www.thewovenne.com"
  ),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: openGraph({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    // No path: this is the fallback for whatever route inherits it, and a
    // shared og:url would name the homepage on every one of them.
  }),
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
