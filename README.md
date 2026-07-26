# THE WOVENNE

> Woven in India. Worn for life.

A premium, fullstack e-commerce site for **THE WOVENNE** — authentic handcrafted
Kerala handloom linen and natural-fibre clothing. Launching in **India first**,
priced in **₹ INR**, with a Razorpay checkout (UPI, GPay, cards). Built with
Next.js 14 (App Router), Tailwind CSS, Framer Motion, a signature HTML5 Canvas
weave animation, Supabase, an Anthropic-powered chat concierge, and Sentry.

## The signature — the woven animation

The brand's identity is the act of **weaving**. It runs through the site in
three layers, all with `prefers-reduced-motion` and low-power fallbacks:

1. **Hero weave** — a full-width Canvas of warp + weft threads that interlace
   into place on load, then the hero content fades in.
2. **Scroll-driven seams** — section dividers are woven in real time as you
   scroll (SVG `stroke-dashoffset` driven by scroll progress).
3. **Interactive weave** — the hero and the product image gently distort under
   your pointer/touch, like a hand across cloth. The order-success page finishes
   with a woven checkmark.

Low-power / small-screen devices get a lightweight CSS weave instead of the
Canvas; reduced-motion users get a static woven pattern.

## Tech stack

- **Framework**: Next.js 14 (App Router, TypeScript)
- **Styling**: Tailwind CSS v3 (custom brand theme, editorial type scale, weave textures)
- **Animation**: Framer Motion + HTML5 Canvas (vanilla), reduced-motion aware throughout
- **State**: Zustand (cart, persisted to `localStorage`)
- **Database / Auth / Storage**: Supabase (Postgres + RLS + Auth + Storage)
- **Payments**: **Razorpay** (India — UPI, GPay, cards). PayPal is scaffolded-off for a future UK launch.
- **AI concierge**: Anthropic API (`claude-sonnet-5`) — "Ask Wovenne", replies in English or Malayalam
- **Error monitoring**: Sentry (`@sentry/nextjs`)
- **Icons**: Lucide

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the
   `products`, `orders`, `site_content`, and `journal_posts` tables, sets up Row
   Level Security, creates the public **`product-images`** Storage bucket (for
   admin image uploads) with its policies, and seeds 10 sample products plus
   default homepage/journal content.
3. **Authentication → Users → Add user** — create your admin (email + password).
   This is the account you log in with at `/admin`.
4. **Project Settings → API** — copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server-side only — keep secret)

> Re-running `schema.sql` later is safe — it uses `if not exists` /
> `on conflict do nothing` and drop-then-create for Storage policies.

### 3. Set up Razorpay (checkout)

