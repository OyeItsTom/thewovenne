import type { Metadata } from "next";
import Link from "next/link";
import StatisticsChoice from "@/components/analytics/StatisticsChoice";
import { openGraph } from "@/lib/seo";
import { cPath } from "@/lib/country";

/**
 * Cookie Information & Consent — the page the Privacy Policy refers to.
 *
 * In code rather than in site_pages because it describes the code: every row
 * below names a real cookie or storage key, and the usage-statistics section
 * is the implementation in lib/analyticsClient, /api/events and migration 0068.
 * A test reads this file against those names, so the page cannot quietly
 * drift from what the site does. Plain statements of fact only — no legal
 * conclusions.
 */
export const metadata: Metadata = {
  title: "Cookies & usage statistics | THE WOVENNE",
  description:
    "The cookies and similar technologies THE WOVENNE website uses, the usage statistics we collect, and how to turn statistics off.",
  alternates: { canonical: cPath("/cookies") },
  openGraph: openGraph({ title: "Cookies & usage statistics | THE WOVENNE", path: cPath("/cookies") }),
};

const H2 = "mt-12 font-heading text-2xl text-ink first:mt-0 sm:text-3xl";
const P = "mt-5 text-base leading-relaxed text-ink/75";
const LIST = "mt-4 list-disc space-y-2 pl-5 text-base leading-relaxed text-ink/75";

const STORAGE: { name: string; what: string; kept: string }[] = [
  {
    name: "sb-…-auth-token (cookie)",
    what: "Keeps you signed in to your account. Set only when you sign in.",
    kept: "Until you sign out or the sign-in expires",
  },
  {
    name: "wovenne-cart (browser storage)",
    what: "Remembers what is in your bag between visits.",
    kept: "Until you empty your bag or sign out",
  },
  {
    name: "wovenne-payment-hold (browser storage)",
    what: "Stops the same payment being started twice while one is in progress.",
    kept: "Until that payment is confirmed or fails",
  },
  {
    name: "Delivery postcode (browser tab storage)",
    what: "Remembers the postcode you typed into the delivery estimate on a product page.",
    kept: "Until you close the tab",
  },
  {
    name: "wv_stats_off (cookie)",
    what: "Remembers that you turned usage statistics off. Holds only that choice.",
    kept: "1 year",
  },
  {
    name: "wv_admin_active, wv_internal (cookies); wovenne-export-columns (browser storage)",
    what: "Set only for THE WOVENNE staff who sign in to the store's administration: the admin sign-in's activity timer; a marker that keeps staff browsing out of our statistics; and the columns chosen for data exports.",
    kept: "17 minutes of inactivity; 1 year; until cleared",
  },
];

export default function CookiesPage() {
  return (
    <div className="container-wovenne section-padding">
      <div className="mx-auto max-w-prose text-center">
        <h1 className="font-heading text-display-sm text-ink md:text-display-md">
          Cookies &amp; usage statistics
        </h1>
        <p className="mt-6 text-base leading-relaxed text-ink/70">
          Cookie Information &amp; Consent. What this website stores on your device, the usage
          statistics we collect, and how to turn statistics off.
        </p>
        <p className="mt-3 text-sm text-ink/50">Last updated: 11/10/2026</p>
      </div>

      <div className="mx-auto mt-14 max-w-prose">
        <h2 className={H2}>1. What this website stores on your device</h2>
        <p className={P}>
          We use a small number of cookies and browser-storage entries, each for one job. None is
          used for advertising.
        </p>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm text-ink/75">
            <thead>
              <tr className="border-b border-ink/15 text-xs uppercase tracking-widest text-ink/50">
                <th className="py-2 pr-4 font-normal">Name</th>
                <th className="py-2 pr-4 font-normal">What it does</th>
                <th className="py-2 font-normal">How long</th>
              </tr>
            </thead>
            <tbody>
              {STORAGE.map((row) => (
                <tr key={row.name} className="border-b border-ink/10 align-top">
                  <td className="py-3 pr-4 font-medium text-ink">{row.name}</td>
                  <td className="py-3 pr-4">{row.what}</td>
                  <td className="py-3">{row.kept}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={P}>
          On the checkout page, Razorpay&rsquo;s payment window loads from Razorpay and may use its
          own cookies; see Razorpay&rsquo;s privacy notice. Product videos are embedded from youtube-nocookie.com
          and nothing from YouTube loads until you press play. If a page fails, a technical error report is sent to
          our error-monitoring provider, Sentry, so we can fix it.
        </p>

        <h2 className={H2}>2. Usage statistics</h2>
        <p className={P}>
          To understand how the shop is used and improve it, our own pages send short reports to
          our own server — without your name, your account or any identifier — when you:
        </p>
        <ul className={LIST}>
          <li>view a page or a product;</li>
          <li>submit a search (the words you searched, not what you type before searching);</li>
          <li>add or remove a wishlist or bag item, or reach checkout;</li>
          <li>tap a WhatsApp link.</li>
        </ul>
        <p className={P}>Each report can include:</p>
        <ul className={LIST}>
          <li>the page address, without anything after a &ldquo;?&rdquo;;</li>
          <li>
            the website you arrived from (its name only, such as instagram.com) and any campaign
            tags in the link you followed;
          </li>
          <li>a broad device type: mobile, tablet or desktop;</li>
          <li>
            an approximate country and region (for example, India / Kerala), worked out by our
            hosting provider from your connection. This can be wrong, for example on a VPN or
            some mobile networks.
          </li>
        </ul>
        <p className={P}>Our usage statistics do not use:</p>
        <ul className={LIST}>
          <li>an advertising tracker, or any tag from an advertising company;</li>
          <li>a cookie or other identifier that recognises you or your device between visits;</li>
          <li>browser fingerprinting;</li>
          <li>your IP address beyond the moment of the request (it is not stored);</li>
          <li>your exact or GPS location, or your city;</li>
          <li>your name, email address, phone number or account;</li>
          <li>any guess at your gender, age or other personal characteristics.</li>
        </ul>
        <p className={P}>
          Searches that look like an email address, a phone number or an order or reference
          number are recorded only as &ldquo;redacted&rdquo;.
        </p>
        <p className={P}>
          The reports are stored in our own database. Our hosting provider (Vercel) and database
          provider (Supabase) process them on our behalf; they are not shared with anyone else. We
          look at them as totals — for example, how many times a saree was viewed this week — not
          as a record of what any one person did. Individual reports are kept for up to 180 days; after
          that we keep only daily totals.
        </p>
        <p className={P}>
          When an online order is paid, we also count it from our order records. That count comes
          from the order itself, which we keep as a business record whether or not statistics are
          on.
        </p>

        <h2 className={H2}>3. Turning statistics off</h2>
        <p className={P}>
          You can turn usage statistics off for this browser here, free of charge, at any time.
          When they are off, our pages send no reports from this browser. If your browser sends a
          Global Privacy Control signal, we treat that as off too.
        </p>
        <div className="mt-6">
          <StatisticsChoice />
        </div>

        <h2 className={H2}>4. Changes</h2>
        <p className={P}>
          We do not currently use advertising or third-party analytics tags, such as Google
          Analytics, Google Ads or the Meta Pixel. If that changes, we will update this page before
          they are used.
        </p>

        <h2 className={H2}>5. Contact</h2>
        <p className={P}>
          Questions about cookies or statistics:{" "}
          <a href="mailto:hello@thewovenne.com" className="text-terracotta underline">
            hello@thewovenne.com
          </a>
          . See also our{" "}
          <Link href={cPath("/privacy-policy")} className="text-terracotta underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
