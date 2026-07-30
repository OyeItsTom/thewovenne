-- 0005 — Storage bucket and policies
-- Public-read bucket so images render on the storefront; admin-only writes.
-- Requires is_admin() from 0002.

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
