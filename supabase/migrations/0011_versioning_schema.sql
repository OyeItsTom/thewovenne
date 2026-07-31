-- 0011 — Draft/published versioning: schema and backfill
--
-- Splits identity from content. products/categories/journal_posts keep their id
-- (so every foreign key in the database stays valid); the editable fields move
-- to *_versions rows carrying a state.
--
--   published : what the storefront reads. Exactly one per entity.
--   draft     : unpublished edits. At most one per entity, and it exists ONLY
--               when there are pending changes — so "is anything waiting to go
--               live?" is "does a draft row exist?", not a column-by-column diff.
--   archived  : superseded published rows, kept for history and rollback.
--
-- Drafts are created lazily, copy-on-write, by the helpers in 0012.
--
-- This migration is ADDITIVE. The existing content columns on products,
-- categories and journal_posts stay in place and keep working, so the
-- application can be moved over one phase at a time. A later migration drops
-- them once nothing reads them.
--
-- Requires 0001 (tables), 0002 (is_admin), 0006 (product_images).

-- ── Products ─────────────────────────────────
create table if not exists product_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  state text not null check (state in ('draft', 'published', 'archived')),
  version integer not null default 1,
  -- A draft that deletes the product. The product stays live until published,
  -- which is what "nothing changes until I publish" has to mean for deletion.
  pending_delete boolean not null default false,

  name text not null,
  slug text not null,
  description text,
  price_inr numeric(10,2) not null,
  -- References the category IDENTITY, never a category version. The storefront
  -- resolves the published version at read time; pointing at a version would
  -- make publishing one thing cascade through everything referencing it.
  category_id uuid references categories(id) on delete set null,
  fabric text,
  colour text,
  stock_quantity integer not null default 0,
  image_url text,
  is_active boolean not null default true,

  created_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

