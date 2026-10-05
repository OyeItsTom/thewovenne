-- 0065 — Product information: structured facts, alt text, and what publishing needs
--
-- Until now most of what a customer (or a search engine) needs to know about a
-- piece lived in prose, or nowhere: the fabric and colour columns, three
-- hand-written notes (0051), and a description most products do not have. This
-- adds the smallest structured layer on top of the existing draft/publish model:
--
--   1. FACTS on product_versions — dimensions, blouse piece, fit, finish, weave,
--      origin — plus an optional SEO title and meta description. All nullable:
--      NULL means "nobody has said", which is the honest answer for a piece whose
--      origin is unknown. Nothing is backfilled or derived; none of these are
--      stored anywhere today.
--   2. ALT TEXT per gallery photo, on product_images. A gallery row belongs to a
--      version (0011), so alt text drafts and publishes with the photo it
--      describes — no separate table, no second versioning scheme.
--   3. A PRODUCT TYPE on each category (category_versions.product_profile):
--      saree, drape, garment, jewellery or general. It decides which facts apply
--      to the products filed there. NULL inherits from the parent category, so a
--      new sub-category under Jewellery is jewellery without anyone setting it.
--   4. A PUBLISH RULE: a product version cannot become live while a fact its type
--      REQUIRES is missing. Saving a draft is never refused — only publishing.
--
-- ══ WHY THESE ARE COLUMNS, NOT A JSONB BLOB ══
--
-- The 0051 argument still holds: each is separately diffable in the publish
-- queue, each is a named field the product page and the concierge can read, and
-- a blob would need its keys validating while carrying exactly the same
-- draft/publish work. The set is deliberately small. "Composition" is the
-- fabric column ("Handloom 120 count mul cotton"); "care" is care_note (0051);
-- "craft" is craft_note. None is duplicated.
--
-- ══ THE PUBLISH RULE, AND ITS LIMITS ══
--
-- Required to publish (the same rule lib/productInfo.ts shows the admin, and
-- scripts/product-info-db.test.ts holds the two to agreement):
--
--   Fabric          saree, drape, garment     (labelled "Material" for jewellery,
--   / Material      jewellery                  where the same column holds it)
--   Colour          saree, drape, garment
--   Care            every type
--   Main image alt  every product that has photographs
--
-- What it does NOT do:
--   * It never touches what is already live. Like 0042's photograph rule it fires
--     only on a version BECOMING published, so all 34 existing products stay
--     exactly as they are. An edit to one of them is what asks for the missing
--     facts, at publish time.
--   * It skips a version being deleted, and a version that is HIDDEN
--     (is_active = false): hiding a piece must never wait on writing it up.
--   * It does not judge quality. "Recommended" fields (description, dimensions,
--     fit, finish, blouse piece, alt text on later photos) are shown to the admin
--     as a completeness list and never block anything.
--
-- ══ THE CARRY-THROUGH, A THIRD TIME ══
--
-- New product_versions columns must be named in ensure_product_draft's column
-- list or a forked draft silently loses them (0037 hsn_code, 0051). It is
-- restated below, and now copies each photo's alt text with the gallery.
-- ensure_category_draft gets the same treatment for product_profile.
-- gallery_matches now compares alt text as well as URLs — otherwise an
-- alt-text-only edit reads as "no change" and settle_draft DELETES the draft.
-- sync_published_product_extras is NOT touched: none of these columns exist on
-- the products identity table, and nothing reads them from there.
--
-- Applied with scripts/run-migration.mjs in one transaction.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ══ 1. Facts on the version ══════════════════════════════════════════════
alter table public.product_versions
  add column if not exists dimensions       text,
  add column if not exists blouse_piece     text,
  add column if not exists fit_note         text,
  add column if not exists finish           text,
  add column if not exists weave            text,
  add column if not exists origin           text,
  add column if not exists seo_title        text,
  add column if not exists meta_description text;

comment on column public.product_versions.dimensions is
  'Measured size, as written: "5.5 m × 1.15 m", "Adjustable, 18 mm band". Null = not measured. Never estimated.';
