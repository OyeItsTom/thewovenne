-- THE WOVENNE — Supabase schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query).
-- Fully idempotent — re-run any time on an existing database with no errors:
-- "create table if not exists", "drop policy if exists" before every policy
-- (tables + storage.objects), and "on conflict do nothing" on all seeds.
--
-- ── Connection pooling (serverless) ──────────
-- For queries from Vercel serverless functions, use the TRANSACTION-mode pooler
-- connection string (port 6543), not the direct connection (5432). In Supabase:
--   Project Settings → Database → Connection string → "Transaction" (port 6543).
-- The NEXT_PUBLIC_SUPABASE_URL / anon-key REST client used here is already
-- pooled by Supabase; the port note applies if you add a direct Postgres client.

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

-- ── Admin identity ──────────────────────────
-- Every auth user gets a profile row; only is_admin = true may manage the
-- catalogue. Before this existed, ANY authenticated Supabase user was treated
-- as an admin. That becomes acute the moment customer sign-up ships, because
-- customers authenticate against this same project and would inherit full
-- write access to products, categories, content and orders.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  is_admin boolean not null default false,
  created_at timestamptz default now()
);

-- SECURITY DEFINER so table policies can call this without recursing through
-- the RLS on profiles itself (a policy on profiles that queried profiles would
-- deadlock into infinite recursion).
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Give every new signup a profile row (defaulting to is_admin = false).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed up before this table existed. Nobody is promoted
-- automatically — see the note at the bottom of this file for how to grant
-- yourself admin, which you MUST do or you will lock yourself out of /admin.
insert into profiles (id, email)
select u.id, u.email from auth.users u
on conflict (id) do nothing;

-- ── Row Level Security ───────────────────────
alter table profiles enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
alter table site_content enable row level security;
alter table journal_posts enable row level security;

-- Profiles: you can see and edit your own; admins can see and edit anyone's.
drop policy if exists "Users read own profile" on profiles;
create policy "Users read own profile"
  on profiles for select to authenticated using (id = auth.uid());
drop policy if exists "Admins read all profiles" on profiles;
create policy "Admins read all profiles"
  on profiles for select to authenticated using (public.is_admin());
drop policy if exists "Users update own profile" on profiles;
create policy "Users update own profile"
  on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "Admins update any profile" on profiles;
create policy "Admins update any profile"
  on profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Categories: public can read visible ones; admins read all + manage.
drop policy if exists "Public can view visible categories" on categories;
create policy "Public can view visible categories"
  on categories for select using (is_visible = true);
drop policy if exists "Authenticated can view all categories" on categories;
drop policy if exists "Admins can view all categories" on categories;
create policy "Admins can view all categories"
  on categories for select to authenticated using (public.is_admin());
drop policy if exists "Authenticated can insert categories" on categories;
drop policy if exists "Admins can insert categories" on categories;
create policy "Admins can insert categories"
  on categories for insert to authenticated with check (public.is_admin());
drop policy if exists "Authenticated can update categories" on categories;
drop policy if exists "Admins can update categories" on categories;
create policy "Admins can update categories"
  on categories for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Authenticated can delete categories" on categories;
drop policy if exists "Admins can delete categories" on categories;
create policy "Admins can delete categories"
  on categories for delete to authenticated using (public.is_admin());

-- Every policy is drop-then-create so this whole file re-runs cleanly on a
-- database that already has the original policies (no "already exists" errors).

-- Products: public can view active; admins can view/manage all.
drop policy if exists "Public can view active products" on products;
create policy "Public can view active products"
  on products for select using (is_active = true);
drop policy if exists "Authenticated can view all products" on products;
drop policy if exists "Admins can view all products" on products;
create policy "Admins can view all products"
  on products for select to authenticated using (public.is_admin());
drop policy if exists "Authenticated can insert products" on products;
drop policy if exists "Admins can insert products" on products;
create policy "Admins can insert products"
  on products for insert to authenticated with check (public.is_admin());
drop policy if exists "Authenticated can update products" on products;
drop policy if exists "Admins can update products" on products;
create policy "Admins can update products"
  on products for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Authenticated can delete products" on products;
drop policy if exists "Admins can delete products" on products;
create policy "Admins can delete products"
  on products for delete to authenticated using (public.is_admin());

