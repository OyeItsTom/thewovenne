-- THE WOVENNE — Supabase schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query).
-- Safe to re-run: uses "if not exists" / "on conflict do nothing" throughout.
--
-- ── Connection pooling (serverless) ──────────
-- For queries from Vercel serverless functions, use the TRANSACTION-mode pooler
-- connection string (port 6543), not the direct connection (5432). In Supabase:
--   Project Settings → Database → Connection string → "Transaction" (port 6543).
-- The NEXT_PUBLIC_SUPABASE_URL / anon-key REST client used here is already
-- pooled by Supabase; the port note applies if you add a direct Postgres client.

-- ── Products ─────────────────────────────────
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  description text,
  price_inr numeric(10,2) not null,
  category text,
  fabric text,
  colour text,
  stock_quantity integer default 0,
  image_url text,
  is_active boolean default true,
  created_at timestamptz default now()
);

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

-- Admin users are handled entirely by Supabase Auth (no custom table needed).

-- ── Row Level Security ───────────────────────
alter table products enable row level security;
alter table orders enable row level security;
alter table site_content enable row level security;
alter table journal_posts enable row level security;

-- Products: public can view active; admins can view/manage all.
create policy "Public can view active products"
  on products for select using (is_active = true);
create policy "Authenticated can view all products"
  on products for select to authenticated using (true);
create policy "Authenticated can insert products"
  on products for insert to authenticated with check (true);
create policy "Authenticated can update products"
  on products for update to authenticated using (true);
create policy "Authenticated can delete products"
  on products for delete to authenticated using (true);

-- Orders: written server-side via the service role (bypasses RLS); admins read.
create policy "Authenticated can view orders"
  on orders for select to authenticated using (true);

-- Site content: public can read; admins can manage.
create policy "Public can view site content"
  on site_content for select using (true);
create policy "Authenticated can insert site content"
  on site_content for insert to authenticated with check (true);
create policy "Authenticated can update site content"
  on site_content for update to authenticated using (true);
create policy "Authenticated can delete site content"
  on site_content for delete to authenticated using (true);

-- Journal: public can read published; admins can read all + manage.
create policy "Public can view published journal"
  on journal_posts for select using (published = true);
create policy "Authenticated can view all journal"
  on journal_posts for select to authenticated using (true);
create policy "Authenticated can insert journal"
  on journal_posts for insert to authenticated with check (true);
create policy "Authenticated can update journal"
  on journal_posts for update to authenticated using (true);
create policy "Authenticated can delete journal"
  on journal_posts for delete to authenticated using (true);

