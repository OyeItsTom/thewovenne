-- 0009 — Admin audit log
--
-- Records who changed what, and when. Implemented as database triggers rather
-- than calls from the admin UI: a log the application has to remember to write
-- is a log that misses whatever forgot to call it, and it records nothing at
-- all for changes made through the API or the SQL editor.
--
-- Requires is_admin() from 0002 and the tables from 0001 / 0006.
--
-- SUPERSEDED IN PART: log_admin_action() was rewritten by 0014 to cover the
-- *_versions tables. Re-running THIS file reverts that and stops drafts and
-- publishes being recorded. Re-run 0014 afterwards if you ever need to.

create table if not exists admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  -- actor_email is denormalised on purpose: it must still name the person
  -- after their auth user is deleted, which is exactly when you'd want it.
  actor_id uuid,
  actor_email text,
  action text not null,          -- insert | update | delete
  table_name text not null,
  record_id uuid,
  record_label text,             -- name/title/key at the time, so deletions read
  changes jsonb,                 -- update: {col: {from, to}} · insert/delete: the row
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx
  on admin_audit_log (created_at desc);

alter table admin_audit_log enable row level security;

-- Readable by admins, written only by the trigger below (SECURITY DEFINER, so
-- it bypasses these policies). There is deliberately no insert, update or
-- delete policy: an audit log an admin can edit is not evidence of anything.
drop policy if exists "Admins can read the audit log" on admin_audit_log;
create policy "Admins can read the audit log"
  on admin_audit_log for select to authenticated using (public.is_admin());

grant select on admin_audit_log to authenticated;
grant all privileges on admin_audit_log to service_role;

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

  -- Columns differ per table (name / title / key), so work in jsonb: ->> on a
  -- missing key returns null instead of raising, which a record reference would.
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

    -- Nothing actually changed (a no-op save) — not worth a row.
    if changed is null then
      return NEW;
    end if;
  end if;

  rec_id := nullif(coalesce(new_row ->> 'id', old_row ->> 'id'), '')::uuid;
  label  := coalesce(
    new_row ->> 'name',  old_row ->> 'name',
    new_row ->> 'title', old_row ->> 'title',
    new_row ->> 'key',   old_row ->> 'key',
    new_row ->> 'slug',  old_row ->> 'slug'
  );

  insert into public.admin_audit_log
    (actor_id, actor_email, action, table_name, record_id, record_label, changes)
  values
    (actor, actor_mail, lower(TG_OP), TG_TABLE_NAME, rec_id, label, changed);

  -- AFTER triggers ignore the return value, but be explicit rather than rely
  -- on coalesce() over two rowtypes behaving.
  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

-- product_images is deliberately not audited: saving a product rewrites its
-- whole gallery (delete-then-insert), so every save would bury the useful
-- entries under a row per photo. The parent product update is recorded.
drop trigger if exists audit_products on products;
create trigger audit_products
  after insert or update or delete on products
  for each row execute function public.log_admin_action();

drop trigger if exists audit_categories on categories;
create trigger audit_categories
  after insert or update or delete on categories
  for each row execute function public.log_admin_action();

drop trigger if exists audit_site_content on site_content;
create trigger audit_site_content
  after insert or update or delete on site_content
  for each row execute function public.log_admin_action();

drop trigger if exists audit_journal_posts on journal_posts;
create trigger audit_journal_posts
  after insert or update or delete on journal_posts
  for each row execute function public.log_admin_action();

-- Check: should return 0 rows now, and grow as you use the admin panel.
select count(*) as audit_entries from admin_audit_log;