-- Orders: written server-side via the service role (bypasses RLS); admins read.
drop policy if exists "Authenticated can view orders" on orders;
drop policy if exists "Admins can view orders" on orders;
create policy "Admins can view orders"
  on orders for select to authenticated using (public.is_admin());

-- Site content: public can read; admins can manage.
drop policy if exists "Public can view site content" on site_content;
create policy "Public can view site content"
  on site_content for select using (true);
drop policy if exists "Authenticated can insert site content" on site_content;
drop policy if exists "Admins can insert site content" on site_content;
create policy "Admins can insert site content"
  on site_content for insert to authenticated with check (public.is_admin());
drop policy if exists "Authenticated can update site content" on site_content;
drop policy if exists "Admins can update site content" on site_content;
create policy "Admins can update site content"
  on site_content for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Authenticated can delete site content" on site_content;
drop policy if exists "Admins can delete site content" on site_content;
create policy "Admins can delete site content"
  on site_content for delete to authenticated using (public.is_admin());

-- Journal: public can read published; admins can read all + manage.
drop policy if exists "Public can view published journal" on journal_posts;
create policy "Public can view published journal"
  on journal_posts for select using (published = true);
drop policy if exists "Authenticated can view all journal" on journal_posts;
drop policy if exists "Admins can view all journal" on journal_posts;
create policy "Admins can view all journal"
  on journal_posts for select to authenticated using (public.is_admin());
drop policy if exists "Authenticated can insert journal" on journal_posts;
drop policy if exists "Admins can insert journal" on journal_posts;
create policy "Admins can insert journal"
  on journal_posts for insert to authenticated with check (public.is_admin());
drop policy if exists "Authenticated can update journal" on journal_posts;
drop policy if exists "Admins can update journal" on journal_posts;
create policy "Admins can update journal"
  on journal_posts for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Authenticated can delete journal" on journal_posts;
drop policy if exists "Admins can delete journal" on journal_posts;
create policy "Admins can delete journal"
  on journal_posts for delete to authenticated using (public.is_admin());

-- ── Table privileges for the API roles ──────
-- RLS decides WHICH rows each role may see; the roles still need base table
-- privileges or PostgREST returns "permission denied" (42501) before RLS even
-- runs. Supabase usually grants these via default privileges — add them
-- explicitly so this schema is self-contained and reproducible. Safe to re-run.
grant usage on schema public to anon, authenticated;
grant select on categories, products, site_content, journal_posts to anon, authenticated;
grant insert, update, delete on categories, products, site_content, journal_posts to authenticated;
grant select on orders to authenticated;

-- Profiles: readable/updatable per the policies above, BUT is_admin is granted
-- at column level only. RLS cannot restrict individual columns, so without this
-- a signed-in customer could run `update profiles set is_admin = true` against
-- their own row — the "Users update own profile" policy would happily allow it.
-- Promotion therefore requires the SQL editor or the service role key.
grant select on profiles to authenticated;
revoke update on profiles from authenticated;
grant update (email, full_name) on profiles to authenticated;

-- ── Seed: categories (Men / Women → sub-categories) ─
-- Only Women → Sarees is visible at launch; the rest are hidden until their
-- product lines are ready. Toggle visibility later from the admin Category tab.
insert into categories (name, slug, parent_id, is_visible, sort_order) values
  ('Men', 'men', null, true, 1),
  ('Women', 'women', null, true, 2)
on conflict (slug) do nothing;

insert into categories (name, slug, parent_id, is_visible, sort_order)
select v.name, v.slug, p.id, v.is_visible, v.sort_order
from (values
  ('Shirts',        'shirts',        'men',   false, 1),
  ('Kurtas',        'kurtas',        'men',   false, 2),
  ('Trousers',      'trousers',      'men',   false, 3),
  ('Nehru Jackets', 'nehru-jackets', 'men',   false, 4),
  ('Sarees',        'sarees',        'women', true,  1),
  ('Kurtis',        'kurtis',        'women', false, 2),
  ('Dresses',       'dresses',       'women', false, 3),
  ('Blouses',       'blouses',       'women', false, 4),
  ('Sets',          'sets',          'women', false, 5),
  ('Home',          'home',          'women', false, 6),
  ('Accessories',   'accessories',   'women', false, 7)
) as v(name, slug, parent_slug, is_visible, sort_order)
join categories p on p.slug = v.parent_slug
on conflict (slug) do nothing;

