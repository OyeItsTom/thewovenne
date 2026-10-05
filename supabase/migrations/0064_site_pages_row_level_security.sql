-- 0064 — site_pages: row-level security on, no direct writes from the API roles
--
-- 0015 created site_pages (one row per editable page — just an id and a
-- timestamp; the content lives in site_page_versions) and granted
-- authenticated INSERT, UPDATE and DELETE on it, but never enabled RLS.
-- Production has RLS ON with NO policies — enabled outside the migrations at
-- some point, and the safe state. A database rebuilt from 0001–0063 has RLS
-- OFF, so any signed-in customer could `delete from site_pages`, and the
-- ON DELETE CASCADE on site_page_versions.page_id would take every page's
-- content with it. Found by the 5 October 2026 production-vs-replay audit.
--
-- Nothing reads or writes site_pages through the API:
--   * no application code names the table (only migrations do);
--   * every function that touches it — create_page_draft, publish_all,
--     publish_one, discard_drafts, discard_one — is SECURITY DEFINER, owned by
--     postgres, so it acts with the owner's rights, not the caller's;
--   * the admin page editor writes site_page_versions directly, through that
--     table's own policies; the foreign key to site_pages is checked by
--     PostgreSQL as the table owner and needs no grant from the caller.
--
-- So this:
--   1. enables RLS (already on in production — a no-op there), and adds NO
--      policy: every API-role row access stays denied, as in production;
--   2. removes the API roles' direct write privileges. Under RLS they already
--      affect nothing — except TRUNCATE, which RLS does not govern — so in
--      production this closes TRUNCATE (and REFERENCES/TRIGGER/MAINTAIN, from
--      the project's default grants) and changes no working path;
--   3. keeps the SELECT 0015 granted. Under RLS with no policy it returns no
--      rows, exactly as production does today.
--
-- service_role is untouched.

alter table public.site_pages enable row level security;

revoke all on public.site_pages from anon, authenticated;
grant select on public.site_pages to anon, authenticated;

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
  r text;
  p text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.site_pages'::regclass) then
    problems := problems || 'RLS is not enabled on site_pages'::text;
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.site_pages'::regclass) then
    problems := problems || 'site_pages has a policy (expected none)'::text;
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(r, 'public.site_pages', p) then
        problems := problems || format('%s still holds %s on site_pages', r, p);
      end if;
    end loop;
    if has_any_column_privilege(r, 'public.site_pages', 'INSERT')
       or has_any_column_privilege(r, 'public.site_pages', 'UPDATE') then
      problems := problems || format('%s holds a column-level write on site_pages', r);
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.site_pages', 'SELECT, INSERT, UPDATE, DELETE') then
    problems := problems || 'service_role lost access to site_pages'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0064_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select c.relname,
       c.relrowsecurity as rls,
       (select count(*) from pg_policy where polrelid = c.oid) as policies,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') as authenticated_any_write,
       has_table_privilege('service_role', c.oid, 'INSERT') as service_role_insert
  from pg_class c
 where c.oid = 'public.site_pages'::regclass;
