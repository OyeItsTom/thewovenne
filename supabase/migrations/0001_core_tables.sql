-- 0001 — Core tables
-- categories, products, orders, site_content, journal_posts.
-- No RLS or grants here; those are 0003 and 0004.

-- ── Categories (relational: parent → sub-category) ──
-- Two levels: top-level parents (Men / Women, parent_id = null) and their
-- sub-categories (Sarees, Shirts…, parent_id = the parent's id). is_visible
-- controls storefront visibility; a hidden parent hides all its children too
-- (enforced in lib/categories.ts, which only walks visible parents).
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  parent_id uuid references categories(id) on delete cascade,
  is_visible boolean default true,
  sort_order integer default 0,
  created_at timestamptz default now()
);

-- ── Products ─────────────────────────────────
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  description text,
  price_inr numeric(10,2) not null,
  category_id uuid references categories(id) on delete set null,
  fabric text,
  colour text,
  stock_quantity integer default 0,
  image_url text,
  is_active boolean default true,
  created_at timestamptz default now()
);
-- Migrate the old flat text column → relational category_id (safe to re-run).
alter table products add column if not exists category_id uuid references categories(id) on delete set null;
alter table products drop column if exists category;

-- ── Orders ───────────────────────────────────
-- Lightweight record; Razorpay handles the payment itself.
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  customer_email text,
  total_inr numeric(10,2),
  payment_provider text, -- 'razorpay' (PayPal may be added later for the UK)
  payment_status text default 'pending',
  tracking_status text,  -- e.g. 'processing' | 'shipped' | 'delivered'
  items jsonb,
  created_at timestamptz default now()
);
-- For databases created before tracking_status existed:
alter table orders add column if not exists tracking_status text;

-- ── Editable site content (key/value JSON) ───
-- Lets the non-technical admin change homepage copy without touching code.
create table if not exists site_content (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- ── Journal posts ────────────────────────────
create table if not exists journal_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique not null,
  body text,
  image_url text,
  published boolean default false,
  created_at timestamptz default now()
);
