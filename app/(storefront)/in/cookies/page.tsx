import type { Metadata } from "next";
import Link from "next/link";
import StatisticsChoice from "@/components/analytics/StatisticsChoice";
import { openGraph } from "@/lib/seo";
import { cPath } from "@/lib/country";

/**
 * Cookie Information & Usage Statistics — the page the Privacy Policy links to.
 *
 * In code rather than in site_pages because it describes the code: the
 * storage it lists is lib/store (bag), lib/paymentOutcome (payment hold),
 * DeliveryEstimator (postcode), the Supabase sign-in cookie and the
 * statistics opt-out (lib/analyticsCookies); the statistics section is
 * lib/analyticsClient, /api/events and migration 0068. Wording supplied by
 * Wovenne (11 Oct 2026); scripts/analytics-foundation.test.ts holds it to the
 * implementation.
 */
const TITLE = "Cookie Information & Usage Statistics | THE WOVENNE";

export const metadata: Metadata = {
  title: TITLE,
  description:
    "The browser storage THE WOVENNE uses, the limited usage statistics we collect, and how to turn statistics off.",
  alternates: { canonical: cPath("/cookies") },
  openGraph: openGraph({ title: TITLE, path: cPath("/cookies") }),
};

const H2 = "mt-12 font-heading text-2xl text-ink first:mt-0 sm:text-3xl";
const P = "mt-5 text-base leading-relaxed text-ink/75";
const LIST = "mt-4 list-disc space-y-2 pl-5 text-base leading-relaxed text-ink/75";

export default function CookiesPage() {
  return (
    <div className="container-wovenne section-padding">
      <div className="mx-auto max-w-prose text-center">
        <h1 className="font-heading text-display-sm text-ink md:text-display-md">
          Cookie Information &amp; Usage Statistics
        </h1>
        <p className="mt-3 text-sm text-ink/50">Last updated: 11/10/2026</p>
        <p className="mt-6 text-base leading-relaxed text-ink/70">
          We use a small amount of browser storage to make THE WOVENNE work properly and to
          understand, in a privacy-friendly way, how people use our website.
        </p>
      </div>

      <div className="mx-auto mt-14 max-w-prose">
        <h2 className={H2}>1. Cookies and browser storage</h2>
        <p className={P}>We may store information on your device to:</p>
        <ul className={LIST}>
          <li>keep you signed in to your account;</li>
          <li>remember items in your shopping bag;</li>
          <li>support checkout and prevent duplicate payment attempts;</li>
          <li>remember a delivery postcode during your visit;</li>
          <li>remember if you choose to turn usage statistics off.</li>
        </ul>
        <p className={P}>
          Some third-party services used on our website may also use their own cookies or storage.
          For example:
        </p>
        <ul className={LIST}>
          <li>Razorpay when you open the payment window;</li>
          <li>YouTube when you choose to play an embedded video;</li>
          <li>Sentry when a technical error needs to be reported so we can fix it.</li>
        </ul>
        <p className={P}>
          We do not currently use Google Analytics, Google Ads, Meta Pixel or other advertising
          trackers.
        </p>

        <h2 className={H2}>2. Usage statistics</h2>
        <p className={P}>
          We collect limited statistics to understand how the shop is used and improve the website.
        </p>
        <p className={P}>This may include:</p>
        <ul className={LIST}>
          <li>pages and products viewed;</li>
          <li>submitted searches;</li>
          <li>wishlist and shopping bag activity;</li>
          <li>reaching checkout;</li>
          <li>WhatsApp link clicks;</li>
          <li>where you came from, such as Google, Instagram or another website;</li>
          <li>campaign information included in a link;</li>
          <li>broad device type, such as mobile, tablet or desktop;</li>
          <li>approximate country and region.</li>
        </ul>
        <p className={P}>
          Approximate location is provided by our hosting service and may be inaccurate, for example
          when using a VPN, mobile network or private relay.
        </p>
        <p className={P}>We do not use these statistics to identify individual visitors.</p>
        <p className={P}>For these statistics, we do not collect or store:</p>
        <ul className={LIST}>
          <li>your name, email address or phone number;</li>
          <li>your account details;</li>
          <li>your exact location;</li>
          <li>your city;</li>
          <li>a persistent visitor identifier;</li>
          <li>browser fingerprints;</li>
          <li>guesses about your gender, age or other personal characteristics.</li>
        </ul>
        <p className={P}>
          Your IP address is used briefly to estimate approximate location and help prevent abuse,
          but the raw IP address is not stored.
        </p>
        <p className={P}>
          Submitted searches that appear to contain personal information, such as an email address,
          phone number or order/reference number, are recorded only as &ldquo;redacted&rdquo;.
        </p>

        <h2 className={H2}>3. How we use the information</h2>
        <p className={P}>We use these statistics only to understand and improve THE WOVENNE.</p>
        <p className={P}>For example, we may look at:</p>
        <ul className={LIST}>
          <li>which products are viewed most;</li>
          <li>which searches are popular;</li>
          <li>which regions generate more interest;</li>
          <li>which traffic sources bring people to the website;</li>
          <li>how often people move from product viewing to bag or checkout.</li>
        </ul>
        <p className={P}>
          The information is processed using our hosting and database providers, including Vercel
          and Supabase.
        </p>
        <p className={P}>
          Raw usage statistics may be kept for up to 180 days. Longer-term reporting may use
          aggregated daily totals.
        </p>
        <p className={P}>
          Paid orders are also counted from our order records. Order information is kept separately
          as part of our normal business records.
        </p>

        <h2 className={H2}>4. Turn usage statistics off</h2>
        <p className={P}>You can turn usage statistics off for this browser at any time.</p>
        <p className={P}>
          When turned off, our website will stop sending optional usage statistics from this
          browser. We also respect Global Privacy Control where supported.
        </p>
        <div className="mt-6">
          <StatisticsChoice />
        </div>

        <h2 className={H2}>5. Changes</h2>
        <p className={P}>
          If we later introduce services such as Google Analytics, Google Ads, Meta Pixel or other
          advertising or analytics technologies, we will update this page and the relevant privacy
          controls before they are used.
        </p>

        <h2 className={H2}>6. Contact</h2>
        <p className={P}>
          If you have questions about cookies or usage statistics, contact:{" "}
          <a href="mailto:hello@thewovenne.com" className="text-terracotta underline">
            hello@thewovenne.com
          </a>
        </p>
        <p className={P}>
          You can also read our{" "}
          <Link href={cPath("/privacy-policy")} className="text-terracotta underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
