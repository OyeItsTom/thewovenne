-- 0031 — Marketing sends
--
-- Two things: a record of what was sent to whom, and the only function allowed
-- to decide who may receive it.
--
-- CONSENT IS ENFORCED HERE, in SQL, not in the admin screen. A filter in the UI
-- is a filter that can be forgotten, reordered, or bypassed by whatever calls
-- the endpoint next. marketing_targets() returns consented account-holders and
-- nothing else, so a mistake upstream cannot email someone who never agreed.
--
-- Guests are unreachable by construction: the function starts from profiles, so
-- an address with orders but no account is never in the result, however much it
-- has spent.
--
-- A cooldown is applied per trigger. The failure mode of a marketing tool is
-- not sending too little.

create table if not exists marketing_sends (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  email      text not null,
  trigger    text not null,
  subject    text,
  resend_id  text,
  sent_at    timestamptz not null default now(),
  sent_by    uuid
);

create index if not exists marketing_sends_user_trigger_idx
  on marketing_sends (user_id, trigger, sent_at desc);

alter table marketing_sends enable row level security;

do $$ begin
  create policy "Admins read marketing sends" on marketing_sends
    for select to authenticated using (public.is_admin());
exception when duplicate_object then null; end $$;

grant select on marketing_sends to authenticated;
grant all on marketing_sends to service_role;

-- ── Who may receive a given trigger ───────────
-- The single authority on eligibility. Every condition that could send email to
-- the wrong person lives in this one function.
create or replace function public.marketing_targets(
  p_trigger       text,
  p_cooldown_days integer default 7
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can read marketing targets';
  end if;

  with eligible as (
    select p.id, p.email, p.full_name
      from profiles p
     where p.marketing_consent          -- consented, explicitly
       and not p.is_admin               -- staff are not an audience
       and p.email is not null
       -- Not contacted with this trigger recently.
       and not exists (
         select 1 from marketing_sends m
          where m.user_id = p.id
            and m.trigger = p_trigger
            and m.sent_at > now() - (p_cooldown_days || ' days')::interval
       )
  ),
  -- Wishlist items that are still buyable and still on the site.
  saved as (
    select w.user_id,
           pv.name,
           pv.slug,
           coalesce(
             (select sum(ps.stock_quantity) from product_sizes ps
               where ps.product_id = w.product_id),
             pv.stock_quantity
           ) as stock
      from wishlists w
      join product_versions pv
        on pv.product_id = w.product_id
       and pv.state = 'published'
       and pv.is_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', e.id,
           'email', e.email,
           'name', e.full_name,
           'items', items.list
         ) order by e.email), '[]'::jsonb)
    into result
  from eligible e
  join lateral (
    select jsonb_agg(jsonb_build_object('name', s.name, 'slug', s.slug, 'stock', s.stock)) as list,
           count(*) as n
      from saved s
     where s.user_id = e.id
       and case p_trigger
             -- Anything saved and still available.
             when 'wishlist_waiting' then s.stock > 0
             -- Saved, still available, and nearly gone. Three or fewer is the
             -- same threshold the admin dashboard treats as low.
             when 'low_stock' then s.stock > 0 and s.stock <= 3
             else false
           end
  ) items on items.n > 0;

  return result;
end;
$fn$;

revoke execute on function public.marketing_targets(text, integer) from public, anon;
grant execute on function public.marketing_targets(text, integer) to authenticated, service_role;

-- ── Record a send ─────────────────────────────
-- Re-checks consent at the moment of writing, so a withdrawal between building
-- a list and pressing send cannot be overtaken by a stale list. Returns false
-- if the recipient is no longer eligible, and the caller must not send.
create or replace function public.record_marketing_send(
  p_user_id   uuid,
  p_trigger   text,
  p_subject   text,
  p_resend_id text default null,
  p_sent_by   uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  addr text;
begin
  select email into addr
    from profiles
   where id = p_user_id and marketing_consent and not is_admin;

  if addr is null then
    return false;
  end if;

  insert into marketing_sends (user_id, email, trigger, subject, resend_id, sent_by)
  values (p_user_id, addr, p_trigger, p_subject, p_resend_id, p_sent_by);

  return true;
end;
$fn$;

revoke execute on function public.record_marketing_send(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_marketing_send(uuid, text, text, text, uuid) to service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'marketing_sends') as sends_table,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('marketing_targets','record_marketing_send')) as fns,
  (select count(*) from profiles where marketing_consent and not is_admin) as consented_customers,
  (select count(*) from wishlists) as wishlist_rows;