-- ── Seed: 10 sample products (temporary placeholders) ─
-- Prices in INR (₹) — launching in Kerala, India first. Images are placeholders;
-- replace with real photos via the admin dashboard (Supabase Storage upload).
insert into products (name, slug, description, price_inr, fabric, colour, stock_quantity, image_url, is_active)
values
  ('Kochi Linen Shirt', 'kochi-linen-shirt', 'A breathable pure-linen shirt, hand-loomed on the Malabar coast. Relaxed collar, mother-of-pearl buttons, softens beautifully with every wash.', 1899, 'Pure Linen', 'Natural', 14, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Malabar Kurta', 'malabar-kurta', 'A straight-cut kurta in a soft linen-cotton blend — light enough for Kerala heat, elegant enough for evenings. Side slits, deep pockets.', 2299, 'Linen-Cotton', 'Off-White', 9, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Varkala Linen Trousers', 'varkala-linen-trousers', 'Wide-leg trousers in heavyweight linen with an elasticated drawstring waist. Woven to move with you, from beach to table.', 1799, 'Linen', 'Sand', 11, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Onam Ivory Saree', 'onam-ivory-saree', 'A handwoven kasavu-inspired saree in ivory with a fine gold border — a quiet, ceremonial classic from the Kerala loom.', 3999, 'Handloom Cotton', 'Ivory / Gold', 5, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Kerala Handloom Throw', 'kerala-handloom-throw', 'A handwoven cotton throw in a natural stripe, finished with hand-tied tassels. Made on a traditional pit loom.', 1499, 'Handloom Cotton', 'Natural / Indigo', 18, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Backwater Linen Dress', 'backwater-linen-dress', 'An easy midi dress in washed linen — unstructured, pocketed, and endlessly wearable. Cut for airflow and grace.', 2599, 'Washed Linen', 'Sage', 7, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Fort Kochi Overshirt', 'fort-kochi-overshirt', 'An unstructured overshirt in undyed raw linen. Slubby texture, patch pockets — gets better with every wear.', 2199, 'Raw Linen', 'Undyed', 0, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Alleppey Lounge Set', 'alleppey-lounge-set', 'A matched linen shirt-and-shorts set for slow mornings. Breathable, soft, and quietly refined.', 2999, 'Linen', 'Clay', 6, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Muslin Scarf', 'muslin-scarf', 'A featherlight handwoven muslin scarf — the finishing note. Folds to nothing, drapes like air.', 999, 'Handloom Muslin', 'Ecru', 20, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Coir & Linen Tote', 'coir-linen-tote', 'A sturdy market tote woven from coir and linen, with reinforced handles. Kerala craft, built for daily life.', 1199, 'Coir / Linen', 'Natural', 13, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true)
on conflict (slug) do nothing;

-- Map the seed products onto the new relational categories (only where unset,
-- so re-running never clobbers categories set later from the admin panel).
update products p set category_id = c.id
from categories c
where p.category_id is null and c.slug = case p.slug
  when 'kochi-linen-shirt'       then 'shirts'
  when 'malabar-kurta'           then 'kurtas'
  when 'varkala-linen-trousers'  then 'trousers'
  when 'onam-ivory-saree'        then 'sarees'
  when 'kerala-handloom-throw'   then 'home'
  when 'backwater-linen-dress'   then 'dresses'
  when 'fort-kochi-overshirt'    then 'shirts'
  when 'alleppey-lounge-set'     then 'sets'
  when 'muslin-scarf'            then 'accessories'
  when 'coir-linen-tote'         then 'accessories'
end;

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

-- Writes are admin-only: without the is_admin() check any signed-in customer
-- could upload into, overwrite, or wipe the product image bucket.
drop policy if exists "Admin upload product images" on storage.objects;
create policy "Admin upload product images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "Admin update product images" on storage.objects;
create policy "Admin update product images"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "Admin delete product images" on storage.objects;
create policy "Admin delete product images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

-- ── MANDATORY LAST STEP ─────────────────────
-- Nothing above promotes anyone. Until you run this, /admin will let you sign
-- in and then show an empty dashboard, because every admin policy returns false.
-- Replace the address with the email of your Supabase Auth admin user:
--
--   update profiles set is_admin = true where email = 'you@example.com';
--
-- Verify with:  select email, is_admin from profiles;
