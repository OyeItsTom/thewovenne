# Wovenne analytics — design (Analytics 1A + 1B)

Wovenne records how the shop is used in **its own database**, without visitor
identifiers. This page is the reference for what is collected, how it is
switched on and off, and where future Google systems would plug in.

Code: `lib/analyticsClient.ts` (browser), `app/api/events/route.ts` +
`lib/analyticsIngest.ts` + `lib/analyticsCollect.ts` (collector),
`lib/analyticsPurchase.ts` (purchase), `supabase/migrations/0068_analytics_foundation.sql`,
`app/(storefront)/in/cookies/page.tsx` (public information + opt-out),
`scripts/analytics-switch.mjs` (the switch), `scripts/analytics-foundation.test.ts`.
1B (daily aggregates, §9): `supabase/migrations/0069_analytics_daily.sql`,
`supabase/migrations/0070_analytics_schedule.sql`, `scripts/analytics-rollup.mjs`,
`scripts/analytics-aggregation.test.ts`.

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

Raw events: 180 days, then purged by whole IST day — and only for days whose
daily aggregates exist and still match the raw rows (§9.8). Daily aggregates:
long term. Rate-limit rows: minutes. Job log: 400 days. Timestamps are UTC;
business days are **Asia/Kolkata**.

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

## 9. Daily aggregates (Analytics 1B)

Raw events → verified daily aggregates → long-term reporting. Analytics 1C
reads **only** `analytics_report()` / `analytics_reconcile()`; it never scans
raw events.

### 9.1 The business day

A day `d` is `[d 00:00 IST, d+1 00:00 IST)` = `[d-1 18:30 UTC, d 18:30 UTC)`
(`analytics_day_start(d)`; India has no daylight saving, so every day is 24 h).
`occurred_at` is the time the server **received** the event (browser batches
flush within ~5 s, so an action at 23:59:58 may land on the next day) or, for
a purchase, when settlement recorded it. Nothing groups by a UTC date. A day is
rolled up only after it has ended; today is never in an aggregate.

### 9.2 Customer only

Aggregates count `traffic = 'customer'` only. Internal (staff browsers,
staff-email orders, the 1A verification events) and test (Razorpay test-key
payments, deliberate non-production tests) never enter a business total. Their
per-day counts are kept in `analytics_daily_runs`, and `analytics_reconcile`
shows customer / internal / test side by side.

### 9.3 Grains and metric definitions

`analytics_daily`: one row per (IST day, grain, event type, dimension values).
`events` = number of customer events; `units` = quantity (cart_add/remove:
units moved; purchase: units sold), else NULL; `entries` = page views that
were the first page of a page load (landings), else 0.

| Grain | Dimensions | Event types | Notes |
|---|---|---|---|
| total | — | all ten | the daily series |
| product | product_id, category_id (that day), product_name (at rollup) | product_view, wishlist_add/remove, cart_add/remove, purchase | purchase: `events` = orders containing the product, `units` = units sold, from the order's line snapshot |
| location | country_code, region | browser events | approximate (IP lookup); NULL = unknown |
| device | device | browser events | NULL = unknown |
| source | source, medium, campaign (utm_campaign), referrer_host | browser events | exactly as observed; NULL source = unknown |
| search | search_term, zero_results | search | stored term (normalised, redaction applied); zero_results NULL = count not captured |

Grains are never crossed (no product × region × source cube). Each grain sums
back to its event type's total — the reconciliation check. `utm_content`,
`utm_term` and `path` are not aggregated; they remain in raw events for 180
days. Not aggregated by design: checkout_start by product (a checkout is the
whole bag), purchases by IP location/device/source (purchases are recorded
server-side with no browser context and no identifier to link one).

| Metric | Exact definition |
|---|---|
| Page views | total.events, page_view |
| Landings | total.entries, page_view |
| Product views | total.events, product_view (per product: product grain) |
| Submitted searches | total.events, search (per term: search grain) |
| Zero-result searches | search grain rows with zero_results = true |
| Wishlist adds / removes | total.events, wishlist_add / wishlist_remove |
| Cart adds / removes | total.events (actions) and total.units (units), cart_add / cart_remove |
| Checkout starts | total.events, checkout_start |
| WhatsApp clicks | total.events, whatsapp_click |
| Purchases | total.events, purchase = customer online orders that became paid that day (one per order) |
| Units sold | total.units, purchase (per product: product grain units) |

