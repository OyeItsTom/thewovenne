# THE WOVENNE

> Woven in India. Worn for life.

A premium, fullstack e-commerce site for THE WOVENNE — authentic handcrafted
Indian linen garments and homeware, sold direct to the UK. Built with
Next.js 14 (App Router), Tailwind CSS, Framer Motion, Supabase, Stripe and
Razorpay.

## Tech Stack

- **Framework**: Next.js 14 (App Router, TypeScript)
- **Styling**: Tailwind CSS v3 with a custom brand theme (colours, fonts, weave-texture watermarks)
- **Animation**: Framer Motion, with `prefers-reduced-motion` fallbacks throughout
- **State**: Zustand (cart, persisted to `localStorage`)
- **Database & Auth**: Supabase (Postgres + Row Level Security + Auth)
- **Payments**: Stripe Checkout (cards) and Razorpay (alternative provider)
- **Icons**: Lucide

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the
   `products` and `orders` tables, sets up Row Level Security policies, and
   seeds 6 sample products.
3. Go to **Authentication → Users** and create an admin user (email +
   password). This account is used to log in at `/admin`.
4. Go to **Project Settings → API** and copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (keep this secret —
     server-side only)

### 3. Set up Stripe

1. Create an account at [stripe.com](https://stripe.com) (test mode is fine).
2. **Developers → API keys**:
   - `Secret key` → `STRIPE_SECRET_KEY`
   - `Publishable key` → `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
3. **Developers → Webhooks** → add an endpoint pointing to
   `https://your-domain.com/api/webhooks/stripe` (or use the Stripe CLI for
   local testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`).
   Subscribe to the `checkout.session.completed` event and copy the signing
   secret → `STRIPE_WEBHOOK_SECRET`.

### 4. Set up Razorpay

1. Create an account at [razorpay.com](https://razorpay.com) (test mode is fine).
2. **Settings → API Keys** → generate a key pair:
   - `Key Id` → `RAZORPAY_KEY_ID` and `NEXT_PUBLIC_RAZORPAY_KEY_ID`
   - `Key Secret` → `RAZORPAY_KEY_SECRET`

### 5. Configure environment variables

Copy the example file and fill in the values gathered above:

```bash
cp .env.local.example .env.local
```

Also set:

- `NEXT_PUBLIC_SITE_URL` — your site's base URL (`http://localhost:3000` for local dev)
- `NEXT_PUBLIC_WHATSAPP_NUMBER` — your WhatsApp Business number in international
  format, digits only (e.g. `447123456789`)

### 6. Run the dev server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

## Admin Dashboard

Visit `/admin` and sign in with the Supabase Auth user created in step 2.
From the dashboard you can:

- View stats (total products, in-stock count, low-stock alerts ≤ 5 units)
- Edit stock levels inline
- Toggle a product's storefront status (Active / Out of Stock)
- Add new products

## Project Structure

```
app/                  Routes (App Router)
  admin/              Admin login + dashboard
  api/checkout/       Stripe & Razorpay checkout endpoints
  api/webhooks/       Stripe webhook handler
  product/[slug]/     Product detail pages
  shop/, cart/, checkout/, journal/

components/
  ui/                 Shared primitives (Button, Modal, Badge, Skeleton)
  layout/             Navbar, Footer, WhatsApp button
  home/, shop/, product/, cart/, admin/

lib/                  Supabase/Stripe/Razorpay clients, cart store, motion
                      variants, data-access helpers, types

supabase/schema.sql   Database schema, RLS policies, seed data
```

## Scripts

```bash
npm run dev      # start the dev server
npm run build    # production build
npm run start    # run the production build
npm run lint     # lint with ESLint
```
