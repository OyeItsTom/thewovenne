-- 0054 — The moderation queue, as one read
--
-- An admin looking at a submission needs four things the table does not hold
-- together: the photograph, which product it is of, who sent it, and where to
-- write to them when it is turned down. That is a join across products and
-- profiles, and doing it in the browser would mean the admin screen querying
-- `profiles` for somebody else's email address — a read worth keeping out of a
-- client component even when RLS would allow it.
--
-- SAME SHAPE AS admin_reviews (0036), deliberately: one SECURITY DEFINER
-- function, gated on is_admin(), returning the whole queue as jsonb. The two
-- screens are the same job — a person deciding whether something a customer
-- wrote or photographed should be public — and the next person to work on either
-- should find the same machinery.
--
-- IT RETURNS EVERY STATUS. The queue's tabs are a filter over one list rather
-- than three queries: an approved photograph and a pending one differ by a
-- column, and fetching them separately is how the counts on the tabs start
-- disagreeing with what the tabs contain.

create or replace function public.admin_style_submissions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can read the style queue';
  end if;

  select coalesce(jsonb_agg(row_to_json(x) order by x.created_at desc), '[]'::jsonb)
    into result
  from (
    select s.id,
           s.product_id,
           pv.name as product_name,
           pv.slug as product_slug,
           s.photo_url,
           s.photo_width,
           s.photo_height,
           s.video_platform,
           s.video_url,
           s.caption,
           s.credit_name,
           s.status,
           s.consented_at,
           s.withdrawn_at,
           s.reject_reason,
           s.rejection_emailed_at,
           s.reviewed_at,
           s.created_at,
           -- Who to write to. The customer's own name is NOT used as the credit
           -- — credit_name above is the only thing that appears in public, and
           -- it is null unless they asked to be named.
           p.email as customer_email,
           coalesce(nullif(btrim(p.full_name), ''), 'A customer') as customer_name
      from style_submissions s
      left join profiles p on p.id = s.user_id
      left join product_versions pv
        on pv.product_id = s.product_id and pv.state = 'published'
  ) x;

  return result;
end;
$fn$;

revoke execute on function public.admin_style_submissions() from public, anon;
grant execute on function public.admin_style_submissions() to authenticated, service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'admin_style_submissions') as function_present,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'admin_style_submissions' and grantee = 'authenticated') as admin_may_read,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'admin_style_submissions' and grantee = 'anon') as anon_may_read;
