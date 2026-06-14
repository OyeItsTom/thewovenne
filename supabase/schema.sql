-- THE WOVENNE — Supabase schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query).

-- ── Products ─────────────────────────────────
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  description text,
  price_gbp numeric(10,2) not null,
  category text,
  fabric text,
  colour text,
  stock_quantity integer default 0,
  image_url text,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- ── Orders ───────────────────────────────────
-- Lightweight record; Stripe/Razorpay handle the heavy lifting.
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  customer_email text,
  total_gbp numeric(10,2),
  payment_provider text, -- 'stripe' or 'razorpay'
  payment_status text default 'pending',
  items jsonb,
  created_at timestamptz default now()
);

-- Admin users are handled entirely by Supabase Auth (no custom table needed).

-- ── Row Level Security ───────────────────────
alter table products enable row level security;
alter table orders enable row level security;

-- Storefront: anyone can view active products.
create policy "Public can view active products"
  on products for select
  using (is_active = true);

-- Admin dashboard: signed-in users can view every product (including inactive/out-of-stock).
create policy "Authenticated users can view all products"
  on products for select
  to authenticated
  using (true);

-- Admin dashboard: signed-in users can create, edit and remove products.
create policy "Authenticated users can insert products"
  on products for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update products"
  on products for update
  to authenticated
  using (true);

create policy "Authenticated users can delete products"
  on products for delete
  to authenticated
  using (true);

-- Orders are written by server-side API routes using the service role key
-- (which bypasses RLS), and read by signed-in admins.
create policy "Authenticated users can view orders"
  on orders for select
  to authenticated
  using (true);

-- ── Seed data: 6 sample products ─────────────
insert into products (name, slug, description, price_gbp, category, fabric, colour, stock_quantity, image_url, is_active)
values
  ('Indigo Handloom Shirt', 'indigo-handloom-shirt', 'A breathable pure linen shirt, hand-loomed by artisans in Tamil Nadu and dyed in deep indigo. Cut for an easy, relaxed fit that softens with every wash.', 78.00, 'Shirts', 'Pure Linen', 'Indigo', 12, 'https://placehold.co/800x1000/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Sundara Kurta', 'sundara-kurta', 'A classic straight-cut kurta in a soft linen-cotton blend. Lightweight enough for Indian summers, warm enough for a British spring.', 62.00, 'Kurtas', 'Linen-Cotton', 'Off-White', 4, 'https://placehold.co/800x1000/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Terracotta Weave Trousers', 'terracotta-weave-trousers', 'Wide-leg trousers in a heavyweight terracotta linen. Elasticated waist, deep pockets, woven to move with you.', 85.00, 'Trousers', 'Linen', 'Terracotta', 8, 'https://placehold.co/800x1000/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Heritage Throw — Indigo Stripe', 'heritage-throw-indigo-stripe', 'A handwoven cotton throw in an indigo and cream stripe, finished with hand-tied tassels. Made on a traditional pit loom.', 45.00, 'Home', 'Handloom Cotton', 'Indigo / Cream', 15, 'https://placehold.co/800x1000/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Raw Linen Overshirt', 'raw-linen-overshirt', 'An unstructured overshirt in undyed raw linen. Slubby texture, mother-of-pearl buttons — gets better with every wear.', 95.00, 'Shirts', 'Raw Linen', 'Natural', 2, 'https://placehold.co/800x1000/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Block-Print Kurta — Gold Motif', 'block-print-kurta-gold-motif', 'Hand block-printed kurta in cream linen with an aged-gold motif, inspired by Banarasi loom patterns.', 120.00, 'Kurtas', 'Linen', 'Cream / Gold', 6, 'https://placehold.co/800x1000/F0EAD6/1C1F3B?text=THE+WOVENNE', true)
on conflict (slug) do nothing;