comment on column public.product_versions.blouse_piece is
  'Sarees: included | not_included. Null = not recorded.';
comment on column public.product_versions.fit_note is
  'Garments: how it fits and how to choose a size. Null = not written.';
comment on column public.product_versions.finish is
  'Jewellery: plating or surface finish, e.g. "14K gold plated". Null = not recorded.';
comment on column public.product_versions.weave is
  'Weave or technique, only when known: "Handloom", "Jamdani". Null = unknown — never inferred from the name.';
comment on column public.product_versions.origin is
  'Where it was made, only when known: "Chendamangalam, Kerala". Null = unknown — never inferred.';
comment on column public.product_versions.seo_title is
  'Custom search title, without the shop name (added on render). Null = use the product name.';
comment on column public.product_versions.meta_description is
  'Custom search snippet. Null = composed from the description or stored facts (lib/metadata).';

-- Blank is not a value: the form stores NULL for "nothing written", and the
-- storefront, the markup and the completeness check all test for NULL. A
-- whitespace-only cell would read as written and say nothing.
do $$ begin
  alter table public.product_versions
    add constraint product_versions_information_shape check (
      (blouse_piece is null or blouse_piece in ('included', 'not_included'))
      and (dimensions       is null or (btrim(dimensions)       <> '' and length(dimensions)       <= 200))
      and (fit_note         is null or (btrim(fit_note)         <> '' and length(fit_note)         <= 600))
      and (finish           is null or (btrim(finish)           <> '' and length(finish)           <= 120))
      and (weave            is null or (btrim(weave)            <> '' and length(weave)            <= 120))
      and (origin           is null or (btrim(origin)           <> '' and length(origin)           <= 120))
      and (seo_title        is null or (btrim(seo_title)        <> '' and length(seo_title)        <= 70))
      and (meta_description is null or (btrim(meta_description) <> '' and length(meta_description) <= 160))
    );
exception when duplicate_object then null; end $$;

-- ══ 2. Alt text per photograph ═══════════════════════════════════════════
alter table public.product_images
  add column if not exists alt_text text;

comment on column public.product_images.alt_text is
  'What this photograph shows, for someone who cannot see it. Null = not written; the
   storefront falls back to the product name (cover) or "name — image i of n".';

do $$ begin
  alter table public.product_images
    add constraint product_images_alt_text_shape check (
      alt_text is null or (btrim(alt_text) <> '' and length(alt_text) <= 250)
    );
exception when duplicate_object then null; end $$;

-- ══ 3. Product type per category ═════════════════════════════════════════
alter table public.category_versions
  add column if not exists product_profile text;

comment on column public.category_versions.product_profile is
  'Which product facts apply to products filed here: saree | drape | garment | jewellery |
   general. Null inherits the parent category''s; a top-level null is general.';

do $$ begin
  alter table public.category_versions
    add constraint category_versions_product_profile_check check (
      product_profile is null
      or product_profile in ('saree', 'drape', 'garment', 'jewellery', 'general')
    );
exception when duplicate_object then null; end $$;

-- Set from the category slugs that exist today — what each section IS, not a
-- guess about any product in it. Parents carry the default; four
-- sub-categories differ from their parent. Every other sub-category inherits.
-- Only live and draft rows; archived history is left as it was.
update public.category_versions
   set product_profile = case slug
         when 'jewellery' then 'jewellery'
         when 'men'       then 'garment'
         when 'women'     then 'garment'
       end
 where parent_id is null
   and slug in ('jewellery', 'men', 'women')
   and state in ('published', 'draft')
   and product_profile is null;

update public.category_versions
   set product_profile = case slug
         when 'sarees'      then 'saree'
         when 'dhotis'      then 'drape'
         when 'accessories' then 'general'
         when 'home'        then 'general'
       end
 where parent_id is not null
   and slug in ('sarees', 'dhotis', 'accessories', 'home')
   and state in ('published', 'draft')
   and product_profile is null;

