-- 0051 — Brand knowledge, per product
--
-- Three fields the description cannot carry: where the cloth comes from, how it
-- was made, and how to look after it. The description is a paragraph that sells
-- the piece; this is the material a concierge answers questions out of, and a
-- customer reads when they want to know what they are buying.
--
-- THREE COLUMNS, NOT ONE JSONB BLOB. Each is separately diffable in the publish
-- queue, each renders as its own labelled section, and each can be returned to
-- the concierge as a named field rather than as a shape it has to parse. A blob
-- would need its keys validating and would carry exactly the same draft/publish
-- work, so it buys nothing.
--
-- ON product_versions, so it inherits draft/publish like everything else: it can
-- be written, previewed on the real product page, and published with the rest of
-- the edit.
--
-- ── THE CARRY-THROUGH, WHICH HAS NOW BITTEN TWICE ──
--
-- A product_versions column reaches `products` by two separate explicit routes:
-- the column list inside ensure_product_draft, and 0038's publish trigger
-- sync_published_product_extras. Miss either and the field silently empties —
-- 0037 did that with hsn_code and nobody would have noticed until GST
-- registration. Both are re-declared below with the new columns named, and the
-- verify block at the bottom asserts both mention them.
--
-- NOT NAMED IN create_product_draft, deliberately: a brand-new product starts
-- with these null, which is true — nobody has written them yet. The admin form
-- shows them empty and says so.
--
-- NOT BACKFILLED and NOT GENERATED. Four products exist and their heritage is
-- the owner's to write; inventing provenance for handloom cloth is the one
-- failure mode that would damage the claim the shop is built on. Every existing
-- row therefore reads null, which is honest.

alter table products add column if not exists heritage_note text;
alter table products add column if not exists craft_note    text;
alter table products add column if not exists care_note     text;

alter table product_versions add column if not exists heritage_note text;
alter table product_versions add column if not exists craft_note    text;
alter table product_versions add column if not exists care_note     text;

comment on column products.heritage_note is
  'Cultural and regional context: the weaving tradition, where it comes from,
   what it is called locally. Written by hand — never generated.';
comment on column products.craft_note is
  'Material and craftsmanship: the technique, the loom, what makes this piece
   distinctive. Written by hand — never generated.';
comment on column products.care_note is
  'How to wash, dry, iron and store THIS piece. Takes precedence over the
   fabric-generic care advice on the product page when present.';

-- A ceiling, not a shape check. These are paragraphs, so there is no format to
-- validate — but a field with no limit at all is where somebody eventually
-- pastes an entire document, and this text is read into a model prompt.
do $$ begin
  alter table product_versions
    add constraint product_versions_brand_knowledge_length check (
      coalesce(length(heritage_note), 0) <= 4000
      and coalesce(length(craft_note), 0) <= 4000
      and coalesce(length(care_note), 0) <= 4000
    );
exception when duplicate_object then null; end $$;

-- ── 1 of 2: the draft fork ────────────────────
-- Re-declared from 0046 with three columns added. Everything else is unchanged;
-- the whole list has to be restated because that is how this function copies.
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
     hsn_code, sku, cost_price_inr, video_youtube_id,
     heritage_note, craft_note, care_note)
  values
    (source.product_id, 'draft', source.version + 1, source.name, source.slug,
     source.description, source.price_inr, source.category_id, source.fabric,
     source.colour, source.stock_quantity, source.image_url, source.is_active,
     auth.uid(),
     source.collection, source.discount_type, source.discount_value,
     source.discount_starts_at, source.discount_ends_at,
     source.hsn_code, source.sku, source.cost_price_inr, source.video_youtube_id,
     source.heritage_note, source.craft_note, source.care_note)
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
         heritage_note    = new.heritage_note,
         craft_note       = new.craft_note,
         care_note        = new.care_note,
         sku              = coalesce(new.sku, public.sku_from_slug(new.slug))
   where p.id = new.product_id;
  return new;
end;
$fn$;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name in ('heritage_note', 'craft_note', 'care_note')) as product_columns,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'product_versions'
      and column_name in ('heritage_note', 'craft_note', 'care_note')) as version_columns,
  (select count(*) from pg_constraint
    where conname = 'product_versions_brand_knowledge_length') as length_check,
  -- Both carry-through points must name every one of the three, or the field
  -- empties on the next edit or the next publish.
  (select count(*) from pg_proc
    where proname = 'ensure_product_draft'
      and prosrc like '%heritage_note%'
      and prosrc like '%craft_note%'
      and prosrc like '%care_note%') as draft_carries_all_three,
  (select count(*) from pg_proc
    where proname = 'sync_published_product_extras'
      and prosrc like '%heritage_note%'
      and prosrc like '%craft_note%'
      and prosrc like '%care_note%') as publish_carries_all_three,
  (select count(*) from products
    where heritage_note is not null or craft_note is not null
       or care_note is not null) as products_written_up;