### 9.4 Not available (and not estimated)

Unique visitors, sessions, returning visitors, per-person conversion, journeys:
there is no identifier. 1C shows them as "Not enabled". Nothing is derived
from event ids or the rate-limiter.

### 9.5 Funnel — an EVENT funnel

Product views → Cart adds → Checkout starts → Purchases, each a count of
events in the same IST date range. The same person viewing a product five
times is five product views. 1C may show ratios **only** as "per 100 events"
with these exact denominators and must label them as event ratios, not
conversion rates:

* cart adds per 100 product views = 100 × cart_add.events / product_view.events
  (site-wide, or per product from the product grain);
* checkout starts per 100 cart adds = 100 × checkout_start.events / cart_add.events (site-wide only);
* purchases per 100 checkout starts = 100 × purchase.events / checkout_start.events (site-wide only).

A step can exceed the one before it (several checkouts for one cart add,
purchases on a day after the views); 1C must not clamp or "fix" that.

### 9.6 Purchases and revenue

Purchases are the authoritative 0068 events (one per paid online order),
customer only. **No money is aggregated.** Revenue, goods/shipping split,
refunds and cancellations belong to the order system (0025's functions read
`orders`). While Razorpay is on **test keys every purchase is `test`**, so
customer purchases are 0 and no revenue is reportable from analytics. Real
revenue reporting starts at payment launch, from orders, not from these
aggregates. Purchases by region: the order's **delivery region** (shipping
state) is the authoritative business fact, and differs in meaning from the
IP-based **visitor region**; if 1C shows it, it reads it from orders and
labels it "delivery region". The two are never mixed in one figure.

### 9.7 Product history

Aggregates keep `product_id` without a foreign key, the category the product
had that day, and the name at rollup. Reports show the current name while the
product exists (`product_exists: true`) and the stored name after it is
deleted. Renames, unpublishing and category moves change nothing already
aggregated. (Products are archived, not deleted, in the admin; a hand-deleted
product loses its id from raw events — 0068's `on delete set null` — but not
from aggregates already rolled up.)

### 9.8 Rebuilds, late events, retention, the job

* `analytics_rollup_day(d)`: delete day d's aggregates and recompute them from
  raw, in one transaction — idempotent, deterministic, never incremental.
  Refuses an unfinished day and any day whose raw rows were purged.
* `analytics_nightly()` (pg_cron, 02:00 IST = 20:30 UTC, migration 0070):
  rebuild the last 3 finished days always, plus any day in the last 35 with no
  rollup or whose raw counts changed; then purge. A rollup failure is logged
  and **skips the purge**.
* `analytics_purge(180)`: oldest first, whole IST days strictly older than 180
  days, only when the day has a rollup whose recorded customer/internal/test
  counts equal the raw rows now and whose total grain equals the customer
  count. Otherwise skipped and reported. At most 7 days purged per run. The
  run row then records `raw_purged_at` and the aggregate is final.
* Owner only: rollup, nightly and purge are executable by no API role
  (not even service_role). Manual runs: `node scripts/analytics-rollup.mjs`.
