-- 0012 — Copy-on-write draft helpers
--
-- Drafts exist only while there are unpublished changes, so the admin has to be
-- able to say "give me a draft of this" without caring whether one exists yet.
-- These do that atomically: returning an existing draft, or forking one from the
-- published version, gallery included.
--
-- Doing it in SQL rather than the client matters for the gallery — a fork that
-- copied the version but failed partway through the images would leave a draft
-- showing the wrong photos.
--
-- Requires 0011.
--
-- SUPERSEDED IN PART: ensure_product_draft() was rewritten by 0016 (campaign
-- columns) and pending_changes() by 0018 (ignores no-op drafts). Re-running
-- THIS file reverts both, silently — a product edit would start wiping its
-- own campaign fields. Re-run 0016 and 0018 afterwards if you ever need to.

-- ── Products ─────────────────────────────────
create or replace function public.ensure_product_draft(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_id uuid;
  source   product_versions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit products';
  end if;

  select id into draft_id
    from product_versions
   where product_id = p_product_id and state = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;

  select * into source
    from product_versions
   where product_id = p_product_id and state = 'published';
  if not found then
    raise exception 'Product % has no published version to fork', p_product_id;
  end if;

  insert into product_versions
    (product_id, state, version, name, slug, description, price_inr, category_id,
     fabric, colour, stock_quantity, image_url, is_active, created_by)
  values
    (source.product_id, 'draft', source.version + 1, source.name, source.slug,
     source.description, source.price_inr, source.category_id, source.fabric,
     source.colour, source.stock_quantity, source.image_url, source.is_active,
     auth.uid())
  returning id into draft_id;

  -- The gallery is part of the version, so the fork has to carry it.
  insert into product_images (product_version_id, product_id, url, sort_order)
  select draft_id, source.product_id, url, sort_order
    from product_images
   where product_version_id = source.id
   order by sort_order;

  return draft_id;
end;
$$;

-- A product that has never been published: identity plus a draft, no published
-- version. It stays invisible to the storefront until the first publish.
create or replace function public.create_product_draft()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_product uuid;
  draft_id    uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create products';
  end if;

  insert into products default values returning id into new_product;

  insert into product_versions
    (product_id, state, version, name, slug, price_inr, created_by)
  values
    (new_product, 'draft', 1, '', '', 0, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$$;

-- ── Categories ───────────────────────────────
create or replace function public.ensure_category_draft(p_category_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    (category_id, state, version, name, slug, parent_id, is_visible, sort_order, created_by)
  values
    (source.category_id, 'draft', source.version + 1, source.name, source.slug,
     source.parent_id, source.is_visible, source.sort_order, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$$;

create or replace function public.create_category_draft(
  p_name text,
  p_slug text,
  p_parent_id uuid,
  p_sort_order integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_category uuid;
  draft_id     uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create categories';
  end if;

  insert into categories (name, slug, parent_id, is_visible, sort_order)
  values (p_name, p_slug, p_parent_id, false, coalesce(p_sort_order, 0))
  returning id into new_category;

  insert into category_versions
    (category_id, state, version, name, slug, parent_id, is_visible, sort_order, created_by)
  values
    (new_category, 'draft', 1, p_name, p_slug, p_parent_id, false,
     coalesce(p_sort_order, 0), auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$$;

-- ── Journal ──────────────────────────────────
create or replace function public.ensure_journal_draft(p_journal_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_id uuid;
  source   journal_versions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit journal posts';
  end if;

  select id into draft_id
    from journal_versions
   where journal_id = p_journal_id and state = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;

  select * into source
    from journal_versions
   where journal_id = p_journal_id and state = 'published';
  if not found then
    raise exception 'Journal post % has no published version to fork', p_journal_id;
  end if;

  insert into journal_versions
    (journal_id, state, version, title, slug, body, image_url, published, created_by)
  values
    (source.journal_id, 'draft', source.version + 1, source.title, source.slug,
     source.body, source.image_url, source.published, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$$;

create or replace function public.create_journal_draft()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_post uuid;
  draft_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create journal posts';
  end if;

  insert into journal_posts (title, slug, published)
  values ('', gen_random_uuid()::text, false)
  returning id into new_post;

  insert into journal_versions
    (journal_id, state, version, title, slug, body, published, created_by)
  values
    (new_post, 'draft', 1, '', gen_random_uuid()::text, null, false, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$$;

-- ── Counting what is waiting ─────────────────
-- Drafts exist only when there are unpublished changes, so this is a row count
-- rather than a column-by-column comparison.
create or replace function public.pending_changes()
returns table (products integer, categories integer, journal integer, content integer)
language sql
security definer
stable
set search_path = public
as $$
  select
    (select count(*)::integer from product_versions  where state = 'draft'),
    (select count(*)::integer from category_versions where state = 'draft'),
    (select count(*)::integer from journal_versions  where state = 'draft'),
    (select count(*)::integer from site_content
      where draft_value is distinct from value);
$$;

revoke execute on function
  public.ensure_product_draft(uuid), public.create_product_draft(),
  public.ensure_category_draft(uuid), public.create_category_draft(text, text, uuid, integer),
  public.ensure_journal_draft(uuid), public.create_journal_draft(),
  public.pending_changes()
  from public;

grant execute on function
  public.ensure_product_draft(uuid), public.create_product_draft(),
  public.ensure_category_draft(uuid), public.create_category_draft(text, text, uuid, integer),
  public.ensure_journal_draft(uuid), public.create_journal_draft(),
  public.pending_changes()
  to authenticated;

select * from public.pending_changes();
