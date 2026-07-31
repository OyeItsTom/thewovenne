-- 0013 — Publishing
--
-- One function, one transaction. Either everything waiting goes live together
-- or nothing does — a half-applied publish is how you get a product pointing at
-- a category the storefront cannot see.
--
-- Requires 0011 and 0012.

-- Publishing a product into a category that has never been published would put
-- a live product behind an invisible category. Rather than publish a broken
-- graph and let someone find it later, refuse the whole operation and say which
-- product is at fault.
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

  return null;
end;
$$;

create or replace function public.publish_all()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  problem     text;
  n_products  integer := 0;
  n_categories integer := 0;
  n_journal   integer := 0;
  n_content   integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Only admins can publish';
  end if;

  problem := public.validate_publish();
  if problem is not null then
    raise exception '%', problem;
  end if;

  -- Categories first: products reference them, so a product going live in a
  -- newly-visible category needs that category published in the same breath.
  update categories c
     set name = d.name, slug = d.slug, parent_id = d.parent_id,
         is_visible = d.is_visible, sort_order = d.sort_order
    from category_versions d
   where d.category_id = c.id and d.state = 'draft' and not d.pending_delete;

  update category_versions set state = 'archived'
   where state = 'published'
     and category_id in (select category_id from category_versions where state = 'draft');

  with promoted as (
    update category_versions
       set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete
    returning 1
  ) select count(*) into n_categories from promoted;

  delete from categories
   where id in (select category_id from category_versions where state = 'draft' and pending_delete);

  -- Products.
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
    update product_versions
       set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete
    returning 1
  ) select count(*) into n_products from promoted;

  delete from products
   where id in (select product_id from product_versions where state = 'draft' and pending_delete);

  -- Journal.
  update journal_posts j
     set title = d.title, slug = d.slug, body = d.body,
         image_url = d.image_url, published = d.published
    from journal_versions d
   where d.journal_id = j.id and d.state = 'draft' and not d.pending_delete;

  update journal_versions set state = 'archived'
   where state = 'published'
     and journal_id in (select journal_id from journal_versions where state = 'draft');

  with promoted as (
    update journal_versions
       set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete
    returning 1
  ) select count(*) into n_journal from promoted;

  delete from journal_posts
   where id in (select journal_id from journal_versions where state = 'draft' and pending_delete);

  -- Homepage copy keeps the simpler draft_value/value pair from 0010.
  with updated as (
    update site_content
       set value = draft_value, updated_at = now()
     where draft_value is not null and draft_value is distinct from value
    returning 1
  ) select count(*) into n_content from updated;

  return jsonb_build_object(
    'products', n_products,
    'categories', n_categories,
    'journal', n_journal,
    'content', n_content,
    'total', n_products + n_categories + n_journal + n_content
  );
end;
$$;

-- Discard everything waiting and go back to what is live.
create or replace function public.discard_drafts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_products integer; n_categories integer; n_journal integer; n_content integer;
begin
  if not public.is_admin() then
    raise exception 'Only admins can discard drafts';
  end if;

  -- Products created but never published have no published version to fall back
  -- to, so discarding one removes the product entirely.
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

  with u as (update site_content set draft_value = value
              where draft_value is distinct from value returning 1)
    select count(*) into n_content from u;

  return jsonb_build_object(
    'products', n_products, 'categories', n_categories,
    'journal', n_journal, 'content', n_content
  );
end;
$$;

revoke execute on function
  public.validate_publish(), public.publish_all(), public.discard_drafts() from public;
grant execute on function
  public.validate_publish(), public.publish_all(), public.discard_drafts() to authenticated;

select public.validate_publish() as blocking_problem, public.pending_changes() as pending;
