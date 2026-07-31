-- 0014 — Point the audit log at the version tables
--
-- The 0009 triggers sit on products/categories/journal_posts. Now that admin
-- writes land on *_versions and those identity tables only change during
-- publish, those triggers record publishes and nothing else — every actual edit
-- would go unrecorded, and the one entry you did get would be attributed to
-- whoever published rather than whoever made the change.
--
-- Moving them onto the version tables records the edit when it happens, with
-- the right person on it. Publishing still shows up, as a state change on the
-- version row.
--
-- Requires 0009 and 0011.

drop trigger if exists audit_products on products;
drop trigger if exists audit_categories on categories;
drop trigger if exists audit_journal_posts on journal_posts;

-- site_content keeps its 0009 trigger: it has no version table, and its
-- draft_value/value pair means the trigger already sees both edit and publish.

drop trigger if exists audit_product_versions on product_versions;
create trigger audit_product_versions
  after insert or update or delete on product_versions
  for each row execute function public.log_admin_action();

drop trigger if exists audit_category_versions on category_versions;
create trigger audit_category_versions
  after insert or update or delete on category_versions
  for each row execute function public.log_admin_action();

drop trigger if exists audit_journal_versions on journal_versions;
create trigger audit_journal_versions
  after insert or update or delete on journal_versions
  for each row execute function public.log_admin_action();

-- The generic logger labels a row by name/title/key/slug and identifies it by
-- its own id. On a version table that id is the VERSION's, which is useless for
-- tracing a product across edits — replace it with the entity id so every entry
-- for one product groups together.
create or replace function public.log_admin_action()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor      uuid := auth.uid();
  actor_mail text;
  old_row    jsonb;
  new_row    jsonb;
  changed    jsonb;
  rec_id     uuid;
  label      text;
begin
  select p.email into actor_mail from public.profiles p where p.id = actor;

  if TG_OP = 'DELETE' then
    old_row := to_jsonb(OLD);
    new_row := null;
    changed := old_row;
  elsif TG_OP = 'INSERT' then
    new_row := to_jsonb(NEW);
    changed := new_row;
  else
    old_row := to_jsonb(OLD);
    new_row := to_jsonb(NEW);
    select jsonb_object_agg(k, jsonb_build_object('from', old_row -> k, 'to', new_row -> k))
      into changed
      from jsonb_object_keys(new_row) AS k
     where (new_row -> k) is distinct from (old_row -> k);

    if changed is null then
      return NEW;
    end if;
  end if;

  -- Prefer the entity id so entries for one product/category/post group
  -- together across versions; fall back to the row's own id elsewhere.
  rec_id := nullif(coalesce(
    new_row ->> 'product_id',  old_row ->> 'product_id',
    new_row ->> 'category_id', old_row ->> 'category_id',
    new_row ->> 'journal_id',  old_row ->> 'journal_id',
    new_row ->> 'id',          old_row ->> 'id'
  ), '')::uuid;

  label := coalesce(
    new_row ->> 'name',  old_row ->> 'name',
    new_row ->> 'title', old_row ->> 'title',
    new_row ->> 'key',   old_row ->> 'key',
    new_row ->> 'slug',  old_row ->> 'slug'
  );

  insert into public.admin_audit_log
    (actor_id, actor_email, action, table_name, record_id, record_label, changes)
  values
    (actor, actor_mail, lower(TG_OP), TG_TABLE_NAME, rec_id, label, changed);

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

-- Check: triggers should now be on the version tables, not the identity ones.
select event_object_table as table_name, trigger_name
  from information_schema.triggers
 where trigger_name like 'audit_%'
 order by event_object_table;
