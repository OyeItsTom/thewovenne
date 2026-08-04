# THE WOVENNE — performance baseline

Measured 4 August 2026 against **production** (`www.thewovenne.com`), not
localhost. Lighthouse 12, headless Chrome, one run per page per form factor
unless noted. Mobile is Lighthouse's default throttling: 4× CPU slowdown and a
slow-4G network, which models a mid-range Android — the device most Indian
customers will actually use.

Re-run the same commands to compare after the next batch of features.

---

## The numbers

### Mobile

| Page | Perf | LCP | CLS | TBT | FCP |
|---|---|---|---|---|---|
| Homepage `/in` | **79** | 3.6 s | 0 | 390 ms | 1.1 s |
| Category `/in/women/sarees` | **78** | 4.7 s | 0 | 270 ms | 1.1 s |
| Product `/in/women/sarees/mul-cotton` | **88** | 3.4 s | 0 | 210 ms | 1.1 s |
| Cart `/in/cart` | **70** | 3.0 s | 0 | 1,250 ms | 1.0 s |

### Desktop

| Page | Perf | LCP | CLS | TBT | FCP |
|---|---|---|---|---|---|
| Homepage | **99** | 0.8 s | 0 | 20 ms | 0.3 s |
| Category | **99** | 0.8 s | 0.001 | 70 ms | 0.3 s |
| Product | **93** | 0.8 s | 0 | 210 ms | 0.3 s |
| Cart | **95** | 0.6 s | 0 | 180 ms | 0.3 s |

**Desktop is genuinely good and needs nothing.** Every problem below is a
mobile problem, and specifically a JavaScript problem — desktop has the CPU to
hide it.

**CLS is 0 or near-0 everywhere.** Image dimensions and reserved aspect ratios
are doing their job; nothing jumps as it loads. That is the one thing hardest
to fix retrospectively, and it is already right.

### Server response (TTFB), 5 cache-busted samples each

| Page | Avg TTFB |
|---|---|
| **Homepage `/in`** | **0.993 s** |
| Category | 0.130 s |
| Product | 0.082 s |
| Cart | 0.064 s |

---

## What is actually causing it

### 1. The homepage is uncached — 8–15× the TTFB of every other page

`app/(storefront)/in/page.tsx` sets `export const dynamic = "force-dynamic"`.
It was set deliberately, so the wishlist-based curated set could vary per
customer — a cached homepage would serve one person's recommendations to
everybody.

The cost is that **every homepage hit runs, server-side, before a byte is
sent**: a Supabase `getUser()` round trip, `getAllProducts()` with the category
tree, and three `getContent()` reads. Roughly a second, on the one page that
gets the most first-time visitors.

Every other page is cached (ISR) and answers in 60–130 ms. The contrast is
entirely explained by this one line.

### 2. framer-motion sits in the shared bundle, so every page pays for it

The same four JS chunks load on all four pages — about **260 KB transferred**,
87 KB of it the shared runtime. `framer-motion` is imported by **14
components**, and critically by ones the storefront layout mounts on *every*
page:

- `NavbarClient` — mega-menu and search panel
- `CartDrawer`
- `AskWovenne` — the floating chat widget
- `ProductCard` — every tile in every grid

Because they are always mounted, the animation library is in the common chunk
rather than a route chunk. Main-thread work is 2.1–3.2 s and JS execution
0.9–1.8 s across the four pages, and that is the bulk of it.

### 3. Cart is the worst page, and it varies

Three consecutive mobile runs: **70 / 86 / 64**, TBT **1,250 / 500 / 1,140 ms**.
Consistently the worst, but noisy — treat ~1,100 ms as the figure and do not
read much into any single run.

It has no large images and the least content. What it has is the most
always-mounted client JavaScript hydrating at once: cart state, `CartSync`,
`CartDrawer`, the nav, and the chat widget.

### 4. Images are fine — genuinely

Largest images are 191 KB (product), 117 KB (homepage hero), 48 KB (category
tiles). Every one goes through `next/image`; there is not a single raw `<img>`
in the codebase. The only `unoptimized` flag is on the admin MFA QR code, which
is an SVG data URI and correct.

**Do not spend time here.** This was the obvious suspect and it is already
right.

### 5. Sentry is already minimal

No replay integration (the expensive one), `tracesSampleRate` at 0.1. It
contributes to the bundle but is not worth touching.

---

## Recommendations, in priority order

### Worth doing now

**1. Make the homepage cacheable again.** Biggest single win, ~0.9 s off TTFB
for first-time visitors. The tension is real — it was made dynamic on purpose —
but the fix does not require giving up personalisation:

- Serve the homepage as ISR again, and render the curated set on the client
  after hydration for signed-in customers, or
- Keep it server-rendered but stream the curated section inside `<Suspense>` so
  the hero and lookbook flush immediately.

**This needs a decision, not just a patch**, because it trades a little
complexity for the speed. Worth knowing: the personalised branch cannot fire
today anyway — no two products share a colour, fabric or category — so right
now the page pays a second of TTFB to render exactly what a cached page would.

**2. Get framer-motion off the always-mounted path.** The nav's hover menu,
search panel and cart drawer are open/close transitions that CSS does
natively. Moving those three to CSS and lazy-loading `AskWovenne` would drop
the shared chunk substantially and cut TBT on every page, cart most of all.

This is the item that **gets harder every week**. It is 14 components today.

### Worth doing soon, not urgent

**3. Lazy-load the chat widget.** `AskWovenne` mounts on every page for a
button most visitors never press. `next/dynamic` with `ssr: false` is a
contained change.

**4. Category LCP of 4.7 s** is the worst LCP of the four, on the page type
customers browse most. Once the two items above land, re-measure before
chasing it — it is likely a symptom of main-thread contention rather than a
separate problem.