* Observability: `analytics_job_log` (each run's result or error),
  `cron.job_run_details`, and `analytics_reconcile().last_jobs`.

### 9.9 Reading (the 1C contract)

* `analytics_report(from, to, grain)` — IST dates inclusive, ≤ 5 years.
  `total` returns one row per day and event type; other grains are summed over
  the range. Returns `covered_days` and `missing_days`: a day with no rollup is
  **unknown, not zero**. Customer only.
* `analytics_reconcile(day)` — the UTC window, raw counts per event type for
  customer / internal / test (while retained), the aggregate total, every
  grain's sum, `matches` per type and `all_match`, plus the last 5 job runs.
  Answers "why does it say 57 product views?".
* A covered day of zeros means no customer events were received. It can also
  mean collection was switched off: the switch keeps only its latest change
  (`analytics_config.changed_at`, shown by `analytics_diagnostics`), not a
  history, so 1C should show the switch state beside any zero.
* Both behind `can_read_analytics()` → hardened `is_admin()` (staff + aal2 +
  live session). Counts only; no event or order ids.

## 10. Admin Analytics V1 (1C)

Admin → Analytics (`/admin/dashboard/analytics`). One section, eight views:
Overview · Funnel · Products · Traffic sources · Geography · Devices · Search,
plus **Orders & stock** — the original 0025 order/revenue/stock dashboard,
unchanged, so revenue is reported in one place only. Pure rules:
`lib/analyticsDashboard.ts`; reads: `lib/analyticsDashboardSource.ts`;
UI: `components/admin/analytics/`; tests: `scripts/analytics-dashboard.test.ts`.

### 10.1 What it reads

* `analytics_report(from, to, grain)` for every finished-day figure — one call
  per view (+ one for the Overview comparison), cached per range until Refresh.
* `analytics_report(yesterday − 34, yesterday, 'total')` for "final figures
  through", and `analytics_reconcile(that day)` for the nightly job and
  reconciliation status.
* `analytics_diagnostics(today 00:00 IST, now)` for the collection switch and
  Today's provisional count — the only raw read, bounded to the current IST day
  (index range on `occurred_at`).
* The admin product list (`getAdminProducts`) for each product's current
  category and Live / Hidden / Never-published state.

No new endpoint, table or migration. Every call uses the signed-in admin's own
session, so the database's gate (`can_read_analytics()` → `is_admin()`: staff +
aal2 + live session) decides access; middleware and the dashboard layout gate
the page as before. Errors are shown as errors, never as zeros.

### 10.2 Ranges, Today and comparison

* **Yesterday / Last 7 days / Last 30 days / Custom** are finished IST days
  ending yesterday at the latest ("Last 7 days" = the 7 days before today).
  Custom: up to 366 days, end ≤ yesterday.
* **Today** is a provisional live count of today's customer events by type,
  labelled "so far today · provisional", on Overview and Funnel only. It is
  never added to a finished-day figure and never compared. Breakdowns for today
  say they arrive after the nightly run.
* Days with no rollup are **unknown, not zero**: the view says how many days
  are covered and where figures start; a range with none shows no numbers.
* **Comparison** = the immediately preceding period of equal length (Yesterday
  vs the day before; 7 vs previous 7; 30 vs previous 30; Custom likewise). Shown
  only when that period is fully processed; previous 0 → "New", both 0 → "—",
  never an infinite percentage. Direction is written in words (Up / Down).

### 10.3 Shown, and deliberately not shown

* Overview: page views, product views, searches, wishlist adds, cart adds (and
  units), checkout starts, purchases (and units sold), WhatsApp clicks; a daily
  trend with a table equivalent; a Data status panel (switch, final-figures-
  through, last nightly run, reconciliation, retention, customer / staff / test
  counts — the only place internal and test traffic appear).
* Funnel: the §9.5 event funnel with "per 100" ratios, unclamped; "—" for a
  zero denominator.
* Products: views, wishlist adds, cart adds, purchases (orders), units sold,
  cart adds per 100 views; category filter; optional zero-activity products;
  renamed (current name), hidden / never-published (marked), deleted (stored
  name, or "Deleted product (name not kept)" when deleted before its day was
  rolled up — 0068's `on delete set null` removes the id from raw rows).
* Traffic sources: by source (Unknown kept as its own line), campaigns
  (utm_campaign rows only) and referring websites. AI assistants appear only
  when observed. Purchases are not attributed to sources.
* Geography: country and first-level region, approximate, Unknown kept; no
  city. Visitor region, not delivery region.
* Devices: mobile / desktop / tablet / unknown.
* Search: top searches, searches that found nothing, and "% found nothing"
  over searches whose result count was captured. "(redacted)" stays redacted.
* **Not shown:** visitors, unique visitors, sessions, returning visitors,
  bounce rate, journeys (a one-line "not enabled" note says so); conversion
  rates; revenue, AOV, ROAS (revenue stays in Orders & stock; meaningful from
  the live payment launch). While Razorpay is on test keys a note explains
  that purchases read 0.