-- ══ 4. Carry-through: the draft forks ════════════════════════════════════
-- Restated from 0051 with the new columns, and the gallery copy now carries
-- alt_text. Everything else is unchanged.
create or replace function public.ensure_product_draft(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
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
     heritage_note, craft_note, care_note,
     dimensions, blouse_piece, fit_note, finish, weave, origin,
     seo_title, meta_description)
  values
    (source.product_id, 'draft', source.version + 1, source.name, source.slug,
     source.description, source.price_inr, source.category_id, source.fabric,
     source.colour, source.stock_quantity, source.image_url, source.is_active,
     auth.uid(),
     source.collection, source.discount_type, source.discount_value,
     source.discount_starts_at, source.discount_ends_at,
     source.hsn_code, source.sku, source.cost_price_inr, source.video_youtube_id,
     source.heritage_note, source.craft_note, source.care_note,
     source.dimensions, source.blouse_piece, source.fit_note, source.finish,
     source.weave, source.origin,
     source.seo_title, source.meta_description)
  returning id into draft_id;

  insert into product_images (product_version_id, product_id, url, sort_order, alt_text)
  select draft_id, source.product_id, url, sort_order, alt_text
    from product_images
   where product_version_id = source.id;

  return draft_id;
end;
$fn$;

revoke execute on function public.ensure_product_draft(uuid) from public, anon;
grant execute on function public.ensure_product_draft(uuid) to authenticated, service_role;

-- Restated from 0012 with product_profile. Its search path now ends in pg_temp,
-- like every other draft helper since 0060.
create or replace function public.ensure_category_draft(p_category_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  draft_id uuid;
  source   category_versions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit categories';
  end if;

  select id into draft_id
    from category_versions
   where category_id = p_category_id and state = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;

  select * into source
    from category_versions
   where category_id = p_category_id and state = 'published';
  if not found then
    raise exception 'Category % has no published version to fork', p_category_id;
  end if;

  insert into category_versions
    (category_id, state, version, name, slug, parent_id, is_visible, sort_order,
     product_profile, created_by)
  values
    (source.category_id, 'draft', source.version + 1, source.name, source.slug,
     source.parent_id, source.is_visible, source.sort_order,
     source.product_profile, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$fn$;

revoke execute on function public.ensure_category_draft(uuid) from public, anon;
grant execute on function public.ensure_category_draft(uuid) to authenticated, service_role;

-- A gallery is the same only when its photographs AND what they say are the
-- same. URLs alone made an alt-text edit a "no-op", which settle_draft deletes.
create or replace function public.gallery_matches(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_array(url, alt_text) order by sort_order, url)
       from public.product_images where product_version_id = p_a),
    '[]'::jsonb
  ) = coalesce(
    (select jsonb_agg(jsonb_build_array(url, alt_text) order by sort_order, url)
       from public.product_images where product_version_id = p_b),
    '[]'::jsonb
  );
$$;

-- ══ 5. The rule ══════════════════════════════════════════════════════════