1. Create an account at [razorpay.com](https://razorpay.com) (test mode is fine).
2. **Settings → API Keys** → generate a key pair:
   - `Key Id` → `RAZORPAY_KEY_ID` **and** `NEXT_PUBLIC_RAZORPAY_KEY_ID`
   - `Key Secret` → `RAZORPAY_KEY_SECRET`

Checkout charges in **INR**. Your Razorpay account must be INR-enabled (the
default for an India-registered account).

### 4. Set up the AI concierge (Anthropic)

1. Get a key at [console.anthropic.com](https://console.anthropic.com) → **API Keys**.
2. Set `ANTHROPIC_API_KEY` (server-side only — never exposed to the browser).

The "Ask Wovenne" widget answers product, shipping, and order questions in
English or Malayalam. Without this key the widget shows a graceful "unavailable"
message; the rest of the site works normally.

### 5. Set up Sentry (optional but recommended)

1. Create a project at [sentry.io](https://sentry.io) (Next.js platform).
2. Copy the **DSN** → both `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`.
3. (Optional) for source-map upload on deploy, set `SENTRY_ORG`, `SENTRY_PROJECT`,
   and a `SENTRY_AUTH_TOKEN` in the build environment.

Without a DSN, Sentry is a no-op. Verify capture with the **"Trigger test error"**
button in the admin dashboard.

### 6. WhatsApp

- `NEXT_PUBLIC_WHATSAPP_NUMBER` — your WhatsApp Business number, digits only,
  international format (e.g. `919000000000`). Powers the floating button and the
  concierge's "Continue on WhatsApp" hand-off.
- `WHATSAPP_VERIFY_TOKEN` — a random string you choose. Only needed once you
  connect a WhatsApp Business API provider (360dialog / Twilio) to the scaffolded
  `/api/whatsapp/webhook` endpoint (see the TODOs in that file).

### 7. Configure environment variables

```bash
cp .env.local.example .env.local
```

Fill in the values from the steps above, plus:

- `NEXT_PUBLIC_SITE_URL` — `http://localhost:3000` for local dev; your real
  domain in production (used by the sitemap, robots, and checkout redirects).

### 8. Run the dev server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

## Admin dashboard (no code required)

Go to `/admin`, sign in with the Supabase Auth user from step 2. Three tabs:

- **Products & Stock** — edit stock inline (click the number → save), toggle
  Active / Out of Stock, see Low (≤ 5) / Out badges, and **Add product** with a
  direct **photo upload** to Supabase Storage (no URL pasting). Stats row shows
  total products, in-stock, low-stock, and orders this week.
- **Homepage Content** — edit the hero (heading, subheading, button), the
  "Why linen" cards, and the brand story. Saves to the `site_content` table;
  the homepage reads from it. No code edits to change site wording.
- **Journal** — create / edit / delete posts, upload cover images, and toggle
  Published / Draft. Published posts appear at `/journal`.

## Deployment (Vercel)

The repo is connected to Vercel. In **Project → Settings → Environment Variables**,
add every key below, then redeploy. **New keys introduced by this upgrade are marked ★.**

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | Your production URL |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase — secret |
| `RAZORPAY_KEY_ID` | Razorpay |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Razorpay (browser) |
| `RAZORPAY_KEY_SECRET` | Razorpay — secret |
| `ANTHROPIC_API_KEY` | ★ Ask Wovenne concierge — secret |
| `SENTRY_DSN` | ★ Sentry (server) |
| `NEXT_PUBLIC_SENTRY_DSN` | ★ Sentry (browser) |
| `NEXT_PUBLIC_WHATSAPP_NUMBER` | WhatsApp number |
| `WHATSAPP_VERIFY_TOKEN` | ★ Only needed when connecting a WhatsApp provider |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | ★ Optional — enables source-map upload on build |

> **Also do once in production Supabase:** run `supabase/schema.sql` against the
> production database and create your admin user. **PayPal is intentionally
> disabled** — its keys are commented out in `.env.local.example` for a future
> UK launch (see below); no PayPal vars are needed now.

## Future upgrade — multi-currency + PayPal

The site is single-currency (₹ INR) today. The planned upgrade is to show ₹ to
India and £ to the UK, with PayPal re-enabled for UK checkout alongside Razorpay.
The slot-in points are marked with `TODO(payments)` in `components/cart/CartSummary.tsx`,
`lib/types.ts`, and `.env.local.example`, and the display layer is documented in
`lib/utils.ts` (`formatINR`).

## Project structure

```
app/                    Routes (App Router)
  admin/                Admin login + dashboard (products, content, journal)
  api/chat/             Ask Wovenne AI concierge (Anthropic, streaming)
  api/checkout/razorpay Razorpay order create + verify
  api/whatsapp/webhook  WhatsApp Business API webhook (scaffold)
  product/[slug]/       Product detail (sticky add-to-cart, lightbox, image weave)
  journal/, journal/[slug]/   Editorial pages from journal_posts
  shop/, cart/, checkout/
  sitemap.ts, robots.ts, global-error.tsx

components/
  weave/                Canvas hero weave, scroll seam, image overlay, woven check
  ui/, layout/, home/, shop/, product/, cart/, chat/, admin/

lib/                    Supabase/Razorpay clients, chat core, cart store, content
                        + journal + storage helpers, motion variants, types, utils

supabase/schema.sql     Tables, RLS, Storage bucket + policies, seed data
sentry.*.config.ts      Sentry client/server/edge init
```

## Scripts

```bash
npm run dev      # start the dev server
npm run build    # production build
npm run start    # run the production build
npm run lint     # lint with ESLint
```
