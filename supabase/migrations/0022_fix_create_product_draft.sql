-- 0022 — Fix creating a new product
--
-- Adding a product failed outright:
--
--   null value in column "name" of relation "products"
--   violates not-null constraint
--
-- create_product_draft did `insert into products default values`, but products
-- still carries name, slug and price_inr as NOT NULL from 0001. Those columns
-- became denormalised mirrors when 0011 split identity from versions — kept in
-- sync by publish_all so anything reading the old table still works — and
-- nothing relaxed them.
--
-- This has been broken since 0011. It went unnoticed because every existing
-- product predates versioning: editing one works, because ensure_product_draft
-- forks a row that already has values. Only CREATING one takes this path.
--
-- Fixed the way create_journal_draft already does it — placeholders, not
-- relaxed constraints. products stays non-null for anything still reading it,
-- and publish_all overwrites the placeholders with the real values.
--
-- SECOND BUG, which would have appeared on the next product rather than this
-- one: the draft slug was '' and product_versions_slug_draft is UNIQUE on slug
-- where state = 'draft'. One blank draft is fine; a second collides. A random
-- slug avoids it, and never reaches a customer — the admin form overwrites it
-- on save, and validate_publish still refuses a draft with an empty NAME, so an
-- unfinished product cannot go live.

create or replace function public.create_product_draft()
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  new_product uuid;
  draft_id    uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create products';
  end if;

  -- Placeholder name/slug/price: the identity row's copies are overwritten by
  -- publish_all, and a random slug keeps the unique index happy for however
  -- many products are being drafted at once.
  insert into products (name, slug, price_inr)
  values ('', gen_random_uuid()::text, 0)
  returning id into new_product;

  insert into product_versions
    (product_id, state, version, name, slug, price_inr, created_by)
  values
    (new_product, 'draft', 1, '', gen_random_uuid()::text, 0, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$fn$;

revoke execute on function public.create_product_draft() from public;
grant execute on function public.create_product_draft() to authenticated;

-- ── Clean up anything the failure left behind ──
-- The insert into products could succeed and the whole function still abort, so
-- an identity row with no versions may exist. It is invisible everywhere (every
-- read goes through product_versions) but it would sit in the table forever.
delete from products p
 where not exists (select 1 from product_versions v where v.product_id = p.id);

-- ── Verify ────────────────────────────────────
-- Does not CALL create_product_draft: it checks is_admin(), and the SQL editor
-- runs as postgres with no auth.uid(), so calling it would raise and roll the
-- migration back. That mistake cost two runs on 0018.
select
  (select count(*) from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'create_product_draft') as fn_present,
  (select count(*) from products) as products_total,
  (select count(*) from products p
    where not exists (select 1 from product_versions v where v.product_id = p.id))
    as orphans_left;
