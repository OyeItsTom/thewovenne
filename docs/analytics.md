# Wovenne analytics — design (Analytics 1A)

Wovenne records how the shop is used in **its own database**, without visitor
identifiers. This page is the reference for what is collected, how it is
switched on and off, and where future Google systems would plug in.

Code: `lib/analyticsClient.ts` (browser), `app/api/events/route.ts` +
`lib/analyticsIngest.ts` + `lib/analyticsCollect.ts` (collector),
`lib/analyticsPurchase.ts` (purchase), `supabase/migrations/0068_analytics_foundation.sql`,
`app/(storefront)/in/cookies/page.tsx` (public information + opt-out),
`scripts/analytics-switch.mjs` (the switch), `scripts/analytics-foundation.test.ts`.

## 1. On / off — one authority

| Layer | What it decides | Default |
|---|---|---|
| **`analytics_config.collecting`** (database) | Whether **anything** is written, from every source. Checked first inside `analytics_ingest()` and `analytics_record_purchase()`. Missing row = off. Only the database owner can change it (`node scripts/analytics-switch.mjs on/off/status`); no API role has any privilege on the table. | **off** |
| Deployment (`VERCEL_ENV`) | Only the production deployment asks the database to write. Previews and local builds never call it (they share the production database). `ANALYTICS_ALLOW_NONPROD=1` exists for a deliberate test and labels everything it writes `test`. | — |
| `NEXT_PUBLIC_ANALYTICS_ENABLED=1` (build) | Whether browsers send events at all. A performance switch, not a security one: with it off the browser sends nothing; with it on and the database switch off, events are dropped at the database. | off |

**Off means off:** with the database switch off, no row is written to
`analytics_events` or even `analytics_rate`, whatever the other two say.

## 2. What is collected

| Event | Emitted by | When | One event = |
|---|---|---|---|
| `page_view` | browser (layout tracker) | a distinct pathname is shown | one page shown; the first of a page load has `is_entry` |
| `product_view` | browser (`ProductDetail`) | product page shown | once per page view of that product |
| `search` | browser (search page) | a search was **submitted** | one results page; never keystrokes |
| `wishlist_add` / `_remove` | browser (`wishlistStore`) | after the database confirmed the change | one change |
| `cart_add` / `_remove` | browser (`lib/store`) | units actually added; line removed or stepped to 0 | one action, with quantity |
| `checkout_start` | browser (`CheckoutForm`) | checkout reached with items (after hydration) | once per page view |
| `whatsapp_click` | browser (delegated listener) | a WhatsApp link is clicked | one click |
| `purchase` | **server** (settlement) | an online order became paid, after Razorpay's API confirmed capture | one per order, ever |

Each event can carry: path (no query string), device class, approximate
country + first-level region, and the **attribution of its page load**. There is
no visitor id, session id, user id, IP, User-Agent, city, coordinates, email or
gender — the table has no column for any of them, and the migration refuses
to commit if one appears.

**Not available by design:** unique visitors, sessions, returning visitors,
cross-visit journeys. Reports must show these as "Not enabled", never estimate
them from page views.

## 3. Attribution

Read once per page load in the browser (memory only) and attached to every
event of that load; the server classifies it (`attributionFor`):

1. `utm_source` → that source, `utm_medium` as given;
2. `gclid`/`gbraid`/`wbraid` → google / cpc; `msclkid` → bing / cpc
   (the parameter **name** only; its value is never sent);
3. referrer is the shop itself → **unknown** (null), never "direct";
4. recognised referrer host → e.g. google / organic, instagram / social,
   webmail / email, chatgpt · perplexity · claude · gemini · copilot / referral
   — an AI assistant is named only when its own host is the referrer;
5. other host → other / referral (host kept);
6. nothing at all → direct / none (includes apps that strip referrers).

Stored: `source`, `medium`, `referrer_host`, `utm_source/medium/campaign/content/term`.
`utm_content` and `utm_term` exist for Google Ads (ad variant, keyword).

