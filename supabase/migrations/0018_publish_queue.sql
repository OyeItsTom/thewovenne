-- 0018 — No-op draft detection, and the publish queue
--
-- Two things, both about knowing exactly what is about to go live.
--
-- 1. A draft that ends up identical to what is already published is not a
--    change. Toggling a product off and back on, or editing a price and
--    changing it back, used to leave a draft queued forever, so the publish bar
--    claimed pending work that would change nothing when published.
--
-- 2. pending_queue() lists every pending draft with a field-level diff, so the
--    publish button stops being a leap of faith.
--
-- Enforced in the database rather than in each admin screen: a new screen that
-- forgot to call a helper would silently reintroduce phantom drafts, which is
-- the failure this exists to prevent.
--
-- Requires 0011-0015.

-- ── Which columns are bookkeeping, not content ──
-- Version identity and audit stamps differ on every draft by definition, so
-- comparing them would make every draft look like a change.
create or replace function public.version_noise()
returns text[]
language sql
immutable
as $$
  select array['id', 'state', 'version', 'created_by', 'created_at',
                'published_at', 'pending_delete']::text[];
$$;

-- ── Field-level diff between two rows ─────────
-- Returns [{field, old, new}], skipping bookkeeping columns. Used both by the
-- no-op check and by the queue, so what counts as "a change" is defined once.
create or replace function public.jsonb_diff(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'field', k,
      'old',   p_old -> k,
      'new',   p_new -> k
    ) order by k),
    '[]'::jsonb
  )
  from (
    select jsonb_object_keys(coalesce(p_old, '{}'::jsonb) || coalesce(p_new, '{}'::jsonb)) as k
  ) keys
  where not (k = any(public.version_noise()))
    and (p_old -> k) is distinct from (p_new -> k);
$$;

-- ── Do two product versions have the same gallery? ──
-- Images live in their own table, so identical scalar fields are not enough:
-- reordering photos is a real change and must not be discarded as a no-op.
create or replace function public.gallery_matches(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select array_agg(url order by sort_order, url) from product_images where product_version_id = p_a),
    array[]::text[]
  ) = coalesce(
    (select array_agg(url order by sort_order, url) from product_images where product_version_id = p_b),
    array[]::text[]
  );
$$;

