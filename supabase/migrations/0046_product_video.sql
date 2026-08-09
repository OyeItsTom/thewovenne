-- 0046 — An official product video
--
-- One YouTube video per product, ours, unlisted. Stored as the eleven-character
-- ID rather than a URL: a URL arrives in five shapes (watch?v=, youtu.be,
-- /shorts/, /embed/, with playlist and timestamp parameters glued on) and
-- storing whichever one was pasted means the embed has to re-parse it on every
-- render, forever. Normalised once, on the way in.
--
-- IT LIVES ON product_versions, so it inherits draft/publish for free — a video
-- can be added, previewed on the real product page, and published with
-- everything else. That was the requirement, and it costs nothing because the
-- versioning already exists.
--
-- THE CARRY-THROUGH, which has now bitten twice. A product_versions column is
-- copied by an explicit list in ensure_product_draft, and separately synced to
-- `products` on publish by 0038's trigger. Miss either and the field silently
-- empties — 0037 did exactly that with hsn_code and nobody would have noticed
-- until GST registration. Both are updated below.

alter table products         add column if not exists video_youtube_id text;
alter table product_versions add column if not exists video_youtube_id text;

comment on column products.video_youtube_id is
  'YouTube video ID only — never a URL. Eleven characters, normalised on input.';

-- Cheap sanity: YouTube IDs are 11 characters of [A-Za-z0-9_-]. This will not
-- catch a well-formed ID that points nowhere, but it does catch a pasted URL,
-- which is the mistake that actually happens.
do $$ begin
  alter table product_versions add constraint product_versions_video_id_shape
    check (video_youtube_id is null or video_youtube_id ~ '^[A-Za-z0-9_-]{11}$');
exception when duplicate_object then null; end $$;

-- ── 1 of 2: the draft fork ────────────────────
create or replace function public.ensure_product_draft(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  draft_id uuid;
  source   product_versions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit products';
  end if;

  select id into draft_id from product_versions
   where product_id = p_product_id and state = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;

  select * into source from product_versions
   where product_id = p_product_id and state = 'published';
  if not found then
    raise exception 'No published version for that product';
  end if;

  insert into product_versions
    (product_id, state, version, name, slug, description, price_inr, category_id,
     fabric, colour, stock_quantity, image_url, is_active, created_by,
     collection, discount_type, discount_value, discount_starts_at, discount_ends_at,
     hsn_code, sku, cost_price_inr, video_youtube_id)
  values
    (source.product_id, 'draft', source.version + 1, source.name, source.slug,
     source.description, source.price_inr, source.category_id, source.fabric,
     source.colour, source.stock_quantity, source.image_url, source.is_active,
     auth.uid(),
     source.collection, source.discount_type, source.discount_value,
     source.discount_starts_at, source.discount_ends_at,
     source.hsn_code, source.sku, source.cost_price_inr, source.video_youtube_id)
  returning id into draft_id;

  insert into product_images (product_version_id, product_id, url, sort_order)
  select draft_id, source.product_id, url, sort_order
    from product_images
   where product_version_id = source.id;

  return draft_id;
end;
$fn$;

revoke execute on function public.ensure_product_draft(uuid) from public;
grant execute on function public.ensure_product_draft(uuid) to authenticated, service_role;

-- ── 2 of 2: the publish sync ──────────────────
create or replace function public.sync_published_product_extras()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update products p
     set hsn_code         = new.hsn_code,
         cost_price_inr   = new.cost_price_inr,
         video_youtube_id = new.video_youtube_id,
         sku              = coalesce(new.sku, public.sku_from_slug(new.slug))
   where p.id = new.product_id;
  return new;
end;
$fn$;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name in ('products','product_versions')
      and column_name='video_youtube_id') as columns_added,
  (select count(*) from pg_constraint
    where conname='product_versions_video_id_shape') as shape_check,
  -- Both carry-through points must name the column, or it empties on the next
  -- edit or publish.
  (select count(*) from pg_proc
    where proname='ensure_product_draft'
      and prosrc like '%video_youtube_id%') as draft_carries_it,
  (select count(*) from pg_proc
    where proname='sync_published_product_extras'
      and prosrc like '%video_youtube_id%') as publish_carries_it;