-- ── Seed: 10 sample products (temporary placeholders) ─
-- Prices in INR (₹) — launching in Kerala, India first. Images are placeholders;
-- replace with real photos via the admin dashboard (Supabase Storage upload).
insert into products (name, slug, description, price_inr, category, fabric, colour, stock_quantity, image_url, is_active)
values
  ('Kochi Linen Shirt', 'kochi-linen-shirt', 'A breathable pure-linen shirt, hand-loomed on the Malabar coast. Relaxed collar, mother-of-pearl buttons, softens beautifully with every wash.', 1899, 'Shirts', 'Pure Linen', 'Natural', 14, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Malabar Kurta', 'malabar-kurta', 'A straight-cut kurta in a soft linen-cotton blend — light enough for Kerala heat, elegant enough for evenings. Side slits, deep pockets.', 2299, 'Kurtas', 'Linen-Cotton', 'Off-White', 9, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Varkala Linen Trousers', 'varkala-linen-trousers', 'Wide-leg trousers in heavyweight linen with an elasticated drawstring waist. Woven to move with you, from beach to table.', 1799, 'Trousers', 'Linen', 'Sand', 11, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Onam Ivory Saree', 'onam-ivory-saree', 'A handwoven kasavu-inspired saree in ivory with a fine gold border — a quiet, ceremonial classic from the Kerala loom.', 3999, 'Sarees', 'Handloom Cotton', 'Ivory / Gold', 5, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Kerala Handloom Throw', 'kerala-handloom-throw', 'A handwoven cotton throw in a natural stripe, finished with hand-tied tassels. Made on a traditional pit loom.', 1499, 'Home', 'Handloom Cotton', 'Natural / Indigo', 18, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Backwater Linen Dress', 'backwater-linen-dress', 'An easy midi dress in washed linen — unstructured, pocketed, and endlessly wearable. Cut for airflow and grace.', 2599, 'Dresses', 'Washed Linen', 'Sage', 7, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Fort Kochi Overshirt', 'fort-kochi-overshirt', 'An unstructured overshirt in undyed raw linen. Slubby texture, patch pockets — gets better with every wear.', 2199, 'Shirts', 'Raw Linen', 'Undyed', 0, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Alleppey Lounge Set', 'alleppey-lounge-set', 'A matched linen shirt-and-shorts set for slow mornings. Breathable, soft, and quietly refined.', 2999, 'Sets', 'Linen', 'Clay', 6, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Muslin Scarf', 'muslin-scarf', 'A featherlight handwoven muslin scarf — the finishing note. Folds to nothing, drapes like air.', 999, 'Accessories', 'Handloom Muslin', 'Ecru', 20, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Coir & Linen Tote', 'coir-linen-tote', 'A sturdy market tote woven from coir and linen, with reinforced handles. Kerala craft, built for daily life.', 1199, 'Accessories', 'Coir / Linen', 'Natural', 13, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true)
on conflict (slug) do nothing;

-- ── Seed: editable homepage content ──────────
insert into site_content (key, value) values
  ('home_hero', '{"eyebrow":"Woven in India · Worn for life","heading":"THE WOVENNE","subheading":"Authentic, handcrafted linen — sent direct from the loom houses of Kerala to your door. From the loom, to you. Nothing in between.","cta_label":"Explore the Collection","cta_href":"/shop"}'),
  ('why_linen', '{"title":"Why linen","cards":[{"title":"Kind to your skin","text":"Naturally breathable and hypoallergenic — linen keeps you cool and comfortable all day."},{"title":"Kinder to the earth","text":"Flax needs little water and no irrigation. Woven by hand, it treads lightly."},{"title":"Made to last","text":"Linen softens with every wash and outlives fast fashion by decades."}]}'),
  ('brand_story', '{"title":"From the loom, to you","body":"THE WOVENNE works directly with handloom artisans across Kerala. No middleman, no compromise — just honest cloth, woven the way it has been for generations, sent straight to you."}')
on conflict (key) do nothing;

-- ── Seed: journal posts ──────────────────────
insert into journal_posts (title, slug, body, image_url, published)
values
  ('The pit loom of Kerala', 'the-pit-loom-of-kerala', 'For centuries, Kerala''s weavers have worked at the pit loom — feet below the ground, hands at the warp. Every metre of our cloth begins here.', 'https://placehold.co/1200x800/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Why we choose linen', 'why-we-choose-linen', 'Linen is the oldest woven fibre known to us. It breathes, it lasts, and it asks little of the land. This is why every WOVENNE piece begins with flax.', 'https://placehold.co/1200x800/F0EAD6/1C1F3B?text=THE+WOVENNE', true)
on conflict (slug) do nothing;

-- ── Storage: product & journal images ────────
-- Public bucket so images render on the storefront; only signed-in admins upload.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Re-runnable: drop-then-create so this block is idempotent.
drop policy if exists "Public read product images" on storage.objects;
create policy "Public read product images"
  on storage.objects for select using (bucket_id = 'product-images');

drop policy if exists "Admin upload product images" on storage.objects;
create policy "Admin upload product images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images');

drop policy if exists "Admin update product images" on storage.objects;
create policy "Admin update product images"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images');

drop policy if exists "Admin delete product images" on storage.objects;
create policy "Admin delete product images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images');
