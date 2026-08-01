-- 0017 — Hierarchical product URLs, with a redirect history
--
-- Products move from /product/<slug> to /<parent>/<child>/<slug>, e.g.
-- /women/sarees/kerala-kasavu. The old URLs keep working permanently: they 301
-- to the canonical one rather than 404ing, so nothing already linked or indexed
-- is lost.
--
-- The history table is what makes a URL change safe FOREVER, not just this
-- once. Every path a product has ever been published at is recorded, so renaming
-- a product or moving it between categories leaves its old links redirecting
-- instead of breaking. Without this, the second rename silently breaks every
-- link earned by the first.
--
-- Requires 0011 (versioning).

-- ── Canonical path for a product ──────────────
-- Resolved from PUBLISHED category versions, because that is the hierarchy
-- customers actually see. Returns null when the product has no category or the
-- category has no published parent — callers fall back to /product/<slug>.
create or replace function public.product_path(p_product_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select '/' || parent.slug || '/' || child.slug || '/' || pv.slug
    from product_versions pv
    join category_versions child
      on child.category_id = pv.category_id and child.state = 'published'
    join category_versions parent
      on parent.category_id = child.parent_id and parent.state = 'published'
   where pv.product_id = p_product_id
     and pv.state = 'published'
   limit 1;
$$;

grant execute on function public.product_path(uuid) to anon, authenticated, service_role;

-- ── Every path a product has ever had ─────────
create table if not exists product_url_history (
  path text primary key,
  product_id uuid not null references products(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists product_url_history_product_idx
  on product_url_history (product_id);

alter table product_url_history enable row level security;

-- Public read: resolving an old URL happens for anonymous visitors, and the
-- table holds nothing but paths that were already public.
do $$ begin
  create policy "Anyone can read url history"
    on product_url_history for select using (true);
exception when duplicate_object then null; end $$;

grant select on product_url_history to anon, authenticated;
grant all on product_url_history to service_role;

-- ── Record paths as they are published ────────
-- Fires on the row becoming published, which is exactly when a path starts
-- being reachable. Recording drafts would create redirects to work that was
-- never live.
create or replace function public.record_product_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p text;
begin
  if new.state <> 'published' then
    return new;
  end if;

  select public.product_path(new.product_id) into p;
  if p is null then
    return new;
  end if;

  -- on conflict do nothing: the same path republished is not a new redirect,
  -- and a path must only ever map to the product that first claimed it.
  insert into product_url_history (path, product_id)
  values (p, new.product_id)
  on conflict (path) do nothing;

  -- The legacy flat URL is part of the history too, so /product/<slug> keeps
  -- resolving after a rename.
  insert into product_url_history (path, product_id)
  values ('/product/' || new.slug, new.product_id)
  on conflict (path) do nothing;

  return new;
end;
$$;

drop trigger if exists record_product_path_trigger on product_versions;
create trigger record_product_path_trigger
  after insert or update on product_versions
  for each row execute function public.record_product_path();

-- ── Backfill what is already live ─────────────
insert into product_url_history (path, product_id)
select public.product_path(pv.product_id), pv.product_id
  from product_versions pv
 where pv.state = 'published'
   and public.product_path(pv.product_id) is not null
on conflict (path) do nothing;

insert into product_url_history (path, product_id)
select '/product/' || pv.slug, pv.product_id
  from product_versions pv
 where pv.state = 'published'
on conflict (path) do nothing;

-- ── Resolve any old path to where it lives now ─
-- Returns the product's CURRENT canonical path, or null if the path is unknown
-- or the product is gone. One round trip for the redirect lookup.
create or replace function public.resolve_product_path(p_path text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.product_path(h.product_id)
    from product_url_history h
   where h.path = p_path
   limit 1;
$$;

grant execute on function public.resolve_product_path(text) to anon, authenticated, service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from product_url_history) as recorded_paths,
  (select count(*) from product_versions where state = 'published') as published_products,
  (select json_agg(json_build_object('path', path)) from product_url_history) as paths;
