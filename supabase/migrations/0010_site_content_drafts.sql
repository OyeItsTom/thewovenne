-- 0010 — Draft/publish for homepage content
--
-- site_content was the only editable thing with no draft concept: saving
-- homepage copy put it straight on the live site. Products have is_active,
-- categories have is_visible, journal posts have published — this closes the
-- last gap without the structural cost of versioning every table.
--
-- Model: `value` stays the PUBLISHED copy that the storefront reads, so no
-- storefront query changes. `draft_value` is what the admin edits. Publishing
-- copies draft over value.
--
-- Requires site_content from 0001.

alter table site_content add column if not exists draft_value jsonb;

-- Seed drafts from what is already live, so nothing opens blank and nothing
-- needs republishing to stay as it is.
update site_content set draft_value = value where draft_value is null;

-- Publishing is a single call rather than a row-by-row update from the client:
-- it keeps every block consistent, and means the admin cannot half-publish.
-- SECURITY DEFINER with an explicit admin check — the definer bypasses RLS, so
-- the check has to be here rather than relying on the table's policies.
create or replace function public.publish_site_content()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  if not public.is_admin() then
    raise exception 'Only admins can publish content';
  end if;

  with updated as (
    update site_content
       set value = draft_value,
           updated_at = now()
     where draft_value is not null
       and draft_value is distinct from value
    returning 1
  )
  select count(*) into changed from updated;

  return changed;
end;
$$;

revoke execute on function public.publish_site_content() from public;
grant execute on function public.publish_site_content() to authenticated;

-- Check: pending should be 0 immediately after running this.
select
  count(*) filter (where draft_value is distinct from value) as pending,
  count(*)                                                   as blocks
from site_content;