-- Which facts apply to a product in this category. The draft wins over the
-- published version, as everywhere in the admin, so what the form shows and
-- what publishing enforces are judged by the same type.
create or replace function public.category_product_profile(p_category_id uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  with own as (
    select cv.product_profile, cv.parent_id
      from public.category_versions cv
     where cv.category_id = p_category_id and cv.state in ('draft', 'published')
     order by (cv.state = 'draft') desc
     limit 1
  ), parent as (
    select pv.product_profile
      from public.category_versions pv
      join own on pv.category_id = own.parent_id
     where pv.state in ('draft', 'published')
     order by (pv.state = 'draft') desc
     limit 1
  )
  select coalesce((select product_profile from own),
                  (select product_profile from parent),
                  'general');
$$;

-- The required facts this version is missing, as the labels the admin sees, in
-- the order the form shows them. Empty when nothing is missing, when the
-- version deletes the product, or when it is hidden.
create or replace function public.product_info_missing(v public.product_versions)
returns text[]
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  profile text;
  missing text[] := array[]::text[];
begin
  if v.pending_delete or not v.is_active then
    return missing;
  end if;

  profile := public.category_product_profile(v.category_id);

  if profile in ('saree', 'drape', 'garment', 'jewellery')
     and nullif(btrim(v.fabric), '') is null then
    missing := array_append(missing, case when profile = 'jewellery' then 'Material' else 'Fabric' end);
  end if;

  if profile in ('saree', 'drape', 'garment')
     and nullif(btrim(v.colour), '') is null then
    missing := array_append(missing, 'Colour');
  end if;

  if nullif(btrim(v.care_note), '') is null then
    missing := array_append(missing, 'Care instructions');
  end if;

  -- The cover is the lowest sort_order, as on the storefront. A product with no
  -- photographs is 0042's question, not this one's.
  if exists (select 1 from public.product_images i where i.product_version_id = v.id)
     and (select nullif(btrim(i.alt_text), '')
            from public.product_images i
           where i.product_version_id = v.id
           order by i.sort_order, i.url
           limit 1) is null then
    missing := array_append(missing, 'Main image alt text');
  end if;

  return missing;
end;
$fn$;

-- One sentence, one bullet per field. Written for the admin; it is raised as
-- P0001, which lib/adminStatus shows exactly as written.
create or replace function public.product_info_message(p_name text, p_missing text[])
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select format('Complete these before publishing “%s”:', coalesce(nullif(btrim(p_name), ''), 'this product'))
         || E'\n• ' || array_to_string(p_missing, E'\n• ');
$$;

create or replace function public.require_product_info_to_publish()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  missing text[];
begin
  missing := public.product_info_missing(new);
  if cardinality(missing) > 0 then
    raise exception '%', public.product_info_message(new.name, missing)
      using hint = 'Saving a draft is unaffected. Fill these in on the product, then publish again.';
  end if;
  return new;
end;
$fn$;

-- Fires after 0042's photograph check (triggers of one kind fire in name
-- order), on exactly the same transition: a version BECOMING published.
drop trigger if exists require_info_before_publish on public.product_versions;
create trigger require_info_before_publish
  before update of state on public.product_versions
  for each row
  when (new.state = 'published' and old.state is distinct from 'published')
  execute function public.require_product_info_to_publish();

-- validate_publish, restated from 0042 with one more question at the end, so
-- publish_all refuses BEFORE anything goes live and names the product and the
-- fields — rather than the trigger stopping it halfway through.
create or replace function public.validate_publish()
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  offender text;
  missing  text[];
  others   integer;
begin
  select pv.name into offender
    from product_versions pv
   where pv.state = 'draft'
     and not pv.pending_delete
     and pv.category_id is not null
     and not exists (
       select 1 from category_versions cv
        where cv.category_id = pv.category_id
          and (cv.state = 'published' or cv.state = 'draft')
     )
   limit 1;

  if offender is not null then
    return format('"%s" is in a category that no longer exists. Reassign it before publishing.', offender);
  end if;

  select pv.name into offender
    from product_versions pv
   where pv.state = 'draft' and not pv.pending_delete
     and (pv.name = '' or pv.slug = '')
   limit 1;

  if offender is not null then
    return 'A product is missing its name or web address. Finish it or delete it before publishing.';
  end if;

  select pv.name into offender
    from product_versions pv
   where pv.state = 'draft'
     and not pv.pending_delete
     and not pv.allow_no_images
     and not exists (
       select 1 from product_images pi where pi.product_version_id = pv.id
     )
   limit 1;

  if offender is not null then
    return format(
      '"%s" has no photographs. Add one, or tick "publish without images" on that product.',
      coalesce(nullif(offender, ''), 'A product')
    );
  end if;

  -- New in 0065.
  with gaps as (
    select pv.name as product_name, public.product_info_missing(pv) as gap_fields
      from product_versions pv
     where pv.state = 'draft' and not pv.pending_delete
  ), incomplete as (
    select product_name, gap_fields from gaps where cardinality(gap_fields) > 0
  )
  select i.product_name, i.gap_fields, (select count(*) - 1 from incomplete)
    into offender, missing, others
    from incomplete i
   order by i.product_name
   limit 1;

  if found then
    return public.product_info_message(offender, missing)
      || case when others > 0
              then format(E'\n\n%s other product%s also need%s information before publishing — publish items one at a time from Review & Publish to see each.',
                          others, case when others = 1 then '' else 's' end, case when others = 1 then 's' else '' end)
              else '' end;
  end if;

  return null;
