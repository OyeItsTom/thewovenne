-- 0015 — Editable content pages
--
-- About, Size Guide, Policies, Contact, FAQ and anything added later become
-- CONTENT rather than code, so changing copy or a photo never needs a
-- developer or a deploy.
--
-- Follows 0011's identity/version split exactly, which means publish_all(),
-- discard_drafts(), pending_changes() and the audit triggers all extend to
-- pages by adding a few statements rather than inventing a second mechanism.
--
-- Body is a jsonb array of blocks:
--   [{ "type": "heading",   "text": "…" },
--    { "type": "paragraph", "text": "…" },
--    { "type": "image",     "url": "…", "alt": "…" },
--    { "type": "faq",       "question": "…", "answer": "…" }]
--
-- Blocks rather than raw HTML on purpose: the renderer controls typography and
-- spacing, so an edit cannot break the page's look, and pasted markup cannot
-- inject anything.
--
-- Requires 0002 (is_admin) and 0011 (the versioning pattern).

create table if not exists site_pages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists site_page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references site_pages(id) on delete cascade,
  state text not null check (state in ('draft', 'published', 'archived')),
  version integer not null default 1,
  pending_delete boolean not null default false,

  slug text not null,
  title text not null,
  -- Optional short intro rendered above the blocks.
  intro text,
  body jsonb not null default '[]'::jsonb,
  -- Shown in the footer's page list when true.
  in_footer boolean not null default true,
  sort_order integer not null default 0,
  meta_description text,

  created_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create unique index if not exists site_page_versions_one_draft
  on site_page_versions (page_id) where state = 'draft';
create unique index if not exists site_page_versions_one_published
  on site_page_versions (page_id) where state = 'published';
create unique index if not exists site_page_versions_slug_published
  on site_page_versions (slug) where state = 'published';
create unique index if not exists site_page_versions_slug_draft
  on site_page_versions (slug) where state = 'draft';
create index if not exists site_page_versions_state_idx
  on site_page_versions (state, page_id);

alter table site_page_versions enable row level security;

drop policy if exists "Public can view published pages" on site_page_versions;
create policy "Public can view published pages"
  on site_page_versions for select using (state = 'published');
drop policy if exists "Admins can view all pages" on site_page_versions;
create policy "Admins can view all pages"
  on site_page_versions for select to authenticated using (public.is_admin());
drop policy if exists "Admins can write pages" on site_page_versions;
create policy "Admins can write pages"
  on site_page_versions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on site_pages, site_page_versions to anon, authenticated;
grant insert, update, delete on site_pages, site_page_versions to authenticated;
grant all privileges on site_pages, site_page_versions to service_role;

