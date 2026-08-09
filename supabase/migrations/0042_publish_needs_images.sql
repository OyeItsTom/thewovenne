-- 0042 — A product without a photograph cannot go live
--
-- Excel import creates the record; images are added afterwards on the product
-- page. That is the intended flow, and it leaves a window where a product is
-- complete in every respect except the one customers actually look at. Publish
-- it in that state and the shop shows an empty grey box with a price on it.
--
-- A TRIGGER, NOT A CHECK IN EACH PUBLISH PATH. Publishing happens two ways —
-- publish_all() via validate_publish() (0013) and publish_one() (0018) — and
-- each carries its own inline validation. Adding this to both means two places
-- to forget, which is the same trap 0038 documented for column lists and
-- solved the same way. Firing on the version becoming published catches every
-- route, including any added later.
--
-- THE OVERRIDE IS A FLAG ON THE DRAFT, NOT A PARAMETER. Adding an argument to
-- publish_one/publish_all would create an OVERLOAD rather than replacing them
-- (0038 again — a call passing the old arguments then matches both and Postgres
-- refuses it as "not unique"), and it would make the override a transient click
-- nobody can audit afterwards. As a column it is deliberate, visible on the
-- product, and recorded by the existing audit trigger.
--
-- It is DELIBERATELY NOT carried across by ensure_product_draft. That function
-- copies an explicit column list, so a new draft forked from a published
-- version gets the default — false. Editing a product again therefore re-asks
-- the question rather than silently inheriting a decision made months ago about
-- a different set of photographs.

alter table product_versions
  add column if not exists allow_no_images boolean not null default false;

comment on column product_versions.allow_no_images is
  'Deliberate override: let this version publish with no photographs. Resets to
   false on every new draft, because the next edit is a new decision.';

create or replace function public.require_images_to_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- A product being removed does not need a photograph to be removed.
  if new.pending_delete then
    return new;
  end if;

  if new.allow_no_images then
    return new;
  end if;

  if not exists (
    select 1 from product_images where product_version_id = new.id
  ) then
    raise exception
      'PRODUCT_HAS_NO_IMAGES:%',
      coalesce(nullif(new.name, ''), 'This product')
      using hint =
        'Add at least one photograph, or tick "publish without images" on the product if that is genuinely intended.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists require_images_before_publish on product_versions;
create trigger require_images_before_publish
  before update of state on product_versions
  for each row
  when (new.state = 'published' and old.state is distinct from 'published')
  execute function public.require_images_to_publish();

-- validate_publish() is what the publish bar calls to explain a refusal BEFORE
-- the admin presses the button. Without this, the trigger above would be the
-- first they heard of it — as a raised exception mid-publish, after a queue of
-- other changes had already gone live.
create or replace function public.validate_publish()
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  offender text;
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

  -- New in 0042. Named so the admin knows which product to open.
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

  return null;
end;
$$;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'product_versions'
      and column_name = 'allow_no_images') as override_column,
  (select count(*) from pg_trigger
    where tgname = 'require_images_before_publish') as trigger_present,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'require_images_to_publish') as function_present,
  -- Products already live keep working: the trigger only fires on a version
  -- BECOMING published, so nothing already published is re-checked.
  (select count(*) from product_versions where state = 'published') as untouched_published;
