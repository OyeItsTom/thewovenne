-- 0071 — A registry of delivery-sized copies of product photographs
--
-- WHY. Supabase cached egress ran over the free quota (5.36 / 5 GB, cycle
-- 14 Sep – 14 Oct 2026). The cause, from Supabase's edge logs and Vercel's
-- usage: image optimizers downloading whole masters — 2400px short edge, JPEG
-- q92, ~3.2 MB each — once per photograph, width, region and server, to make
-- copies a fraction of that size. Nothing the site shows is wider than 1920px.
--
-- WHAT. Two smaller copies per master ("derivatives", lib/imageVariants), kept
-- under new names in the same public bucket at derived/…, and this table saying
-- which exist. The storefront uses a derivative ONLY when a row here says it is
-- ready for the current recipe; otherwise it keeps pointing at the master,
-- which is what it does today. So this table being empty — the state this
-- migration leaves it in — changes nothing anyone sees.
--
-- A ROW IS A FACT ABOUT A PUBLIC FILE: its key, size, dimensions and MD5. No
-- customer, order or product data. It is readable by everyone because the
-- storefront reads it with the anon key, exactly as it reads the product rows
-- that already contain the masters' public URLs.
--
-- ROWS ARE IMMUTABLE. A derived name includes the recipe version, so a better
-- encoder later means new names and new rows, never an edit. Nobody is granted
-- UPDATE or DELETE through the API. Admins may INSERT (the upload route
-- registers the copies it has just made and verified); the backfill writes as
-- the database owner.
--
-- "not_needed" records a decision so it is never re-made: a source already
-- narrower than the tier, or one the copy would not meaningfully shrink. The
-- backfill would otherwise download that source again on every run.
--
-- No existing rows are read or written. Applied with scripts/run-migration.mjs,
-- in one transaction.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ─────────────────────────────
do $$
begin
  if to_regprocedure('public.is_admin()') is null then
    raise exception '0071: public.is_admin() does not exist';
  end if;
  if to_regclass('public.image_derivatives') is not null then
    raise exception '0071: public.image_derivatives already exists';
  end if;
end $$;

create table public.image_derivatives (
  -- The master's key in the product-images bucket, e.g. products/abc-v1.jpg.
  source_path   text        not null
    check (source_path ~ '^(products|journal|lookbook|campaigns|pages)/[A-Za-z0-9][A-Za-z0-9_-]*\.(jpe?g|png|webp|JPE?G|PNG|WEBP)$'),
  tier          text        not null check (tier in ('w1080', 'w1920')),
  recipe        smallint    not null check (recipe between 1 and 999),
  status        text        not null check (status in ('ready', 'not_needed')),
  -- Present exactly when ready.
  derived_path  text        unique
    check (derived_path ~ '^derived/[A-Za-z0-9][A-Za-z0-9_-]*-w(1080|1920)-r[0-9]+\.(jpg|webp)$'),
  width         integer     check (width  between 1 and 20000),
  height        integer     check (height between 1 and 20000),
  bytes         bigint      check (bytes > 0),
  md5           text        check (md5 ~ '^[0-9a-f]{32}$'),
  source_bytes  bigint      check (source_bytes > 0),
  created_at    timestamptz not null default now(),
  primary key (source_path, tier, recipe),
  constraint image_derivatives_ready_has_file check (
    (status = 'ready'      and derived_path is not null and width is not null
                           and height is not null and bytes is not null and md5 is not null)
    or
    (status = 'not_needed' and derived_path is null and width is null
                           and height is null and bytes is null and md5 is null)
  )
);

comment on table public.image_derivatives is
  'Delivery-sized copies of product photographs (lib/imageVariants). Public facts about public files; immutable rows.';

alter table public.image_derivatives enable row level security;

-- Nothing by default, then exactly what is used.
revoke all on public.image_derivatives from public, anon, authenticated, service_role;
grant select on public.image_derivatives to anon, authenticated, service_role;
grant insert on public.image_derivatives to authenticated, service_role;

create policy "Anyone reads the derivative registry"
  on public.image_derivatives for select
  to anon, authenticated
  using (true);

create policy "Admins register derivatives"
  on public.image_derivatives for insert
  to authenticated
  with check (public.is_admin());

-- ── Postconditions ────────────────────────────
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.image_derivatives'::regclass) then
    raise exception '0071: RLS is not enabled';
  end if;
  if has_table_privilege('anon', 'public.image_derivatives', 'INSERT')
     or has_table_privilege('anon', 'public.image_derivatives', 'UPDATE')
     or has_table_privilege('anon', 'public.image_derivatives', 'DELETE')
     or has_table_privilege('authenticated', 'public.image_derivatives', 'UPDATE')
     or has_table_privilege('authenticated', 'public.image_derivatives', 'DELETE') then
    raise exception '0071: unexpected write privilege';
  end if;
end $$;