-- ── Draft helpers, matching 0012 ──────────────
create or replace function public.ensure_page_draft(p_page_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_id uuid;
  source   site_page_versions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit pages';
  end if;

  select id into draft_id from site_page_versions
   where page_id = p_page_id and state = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;

  select * into source from site_page_versions
   where page_id = p_page_id and state = 'published';
  if not found then
    raise exception 'Page % has no published version to fork', p_page_id;
  end if;

  insert into site_page_versions
    (page_id, state, version, slug, title, intro, body, in_footer, sort_order,
     meta_description, created_by)
  values
    (source.page_id, 'draft', source.version + 1, source.slug, source.title,
     source.intro, source.body, source.in_footer, source.sort_order,
     source.meta_description, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$$;

create or replace function public.create_page_draft(p_title text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_page uuid;
  draft_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create pages';
  end if;

  insert into site_pages default values returning id into new_page;

  insert into site_page_versions
    (page_id, state, version, slug, title, body, created_by)
  values (new_page, 'draft', 1, p_slug, p_title, '[]'::jsonb, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$$;

revoke execute on function
  public.ensure_page_draft(uuid), public.create_page_draft(text, text) from public;
grant execute on function
  public.ensure_page_draft(uuid), public.create_page_draft(text, text) to authenticated;

-- ── Extend the existing publish machinery ─────
-- Pages join the same transaction rather than getting their own button.
create or replace function public.pending_changes()
returns table (products integer, categories integer, journal integer,
               content integer, pages integer)
language sql
security definer
stable
set search_path = public
as $$
  select
    (select count(*)::integer from product_versions   where state = 'draft'),
    (select count(*)::integer from category_versions  where state = 'draft'),
    (select count(*)::integer from journal_versions   where state = 'draft'),
    (select count(*)::integer from site_content
      where draft_value is distinct from value),
    (select count(*)::integer from site_page_versions where state = 'draft');
$$;

revoke execute on function public.pending_changes() from public;
grant execute on function public.pending_changes() to authenticated;

-- publish_all must promote pages too, in the same transaction as everything
-- else — a page that staged forever would be a silent dead end.
create or replace function public.publish_all()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  problem      text;
  n_products   integer := 0;
  n_categories integer := 0;
  n_journal    integer := 0;
  n_content    integer := 0;
  n_pages      integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Only admins can publish';
  end if;

  problem := public.validate_publish();
  if problem is not null then
    raise exception '%', problem;
  end if;

  update categories c
     set name = d.name, slug = d.slug, parent_id = d.parent_id,
         is_visible = d.is_visible, sort_order = d.sort_order
    from category_versions d
   where d.category_id = c.id and d.state = 'draft' and not d.pending_delete;
  update category_versions set state = 'archived'
   where state = 'published'
     and category_id in (select category_id from category_versions where state = 'draft');
  with promoted as (
    update category_versions set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete returning 1
  ) select count(*) into n_categories from promoted;
  delete from categories
   where id in (select category_id from category_versions where state = 'draft' and pending_delete);

  update products p
     set name = d.name, slug = d.slug, description = d.description,
         price_inr = d.price_inr, category_id = d.category_id, fabric = d.fabric,
         colour = d.colour, stock_quantity = d.stock_quantity,
         image_url = d.image_url, is_active = d.is_active
    from product_versions d
   where d.product_id = p.id and d.state = 'draft' and not d.pending_delete;
  update product_versions set state = 'archived'
   where state = 'published'
     and product_id in (select product_id from product_versions where state = 'draft');
  with promoted as (
    update product_versions set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete returning 1
  ) select count(*) into n_products from promoted;
  delete from products
   where id in (select product_id from product_versions where state = 'draft' and pending_delete);

  update journal_posts j
     set title = d.title, slug = d.slug, body = d.body,
         image_url = d.image_url, published = d.published
    from journal_versions d
   where d.journal_id = j.id and d.state = 'draft' and not d.pending_delete;
  update journal_versions set state = 'archived'
   where state = 'published'
     and journal_id in (select journal_id from journal_versions where state = 'draft');
  with promoted as (
    update journal_versions set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete returning 1
  ) select count(*) into n_journal from promoted;
  delete from journal_posts
   where id in (select journal_id from journal_versions where state = 'draft' and pending_delete);

  update site_page_versions set state = 'archived'
   where state = 'published'
     and page_id in (select page_id from site_page_versions where state = 'draft');
  with promoted as (
    update site_page_versions set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete returning 1
  ) select count(*) into n_pages from promoted;
  delete from site_pages
   where id in (select page_id from site_page_versions where state = 'draft' and pending_delete);

  with updated as (
    update site_content set value = draft_value, updated_at = now()
     where draft_value is not null and draft_value is distinct from value returning 1
  ) select count(*) into n_content from updated;

  return jsonb_build_object(
    'products', n_products, 'categories', n_categories, 'journal', n_journal,
    'content', n_content, 'pages', n_pages,
    'total', n_products + n_categories + n_journal + n_content + n_pages
  );
end;
$$;

create or replace function public.discard_drafts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_products integer; n_categories integer; n_journal integer;
  n_content integer; n_pages integer;
begin
  if not public.is_admin() then
    raise exception 'Only admins can discard drafts';
  end if;

  delete from products p
   where not exists (select 1 from product_versions v
                      where v.product_id = p.id and v.state = 'published');
  with d as (delete from product_versions where state = 'draft' returning 1)
    select count(*) into n_products from d;

  delete from categories c
   where not exists (select 1 from category_versions v
                      where v.category_id = c.id and v.state = 'published');
  with d as (delete from category_versions where state = 'draft' returning 1)
    select count(*) into n_categories from d;

  delete from journal_posts j
   where not exists (select 1 from journal_versions v
                      where v.journal_id = j.id and v.state = 'published');
  with d as (delete from journal_versions where state = 'draft' returning 1)
    select count(*) into n_journal from d;

  delete from site_pages sp
   where not exists (select 1 from site_page_versions v
                      where v.page_id = sp.id and v.state = 'published');
  with d as (delete from site_page_versions where state = 'draft' returning 1)
    select count(*) into n_pages from d;

  with u as (update site_content set draft_value = value
              where draft_value is distinct from value returning 1)
    select count(*) into n_content from u;

  return jsonb_build_object(
    'products', n_products, 'categories', n_categories, 'journal', n_journal,
    'content', n_content, 'pages', n_pages
  );
end;
$$;

revoke execute on function public.publish_all(), public.discard_drafts() from public;
grant execute on function public.publish_all(), public.discard_drafts() to authenticated;

drop trigger if exists audit_site_page_versions on site_page_versions;
create trigger audit_site_page_versions
  after insert or update or delete on site_page_versions
  for each row execute function public.log_admin_action();

-- ── Seed the five pages everyone expects ──────
-- Published immediately with placeholder copy: a live site with an empty
-- Contact page is better than one with a 404 where Contact should be, and
-- every word here is editable from the admin.
do $$
declare
  page_row  record;
  new_page  uuid;
begin
  for page_row in
    select * from (values
      ('about',      'Our Story',  1,
       'Woven in Kerala, sent direct from the loom.',
       '[{"type":"paragraph","text":"THE WOVENNE works directly with handloom artisans across Kerala. No middleman, no compromise — just honest cloth, woven the way it has been for generations."},{"type":"heading","text":"The loom houses"},{"type":"paragraph","text":"Replace this text from the admin panel. Add images, headings and paragraphs as you like."}]'),
      ('size-guide', 'Size Guide', 2,
       'Measurements for every piece we make.',
       '[{"type":"paragraph","text":"Add your measurements here. This page is fully editable from the admin panel."}]'),
      ('policies',   'Policies',   3,
       'Shipping, returns and privacy.',
       '[{"type":"heading","text":"Shipping"},{"type":"paragraph","text":"Add your shipping policy here."},{"type":"heading","text":"Returns"},{"type":"paragraph","text":"Add your returns policy here."},{"type":"heading","text":"Privacy"},{"type":"paragraph","text":"Add your privacy policy here."}]'),
      ('contact',    'Contact',    4,
       'We answer every message ourselves.',
       '[{"type":"paragraph","text":"Add your contact details here — email, WhatsApp, address."}]'),
      ('faq',        'FAQ',        5,
       'The questions we are asked most.',
       '[{"type":"faq","question":"Is this real handloom linen?","answer":"Edit this answer from the admin panel."},{"type":"faq","question":"How long does delivery take?","answer":"Edit this answer from the admin panel."}]')
    ) as v(slug, title, sort_order, intro, body)
  loop
    if exists (select 1 from site_page_versions where slug = page_row.slug) then
      continue;
    end if;

    insert into site_pages default values returning id into new_page;

    insert into site_page_versions
      (page_id, state, version, slug, title, intro, body, in_footer, sort_order,
       meta_description, published_at)
    values
      (new_page, 'published', 1, page_row.slug, page_row.title, page_row.intro,
       page_row.body::jsonb, true, page_row.sort_order, page_row.intro, now());
  end loop;
end $$;

-- Check: five published pages, no drafts.
select slug, title, state from site_page_versions order by sort_order;
