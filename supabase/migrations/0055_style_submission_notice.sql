-- 0055 — Telling somebody a photograph is waiting
--
-- The queue built in 0054 notifies nobody. A submission sits in
-- /admin/dashboard/style until a human opens that page, and nothing anywhere
-- says one has arrived. That is fine at zero submissions and bad at one.
--
-- WHY THE CUSTOMER'S BROWSER TRIGGERS IT, which looks wrong at first glance.
-- The submission is an INSERT straight from the browser under RLS — there is no
-- server moment in the flow to hang a send on. The alternatives were to route
-- the whole submission through an API route (rewriting a path that shipped
-- yesterday and has never carried a real submission), or a database trigger
-- calling out through pg_net (a new extension, a secret in the database, and a
-- failure mode nobody can see). Neither is worth it for one email. So the form
-- asks the server to send it, and this migration makes that request safe to
-- expose:
--
--   * only the owner of the submission, checked against auth.uid();
--   * only while it is pending — an approved photograph does not need announcing;
--   * once. The stamp is taken in the same statement that reads it, so ten
--     concurrent requests produce one email and nine refusals.
--
-- Without that last rule the route would be an open way to post email to the
-- shop's inbox: sign in, submit once, then call it a thousand times.
--
-- THE STAMP IS ALSO THE FAILURE INDICATOR. A pending row with a null
-- admin_notified_at is one nobody was told about — because the browser closed
-- between the insert and the request, or Resend was down. The queue shows that
-- state rather than hiding it, which is the difference between an email feature
-- that quietly stops working and one that says so.

alter table style_submissions
  add column if not exists admin_notified_at timestamptz;

comment on column style_submissions.admin_notified_at is
  'When the shop was emailed that this was waiting. Null on a pending row means
   nobody has been told — a send that never happened, not one that was skipped
   on purpose. Claimed by claim_style_notification and released again if the
   send fails, so a retry is safe and an un-announced row stays visible.';

-- ── Claim ─────────────────────────────────────
-- Returns what the email needs, or null when there is nothing to send. The
-- UPDATE ... RETURNING is the whole concurrency story: the row is stamped and
-- read in one statement, so a second caller finds admin_notified_at already set
-- and gets null.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN is the customer's email address. The
-- caller is the customer's own browser session; the route runs server-side and
-- never echoes this back, but a function that hands out contact details to a
-- customer-triggered path is one refactor away from doing so in public. The
-- admin queue is where a customer's address belongs, and 0054 already gates it
-- on is_admin().
create or replace function public.claim_style_notification(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  claimed style_submissions%rowtype;
  product_name text;
begin
  update style_submissions
     set admin_notified_at = now()
   where id = p_id
     and user_id = auth.uid()          -- from the session, never an argument
     and status = 'pending'
     and admin_notified_at is null
  returning * into claimed;

  if not found then
    return null;
  end if;

  select pv.name into product_name
    from product_versions pv
   where pv.product_id = claimed.product_id and pv.state = 'published';

  return jsonb_build_object(
    'id', claimed.id,
    'product_name', coalesce(product_name, 'a piece'),
    'caption', claimed.caption,
    'credit_name', claimed.credit_name,
    'has_photo', claimed.photo_url is not null,
    'video_platform', claimed.video_platform
  );
end;
$fn$;

-- ── Release ───────────────────────────────────
-- The other half of claiming. If Resend refuses, the stamp is a lie: it says
-- the shop was told when it was not. This puts the row back to un-announced so
-- the queue keeps showing it as owing a message and a retry can take it.
create or replace function public.release_style_notification(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update style_submissions
     set admin_notified_at = null
   where id = p_id
     and user_id = auth.uid()
     and status = 'pending';
  return found;
end;
$fn$;

revoke execute on function public.claim_style_notification(uuid) from public, anon;
revoke execute on function public.release_style_notification(uuid) from public, anon;
grant execute on function public.claim_style_notification(uuid) to authenticated;
grant execute on function public.release_style_notification(uuid) to authenticated;

-- ── A resubmission is a new thing to announce ──
-- 0053 puts a rejected submission back to 'pending' and clears the rejection.
-- It knew nothing about this column, so without the extra line here the second
-- photograph would arrive still stamped from the first and nobody would be told
-- about it — the exact silent failure this migration exists to prevent.
-- Re-declared in full rather than patched, so the function's body is readable
-- in one place; only the reset list below differs from 0053.
create or replace function public.resubmit_style(
  p_id            uuid,
  p_photo_url     text default null,
  p_photo_width   integer default null,
  p_photo_height  integer default null,
  p_video_platform text default null,
  p_video_url     text default null,
  p_caption       text default null,
  p_credit_name   text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target style_submissions%rowtype;
begin
  select * into target from style_submissions where id = p_id;
  if not found then
    return false;
  end if;

  if target.user_id is distinct from auth.uid() then
    raise exception 'That is not your submission';
  end if;

  if target.status = 'approved' then
    raise exception 'That photograph is already published. Withdraw it first if you would like to change it.';
  end if;

  if target.withdrawn_at is not null then
    raise exception 'You have withdrawn that submission. Send a new one instead.';
  end if;

  if not public.has_purchased(target.product_id) then
    raise exception 'Only a verified purchase can be featured';
  end if;

  if coalesce(p_photo_url, p_video_url) is null then
    raise exception 'Add a photograph or a link before sending it again';
  end if;

  update style_submissions
     set photo_url      = p_photo_url,
         photo_width    = p_photo_width,
         photo_height   = p_photo_height,
         video_platform = p_video_platform,
         video_url      = p_video_url,
         caption        = p_caption,
         credit_name    = p_credit_name,
         consented_at   = now(),
         status         = 'pending',
         reject_reason  = null,
         reviewed_at    = null,
         reviewed_by    = null,
         rejection_emailed_at = null,
         -- New in 0055. See above.
         admin_notified_at = null
   where id = p_id;

  return true;
end;
$fn$;

revoke execute on function public.resubmit_style(uuid, text, integer, integer, text, text, text, text)
  from public, anon;
grant execute on function public.resubmit_style(uuid, text, integer, integer, text, text, text, text)
  to authenticated;

-- ── The queue can see who was told ─────────────
-- Appended at the end of the select list, not inserted mid-list: create or
-- replace refuses a column added in the middle, and dropping the function to
-- reorder it would drop its grants with it. Same lesson as 0052's view.
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
           p.email as customer_email,
           coalesce(nullif(btrim(p.full_name), ''), 'A customer') as customer_name,
           s.admin_notified_at
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
  (select count(*) from information_schema.columns
    where table_name = 'style_submissions' and column_name = 'admin_notified_at') as column_present,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'claim_style_notification') as claim_present,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'release_style_notification') as release_present,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'claim_style_notification' and grantee = 'anon') as anon_may_claim,
  -- The customer still cannot write this column directly; claiming goes through
  -- the function or not at all.
  (select count(*) from information_schema.column_privileges
    where table_name = 'style_submissions' and grantee = 'authenticated'
      and privilege_type = 'UPDATE' and column_name = 'admin_notified_at') as customer_may_write_column,
  (select count(*) from style_submissions
    where status = 'pending' and admin_notified_at is null) as pending_unannounced;
