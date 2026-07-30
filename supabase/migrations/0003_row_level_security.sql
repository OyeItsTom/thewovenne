-- 0003 — Row Level Security
-- Public read policies plus admin-only writes. Requires is_admin() from 0002.

alter table categories enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
alter table site_content enable row level security;
alter table journal_posts enable row level security;

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