### Leave alone

- **Images.** Already optimised end to end.
- **CLS.** Zero. Do not touch the reserved aspect ratios.
- **Desktop.** 93–99 across the board.
- **Sentry.** Already configured lean.
- **TTFB on category, product and cart.** 60–130 ms is good.

---

## Architecture: what gets harder the longer it is left

Asked specifically in the context of more features and multi-country.

**1. framer-motion in the shared bundle — hardest to unpick later.** Every new
animated component deepens it. Fixing it at 14 usages is an afternoon; at 40 it
is a project. **This is the one to do before the next feature batch.**

**2. Nothing stops the bundle growing.** There is no size budget in CI, so the
first sign of a regression will be a customer complaint. A
`@next/bundle-analyzer` check, or simply failing the build over a First Load JS
ceiling, costs an hour now and never has to be argued about again.

**3. `getAllProducts()` loads the entire visible catalogue into memory** — both
`lib/search.ts` and `lib/curated.ts` do this, and it is fine at four products.
The ceiling is roughly a thousand. It was flagged when search was built; worth
restating because **multi-country multiplies it**: three markets each holding
the full catalogue per request is three times the memory and three times the
cold-start cost.

**4. Multi-country will make the homepage caching problem three times worse.**
An uncached homepage per market means three uncached homepages. Fixing it now
fixes it once; fixing it later means fixing it in three places with real
customers on all of them.

**5. Links are country-aware in one place, which is right.** `cPath()` and
`adminHref()` centralise it, so a second market is a config change rather than
a hunt through string literals. Nothing to do here — noting it because it is
the thing that usually goes wrong and it was handled.

---

## How to reproduce

```bash
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npx lighthouse https://www.thewovenne.com/in \
  --output=json --output-path=./home-mobile.json \
  --only-categories=performance \
  --chrome-flags="--headless=new"
# add --preset=desktop for the desktop figures
```

TTFB:

```bash
curl -s -o /dev/null -w "%{time_starttransfer}\n" \
  "https://www.thewovenne.com/in?cb=$RANDOM"
```


---

## Follow-up investigation — what was fixed, and five dead ends

Added after the baseline above. **Read this before chasing bundle size again.**

### Fixed and verified

**Homepage caching.** `force-dynamic` was costing 993 ms TTFB against 64–130 ms
elsewhere. Now `revalidate = 60`, static in the build output, with
personalisation moved to a post-paint client fetch. **993 ms → 19 ms.** This is
the only substantial win from the whole performance effort.

**ProductCard off framer-motion** (`lib/useReveal`). Category route 213 kB →
175 kB.

### The cart TBT diagnosis — solid, unfixed

Lighthouse per-script attribution on the cart page (TBT ~1,130 ms):

| Script | Execution |
|---|---|
| `1212-….js` | **1,155 ms** |
| document | 34 ms |
| webpack runtime | 71 ms |

All three longest tasks (662 / 152 / 127 ms) come from that one chunk. Fetched
from production it is **373 KB raw with 264 Sentry references**, and it loads on
**every page**. It contains `rrweb`, `replayIntegration` and `recordCanvas` —
Session Replay, which `sentry.client.config.ts` has never enabled.

So: the shop downloads and parses a session recorder it never runs, on every
page, costing about a second of main-thread time on a throttled phone.

### A methodology error worth not repeating

**Local builds and production builds chunk differently.** `next.config.mjs`
gates Sentry behind a DSN check, and chunk composition diverges between the two.
Several conclusions in this document's first half were drawn by comparing
production Lighthouse data against locally-built chunk contents. That is how
"Sentry is not on the critical path" was concluded — wrongly.

**Measure production against production.** Route sizes from `npm run build`
locally understate what customers actually receive.

### Dead ends — all tried, all reverted, none shipped

| Attempt | Result |
|---|---|
| `optimizePackageImports: ["lucide-react"]` | **Byte-identical.** Next 14.2 already includes lucide-react in its default list (`next/dist/server/config.js:577`). |
| Sentry `bundleSizeOptimizations` (`excludeReplay*`, `excludeDebugStatements`) | **Byte-identical chunk hashes.** Those flags strip Replay's sub-features; they do not stop Replay being imported. |
| Sentry explicit `integrations: [browserTracingIntegration()]` | **Byte-identical.** A runtime choice cannot remove code the bundler has already included. `rrweb` still present. |
| `CartDrawer` off framer-motion | Class toggled `translate-x-full → translate-x-0` while the computed transform stayed at 448px. **Drawer never opened.** Route size unchanged. |
| `CareAccordion` off framer-motion (grid-rows, then max-height) | Class toggled correctly, panel stayed at 0px in both states. **Content unreachable.** Route size unchanged. |

The two framer conversions passed typecheck, lint and build. Only opening them
in a browser caught them — and neither changed its route's bundle by a single
byte, so they were breaking working UI for nothing.

### What is actually left

Removing Replay from `@sentry/nextjs` is a **build-time inclusion** problem, and
there is no documented flag that removes it wholesale. The remaining options:

1. **Sentry's CDN loader script** — defers the SDK entirely. The only approach
   likely to work, at the cost of missing errors in the first moments of a page.
2. **Accept it.** Desktop is 93–99 and unaffected. This is a mobile CPU cost on
   pages customers reach with intent.

Option 1 is a real trade about error coverage, not a free win.

### Honest summary

Four hypotheses about the ~220 kB were tested and eliminated: Sentry (initially,
wrongly, dismissed), framer-motion (mattered only on the category route),
lucide-react (already optimised), and the Supabase client (never confirmed, and
absent from the homepage's critical chunks). The cause of cart TBT was found and
precisely located. It was not removed.