-- ── Categories ───────────────────────────────
create table if not exists category_versions (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  state text not null check (state in ('draft', 'published', 'archived')),
  version integer not null default 1,
  pending_delete boolean not null default false,

  name text not null,
  slug text not null,
  parent_id uuid references categories(id) on delete cascade,
  is_visible boolean not null default true,
  sort_order integer not null default 0,

  created_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

-- ── Journal ──────────────────────────────────
create table if not exists journal_versions (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references journal_posts(id) on delete cascade,
  state text not null check (state in ('draft', 'published', 'archived')),
  version integer not null default 1,
  pending_delete boolean not null default false,

  title text not null,
  slug text not null,
  body text,
  image_url text,
  -- The post's own published flag, distinct from the version's state: a post
  -- can be a published VERSION that is still an unpublished POST.
  published boolean not null default false,

  created_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

-- ── Invariants ───────────────────────────────
-- One draft and one published per entity, enforced by the database rather than
-- by application discipline.
create unique index if not exists product_versions_one_draft
  on product_versions (product_id) where state = 'draft';
create unique index if not exists product_versions_one_published
  on product_versions (product_id) where state = 'published';
create unique index if not exists category_versions_one_draft
  on category_versions (category_id) where state = 'draft';
create unique index if not exists category_versions_one_published
  on category_versions (category_id) where state = 'published';
create unique index if not exists journal_versions_one_draft
  on journal_versions (journal_id) where state = 'draft';
create unique index if not exists journal_versions_one_published
  on journal_versions (journal_id) where state = 'published';

-- Slugs are public URLs: unique within a state, not across states (a draft and
-- its published counterpart share one).
create unique index if not exists product_versions_slug_published
  on product_versions (slug) where state = 'published';
create unique index if not exists product_versions_slug_draft
  on product_versions (slug) where state = 'draft';
create unique index if not exists category_versions_slug_published
  on category_versions (slug) where state = 'published';
create unique index if not exists category_versions_slug_draft
  on category_versions (slug) where state = 'draft';
create unique index if not exists journal_versions_slug_published
  on journal_versions (slug) where state = 'published';
create unique index if not exists journal_versions_slug_draft
  on journal_versions (slug) where state = 'draft';

-- Read paths: "the published version of X", and "everything published".
create index if not exists product_versions_state_idx on product_versions (state, product_id);
create index if not exists category_versions_state_idx on category_versions (state, category_id);
create index if not exists journal_versions_state_idx on journal_versions (state, journal_id);
create index if not exists product_versions_category_idx on product_versions (category_id) where state = 'published';

-- ── Galleries follow their version ───────────
-- Attaching images to the version means promoting a draft carries its gallery
-- with it, with no copying and no window where a product has the wrong photos.
-- product_id is kept for now so the current read path keeps working; a later
-- migration drops it.
alter table product_images
  add column if not exists product_version_id uuid references product_versions(id) on delete cascade;
create index if not exists product_images_version_idx
  on product_images (product_version_id, sort_order);

-- ── Backfill: everything currently live becomes a published version ──
-- No drafts are created: nothing has unpublished changes yet, which is exactly
-- what an empty draft set means. Nothing needs republishing to stay as it is.
insert into product_versions
  (product_id, state, version, name, slug, description, price_inr, category_id,
   fabric, colour, stock_quantity, image_url, is_active, published_at)
select p.id, 'published', 1, p.name, p.slug, p.description, p.price_inr,
       p.category_id, p.fabric, p.colour, coalesce(p.stock_quantity, 0),
       p.image_url, coalesce(p.is_active, true), now()
from products p
where not exists (
  select 1 from product_versions v where v.product_id = p.id and v.state = 'published'
);

insert into category_versions
  (category_id, state, version, name, slug, parent_id, is_visible, sort_order, published_at)
select c.id, 'published', 1, c.name, c.slug, c.parent_id,
       coalesce(c.is_visible, true), coalesce(c.sort_order, 0), now()
from categories c
where not exists (
  select 1 from category_versions v where v.category_id = c.id and v.state = 'published'
);

insert into journal_versions
  (journal_id, state, version, title, slug, body, image_url, published, published_at)
select j.id, 'published', 1, j.title, j.slug, j.body, j.image_url,
       coalesce(j.published, false), now()
from journal_posts j
where not exists (
  select 1 from journal_versions v where v.journal_id = j.id and v.state = 'published'
);

-- Point existing gallery rows at their product's published version.
update product_images i
   set product_version_id = v.id
  from product_versions v
 where v.product_id = i.product_id
   and v.state = 'published'
   and i.product_version_id is null;

-- ── RLS ──────────────────────────────────────
alter table product_versions enable row level security;
alter table category_versions enable row level security;
alter table journal_versions enable row level security;

-- Public reads published versions only. Drafts are invisible to the storefront
-- by policy, not merely by query — a mistake in application code cannot leak
-- unpublished work.
drop policy if exists "Public can view published product versions" on product_versions;
create policy "Public can view published product versions"
  on product_versions for select using (state = 'published');
drop policy if exists "Admins can view all product versions" on product_versions;
create policy "Admins can view all product versions"
  on product_versions for select to authenticated using (public.is_admin());
drop policy if exists "Admins can write product versions" on product_versions;
create policy "Admins can write product versions"
  on product_versions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public can view published category versions" on category_versions;
create policy "Public can view published category versions"
  on category_versions for select using (state = 'published');
drop policy if exists "Admins can view all category versions" on category_versions;
create policy "Admins can view all category versions"
  on category_versions for select to authenticated using (public.is_admin());
drop policy if exists "Admins can write category versions" on category_versions;
create policy "Admins can write category versions"
  on category_versions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public can view published journal versions" on journal_versions;
create policy "Public can view published journal versions"
  on journal_versions for select using (state = 'published');
drop policy if exists "Admins can view all journal versions" on journal_versions;
create policy "Admins can view all journal versions"
  on journal_versions for select to authenticated using (public.is_admin());
drop policy if exists "Admins can write journal versions" on journal_versions;
create policy "Admins can write journal versions"
  on journal_versions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on product_versions, category_versions, journal_versions to anon, authenticated;
grant insert, update, delete on product_versions, category_versions, journal_versions to authenticated;
grant all privileges on product_versions, category_versions, journal_versions to service_role;

-- ── Check ────────────────────────────────────
-- published counts must equal the source tables; drafts must be 0.
select
  (select count(*) from products)            as products,
  (select count(*) from product_versions where state = 'published') as product_published,
  (select count(*) from product_versions where state = 'draft')     as product_drafts,
  (select count(*) from categories)          as categories,
  (select count(*) from category_versions where state = 'published') as category_published,
  (select count(*) from journal_posts)       as journal,
  (select count(*) from journal_versions where state = 'published')  as journal_published,
  (select count(*) from product_images where product_version_id is null) as orphan_images;