## 4. Geography

`country_code` + `region` from Vercel's `x-vercel-ip-country` /
`x-vercel-ip-country-region` (ISO 3166, e.g. IN / KL). City is available and
deliberately not read. Approximate: VPNs, carrier gateways, iCloud Private
Relay and corporate proxies move it; absent headers give null, never a guess.

Region reporting (1B/1C): product views, cart activity, searches and source
by region come straight from events. **Purchases by region** should use the
order's shipping state (the business fact), joined through `order_id`, and be
labelled as delivery region.

## 5. Staff, tests, bots

* `wv_internal=1` is set by middleware on any browser that completes an admin
  sign-in (1 year, survives sign-out). Its events are `traffic = 'internal'`.
* Purchases by a staff email are `internal`; Razorpay **test-key** payments and
  any non-production test are `test`.
* Reports count `traffic = 'customer'` only; `internal`/`test` stay visible in
  `analytics_diagnostics()` so verification can be checked.
* Bots, Lighthouse/PageSpeed, headless and automated browsers are dropped
  (User-Agent on the server, `navigator.webdriver` in the browser).
* Automated tests use a throwaway Postgres; scripts that touch production
  never call the analytics functions.

## 6. Privacy basis and opt-out

Collection relies on the UK PECR "statistical purposes" exception as described
in the ICO's guidance on storage and access technologies: sole purpose is
aggregate statistics to improve the service; clear information
(`/in/cookies`); a free, simple way to object that **stops** the collection;
not used to identify anyone; shared only with processors (Vercel, Supabase).
It must **never** be used for advertising — that would need consent.

Opt-out: the switch on `/in/cookies` sets `wv_stats_off=1` (1 year, holds only
the choice). The browser then sends nothing; the server also drops any request
carrying the cookie or `Sec-GPC: 1`. Global Privacy Control is honoured in
addition to the explicit control, not instead of it.

Purchases are counted from the order record regardless of opt-out: the order
is a business record kept anyway, and the event carries no customer data.

## 7. Retention and time

Raw events: 180 days (`analytics_purge(180)`; Wovenne's product decision, not
a legal figure). **Not scheduled yet — 1B must schedule it before the first
events are 180 days old.** Daily aggregates (1B): long term. Rate-limit rows:
minutes. Timestamps are UTC; business days are **Asia/Kolkata**.

## 8. Future integration points (not built)

**GA4 / Google Ads.** Advertising measurement is not covered by the statistics
exception and needs consent. When added: a separate consent banner + tag
loader, loaded only after consent; Wovenne's own events stay the source of
truth and are never fed to ad platforms. The authoritative conversion is the
`purchase` event / `order_id` — an Ads conversion (tag on the confirmation page
after consent, or an offline/enhanced-conversion upload) is derived from it,
not a second purchase model. UTM fields already match Google's names.

**Google Consent Mode.** Fits beside — not inside — `lib/analyticsClient`:
a consent module owning `ad_storage` / `analytics_storage` / `ad_user_data` /
`ad_personalization` states, which a future Google tag loader reads. The
first-party statistics keep their own control (`wv_stats_off`); a "reject all"
in a future banner should also set it.

**Consented visitor / session metrics.** Would be a new migration adding
identifiers under explicit consent. Not a flag on this design.

**Search + AI Discovery (separate work package).** Search Console (queries,
clicks, impressions, landing pages, any AI-feature reporting), robots and AI
crawler rules (e.g. OAI-SearchBot), structured data, merchant feeds,
content/entity quality. Analytics 1A changes none of crawlability, canonicals,
sitemap (one route added: `/in/cookies`), structured data or rendering, and
its referrer classification already distinguishes organic search and AI
assistants for that package to report on.

**Gender / demographics.** None, and none inferred. If ever useful: optional
self-declaration in the profile with a prefer-not-to-say option, aggregate
reporting only; Google Sign-In with minimum scopes only (no People API for
gender); any Google aggregate demographics stay in Google's reports.