-- ── Is this draft a no-op? ────────────────────
-- True when the draft is identical to the published version it forked from —
-- the "toggled it off and back on" case.
--
-- NOT a trigger, deliberately. ensure_product_draft forks an IDENTICAL copy and
-- the real edit arrives in a later statement, so any trigger firing in between
-- would delete the draft mid-save and leave the edit updating nothing. Worse, a
-- product's photos live in another table written by a third statement, so there
-- is no single moment at which a trigger could see the finished picture.
--
-- Instead the counts and the queue simply do not report no-op drafts (race-free
-- by construction), and settle_draft() tidies the rows away once a save is
-- complete. If a caller ever forgets to settle, nothing is queued regardless —
-- the leftover row is untidy, not wrong.
create or replace function public.draft_is_noop(p_kind text, p_version_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  tbl     text;
  key_col text;
  pub     jsonb;
  dra     jsonb;
  pub_id  uuid;
  ent     uuid;
  is_del  boolean;
begin
  case p_kind
    when 'product'  then tbl := 'product_versions';   key_col := 'product_id';
    when 'category' then tbl := 'category_versions';  key_col := 'category_id';
    when 'journal'  then tbl := 'journal_versions';   key_col := 'journal_id';
    when 'page'     then tbl := 'site_page_versions'; key_col := 'page_id';
    else return false;
  end case;

  execute format(
    'select to_jsonb(t), (t.%I)::uuid, t.pending_delete from %I t'
    ' where t.id = $1 and t.state = ''draft''',
    key_col, tbl
  ) into dra, ent, is_del using p_version_id;

  -- Not a draft, or already gone.
  if dra is null then return false; end if;
  -- A pending deletion is a real change however identical the fields look.
  if is_del then return false; end if;

  execute format(
    'select to_jsonb(t), t.id from %I t'
    ' where t.%I = $1 and t.state = ''published'' limit 1',
    tbl, key_col
  ) into pub, pub_id using ent;

  -- No published counterpart: this draft CREATES something, always real.
  if pub is null then return false; end if;

  if public.jsonb_diff(pub, dra) <> '[]'::jsonb then return false; end if;

  -- Scalars match; for a product the gallery still has to.
  if p_kind = 'product' and not public.gallery_matches(p_version_id, pub_id) then
    return false;
  end if;

  return true;
end;
$fn$;

grant execute on function public.draft_is_noop(text, uuid) to authenticated, service_role;

-- ── Tidy a settled draft away ─────────────────
-- Called by the admin screens once a save is completely finished (scalars AND
-- gallery), the only point at which "did anything actually change?" has a
-- meaningful answer.
create or replace function public.settle_draft(p_kind text, p_version_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  tbl text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit content';
  end if;

  if not public.draft_is_noop(p_kind, p_version_id) then
    return false;
  end if;

  case p_kind
    when 'product'  then tbl := 'product_versions';
    when 'category' then tbl := 'category_versions';
    when 'journal'  then tbl := 'journal_versions';
    when 'page'     then tbl := 'site_page_versions';
    else return false;
  end case;

  execute format('delete from %I where id = $1', tbl) using p_version_id;
  return true;
end;
$fn$;

revoke execute on function public.settle_draft(text, uuid) from public;
grant execute on function public.settle_draft(text, uuid) to authenticated;

-- ── Counts ignore no-op drafts ────────────────
-- Same five output columns as before, so CREATE OR REPLACE is safe. (0015 had
-- to DROP first because it added a column; nothing changes shape here.)
create or replace function public.pending_changes()
returns table (products integer, categories integer, journal integer,
               content integer, pages integer)
language sql
security definer
stable
set search_path = public
as $fn$
  select
    (select count(*)::integer from product_versions
      where state = 'draft' and not public.draft_is_noop('product', id)),
    (select count(*)::integer from category_versions
      where state = 'draft' and not public.draft_is_noop('category', id)),
    (select count(*)::integer from journal_versions
      where state = 'draft' and not public.draft_is_noop('journal', id)),
    (select count(*)::integer from site_content
      where draft_value is distinct from value),
    (select count(*)::integer from site_page_versions
      where state = 'draft' and not public.draft_is_noop('page', id));
$fn$;
revoke execute on function public.pending_changes() from public;
grant execute on function public.pending_changes() to authenticated;

-- site_content needs none of this: pending_changes counts rows where
-- draft_value IS DISTINCT FROM value, so writing the published value back into
-- the draft is already, by definition, not pending.

-- ── The queue ─────────────────────────────────
-- Everything waiting to go live, with what changed, when and by whom.
create or replace function public.pending_queue()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can view the publish queue';
  end if;

  with items as (
    select 'product'::text as kind, d.product_id as entity_id, d.id as version_id,
           d.name as label, d.slug as slug, d.pending_delete,
           d.created_at as changed_at, p.id as pub_id,
           to_jsonb(p) as pub, to_jsonb(d) as dra
      from product_versions d
      left join product_versions p
        on p.product_id = d.product_id and p.state = 'published'
     where d.state = 'draft' and not public.draft_is_noop('product', d.id)

    union all
    select 'category', d.category_id, d.id, d.name, d.slug, d.pending_delete,
           d.created_at, p.id, to_jsonb(p), to_jsonb(d)
      from category_versions d
      left join category_versions p
        on p.category_id = d.category_id and p.state = 'published'
     where d.state = 'draft' and not public.draft_is_noop('category', d.id)

    union all
    select 'journal', d.journal_id, d.id, d.title, d.slug, d.pending_delete,
           d.created_at, p.id, to_jsonb(p), to_jsonb(d)
      from journal_versions d
      left join journal_versions p
        on p.journal_id = d.journal_id and p.state = 'published'
     where d.state = 'draft' and not public.draft_is_noop('journal', d.id)

    union all
    select 'page', d.page_id, d.id, d.title, d.slug, d.pending_delete,
           d.created_at, p.id, to_jsonb(p), to_jsonb(d)
      from site_page_versions d
      left join site_page_versions p
        on p.page_id = d.page_id and p.state = 'published'
     where d.state = 'draft' and not public.draft_is_noop('page', d.id)

    -- site_content has no version rows; the key IS the identity and the two
    -- jsonb columns are the two sides of the diff.
    union all
    select 'content', null::uuid, null::uuid, sc.key, sc.key, false,
           sc.updated_at, '00000000-0000-0000-0000-000000000000'::uuid,
           coalesce(sc.value, '{}'::jsonb), coalesce(sc.draft_value, '{}'::jsonb)
      from site_content sc
     where sc.draft_value is distinct from sc.value
  )
  select coalesce(jsonb_agg(x order by x->>'kind', x->>'label'), '[]'::jsonb)
    into result
  from (
    select jsonb_build_object(
      'kind', i.kind,
      'entity_id', i.entity_id,
      'version_id', i.version_id,
      'label', i.label,
      'slug', i.slug,
      'is_new', i.pub_id is null,
      'pending_delete', i.pending_delete,
      'changed_at', i.changed_at,
      'changed_by', (
        select a.actor_email
          from admin_audit_log a
         where a.record_id = i.version_id
         order by a.created_at desc
         limit 1
      ),
      -- A creation has nothing to diff against, and a deletion's diff would be
      -- every field at once. Both read better as a plain statement of intent.
      'changes', case
        when i.pending_delete then '[]'::jsonb
        when i.pub_id is null then '[]'::jsonb
        else public.jsonb_diff(i.pub, i.dra)
      end
    ) as x
    from items i
  ) q;

  return result;
end;
$$;

revoke execute on function public.pending_queue() from public;
grant execute on function public.pending_queue() to authenticated;

-- ── Discard one item ──────────────────────────
create or replace function public.discard_one(p_kind text, p_id uuid, p_key text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can discard changes';
  end if;

  if p_kind = 'product' then
    delete from product_versions where product_id = p_id and state = 'draft';
    -- A draft that CREATED the product leaves an identity row with no versions.
    delete from products p
     where p.id = p_id
       and not exists (select 1 from product_versions v where v.product_id = p.id);

  elsif p_kind = 'category' then
    delete from category_versions where category_id = p_id and state = 'draft';
    delete from categories c
     where c.id = p_id
       and not exists (select 1 from category_versions v where v.category_id = c.id);

  elsif p_kind = 'journal' then
    delete from journal_versions where journal_id = p_id and state = 'draft';
    delete from journal_posts j
     where j.id = p_id
       and not exists (select 1 from journal_versions v where v.journal_id = j.id);

  elsif p_kind = 'page' then
    delete from site_page_versions where page_id = p_id and state = 'draft';
    delete from site_pages s
     where s.id = p_id
       and not exists (select 1 from site_page_versions v where v.page_id = s.id);

  elsif p_kind = 'content' then
    update site_content set draft_value = value where key = p_key;

  else
    raise exception 'Unknown kind %', p_kind;
  end if;
end;
$$;

revoke execute on function public.discard_one(text, uuid, text) from public;
grant execute on function public.discard_one(text, uuid, text) to authenticated;

-- ── Publish one item ──────────────────────────
-- Same promotion steps publish_all uses, scoped to one entity, with the checks
-- that matter for THAT entity. A global validation would block publishing a
-- sound item because some unrelated draft is unfinished, which defeats the
-- point of picking items out of the queue.
create or replace function public.publish_one(p_kind text, p_id uuid, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  problem text;
  d       record;
begin
  if not public.is_admin() then
    raise exception 'Only admins can publish';
  end if;

  if p_kind = 'product' then
    select * into d from product_versions where product_id = p_id and state = 'draft';
    if not found then raise exception 'Nothing pending for that product'; end if;

    if not d.pending_delete then
      if d.name = '' or d.slug = '' then
        raise exception 'This product is missing its name or web address.';
      end if;
      if d.category_id is not null and not exists (
        select 1 from category_versions cv
         where cv.category_id = d.category_id and cv.state = 'published'
      ) then
        -- Publishing it alone would put it live pointing at a category
        -- customers cannot reach, so it would silently not appear.
        raise exception 'Publish its category first — "%" is in a category that is not live yet.', d.name;
      end if;

      update products p
         set name = d.name, slug = d.slug, description = d.description,
             price_inr = d.price_inr, category_id = d.category_id, fabric = d.fabric,
             colour = d.colour, stock_quantity = d.stock_quantity,
             image_url = d.image_url, is_active = d.is_active
       where p.id = p_id;
      update product_versions set state = 'archived'
       where product_id = p_id and state = 'published';
      update product_versions set state = 'published', published_at = now()
       where id = d.id;
    else
      delete from products where id = p_id;
    end if;

  elsif p_kind = 'category' then
    select * into d from category_versions where category_id = p_id and state = 'draft';
    if not found then raise exception 'Nothing pending for that category'; end if;

    if not d.pending_delete then
      update categories c
         set name = d.name, slug = d.slug, parent_id = d.parent_id,
             is_visible = d.is_visible, sort_order = d.sort_order
       where c.id = p_id;
      update category_versions set state = 'archived'
       where category_id = p_id and state = 'published';
      update category_versions set state = 'published', published_at = now()
       where id = d.id;
    else
      delete from categories where id = p_id;
    end if;

  elsif p_kind = 'journal' then
    select * into d from journal_versions where journal_id = p_id and state = 'draft';
    if not found then raise exception 'Nothing pending for that post'; end if;

    if not d.pending_delete then
      update journal_posts j
         set title = d.title, slug = d.slug, body = d.body,
             image_url = d.image_url, published = d.published
       where j.id = p_id;
      update journal_versions set state = 'archived'
       where journal_id = p_id and state = 'published';
      update journal_versions set state = 'published', published_at = now()
       where id = d.id;
    else
      delete from journal_posts where id = p_id;
    end if;

  elsif p_kind = 'page' then
    select * into d from site_page_versions where page_id = p_id and state = 'draft';
    if not found then raise exception 'Nothing pending for that page'; end if;

    if not d.pending_delete then
      update site_page_versions set state = 'archived'
       where page_id = p_id and state = 'published';
      update site_page_versions set state = 'published', published_at = now()
       where id = d.id;
    else
      delete from site_pages where id = p_id;
    end if;

  elsif p_kind = 'content' then
    update site_content set value = draft_value, updated_at = now()
     where key = p_key and draft_value is not null;

  else
    raise exception 'Unknown kind %', p_kind;
  end if;

  return jsonb_build_object('kind', p_kind, 'published', 1);
end;
$$;

revoke execute on function public.publish_one(text, uuid, text) from public;
grant execute on function public.publish_one(text, uuid, text) to authenticated;

-- Existing phantom drafts need no migration step: they stop being counted the
-- moment pending_changes() is replaced above, and settle_draft() removes each
-- row the next time that item is saved.

-- ── Verify ────────────────────────────────────
select
  (select count(*) from product_versions where state = 'draft')   as product_drafts,
  (select count(*) from category_versions where state = 'draft')  as category_drafts,
  (select count(*) from journal_versions where state = 'draft')   as journal_drafts,
  (select count(*) from site_page_versions where state = 'draft') as page_drafts,
  public.pending_changes()                                         as pending,
  jsonb_array_length(public.pending_queue())                       as queue_size;