end;
$$;

-- ══ 6. Who can call what ═════════════════════════════════════════════════
-- The new functions are called from inside the SECURITY DEFINER publish and
-- validate paths, never by the API roles. Explicitly closed, whatever the
-- project's default privileges grant (0064's lesson: assume nothing).
revoke execute on function public.category_product_profile(uuid)               from public, anon, authenticated;
revoke execute on function public.product_info_missing(public.product_versions) from public, anon, authenticated;
revoke execute on function public.product_info_message(text, text[])           from public, anon, authenticated;
revoke execute on function public.require_product_info_to_publish()            from public, anon, authenticated;
grant  execute on function public.category_product_profile(uuid)               to service_role;
grant  execute on function public.product_info_missing(public.product_versions) to service_role;
grant  execute on function public.product_info_message(text, text[])           to service_role;
grant  execute on function public.require_product_info_to_publish()            to service_role;

-- ══ 7. Refuse to commit a half-applied migration ═════════════════════════
do $$
declare
  problems text[] := array[]::text[];
  r  text;
  fn text;
  col text;
begin
  foreach col in array array['dimensions', 'blouse_piece', 'fit_note', 'finish', 'weave', 'origin',
                             'seo_title', 'meta_description'] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'product_versions' and column_name = col) then
      problems := problems || format('product_versions.%s missing', col);
    end if;
    if not exists (select 1 from pg_proc where oid = 'public.ensure_product_draft(uuid)'::regprocedure
                    and prosrc like '%source.' || col || '%') then
      problems := problems || format('ensure_product_draft does not carry %s', col);
    end if;
  end loop;

  if not exists (select 1 from pg_proc where oid = 'public.ensure_product_draft(uuid)'::regprocedure
                  and prosrc like '%alt_text%') then
    problems := problems || 'ensure_product_draft does not copy alt_text'::text;
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.ensure_category_draft(uuid)'::regprocedure
                  and prosrc like '%source.product_profile%') then
    problems := problems || 'ensure_category_draft does not carry product_profile'::text;
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.gallery_matches(uuid, uuid)'::regprocedure
                  and prosrc like '%alt_text%') then
    problems := problems || 'gallery_matches ignores alt_text'::text;
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.validate_publish()'::regprocedure
                  and prosrc like '%product_info_missing%') then
    problems := problems || 'validate_publish does not check product information'::text;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'require_info_before_publish'
                  and tgrelid = 'public.product_versions'::regclass) then
    problems := problems || 'require_info_before_publish trigger missing'::text;
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    foreach fn in array array['public.category_product_profile(uuid)',
                              'public.product_info_missing(public.product_versions)',
                              'public.product_info_message(text, text[])',
                              'public.require_product_info_to_publish()'] loop
      if has_function_privilege(r, fn, 'EXECUTE') then
        problems := problems || format('%s can execute %s', r, fn);
      end if;
    end loop;
  end loop;
  if has_function_privilege('anon', 'public.ensure_product_draft(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ensure_category_draft(uuid)', 'EXECUTE') then
    problems := problems || 'anon can execute a draft helper'::text;
  end if;

  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0065_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
-- Live products are untouched (the rule only fires on a version BECOMING
-- published), and none of the new facts hold anything yet.
select
  (select count(*) from product_versions where state = 'published') as published_products,
  (select count(*) from product_versions
    where dimensions is not null or blouse_piece is not null or fit_note is not null
       or finish is not null or weave is not null or origin is not null
       or seo_title is not null or meta_description is not null) as versions_with_new_facts,
  (select count(*) from product_images where alt_text is not null) as images_with_alt,
  (select string_agg(slug || '=' || product_profile, ', ' order by slug)
     from category_versions where state = 'published' and product_profile is not null) as category_profiles,
  (select count(*) from product_versions pv
    where pv.state = 'published' and cardinality(public.product_info_missing(pv)) > 0) as live_products_missing_required_facts;
