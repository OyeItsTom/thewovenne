-- THE WOVENNE — product_images (multi-photo galleries)
-- Standalone and idempotent. Open this file, Select All, paste into the
-- Supabase SQL editor, Run. Requires profiles + is_admin() to exist already.

create table if not exists product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  url text not null,
  sort_order integer not null default 0,
  created_at timestamptz default now()
);

-- Galleries are always read product-at-a-time, in order.
create index if not exists product_images_product_idx
  on product_images (product_id, sort_order);

alter table product_images enable row level security;

-- Public sees images belonging to active products. Category visibility is
-- enforced in the app's product queries, and the storage bucket is public-read
-- regardless, so this only needs to match the products table's own posture.
drop policy if exists "Public can view images of active products" on product_images;
create policy "Public can view images of active products"
  on product_images for select
  using (
    exists (
      select 1 from products p
      where p.id = product_images.product_id and p.is_active
    )
  );

drop policy if exists "Admins can view all product images" on product_images;
create policy "Admins can view all product images"
  on product_images for select to authenticated using (public.is_admin());

drop policy if exists "Admins can insert product images" on product_images;
create policy "Admins can insert product images"
  on product_images for insert to authenticated with check (public.is_admin());

drop policy if exists "Admins can update product images" on product_images;
create policy "Admins can update product images"
  on product_images for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins can delete product images" on product_images;
create policy "Admins can delete product images"
  on product_images for delete to authenticated using (public.is_admin());

grant select on product_images to anon, authenticated;
grant insert, update, delete on product_images to authenticated;
grant all privileges on product_images to service_role;

-- Seed the gallery from the single photo each product already has, so nothing
-- loses its image the moment the app starts reading from this table.
insert into product_images (product_id, url, sort_order)
select p.id, p.image_url, 0
from products p
where p.image_url is not null
  and not exists (select 1 from product_images i where i.product_id = p.id);

-- Check: every product with a photo should now have at least one row.
select
  (select count(*) from products where image_url is not null) as products_with_photo,
  (select count(distinct product_id) from product_images)      as products_with_gallery,
  (select count(*) from product_images)                        as total_images;
