-- 0068 — Analytics foundation: first-party event collection
--
-- Wovenne's own record of what visitors DO on the shop — pages and products
-- viewed, searches, bag and wishlist changes, checkouts started, purchases —
-- kept in our own database rather than handed to a third-party tag.
--
-- WHAT THIS STORES, AND WHAT IT REFUSES TO.
--   * No IP address. The collector hashes it (HMAC, salt rotated daily) for the
--     rate limiter only; that digest lives in analytics_rate for minutes.
--   * No User-Agent. The collector reduces it to mobile / tablet / desktop and
--     throws the string away.
--   * No city, no coordinates. Country and first-level region (ISO 3166-2, e.g.
--     IN / KL) from the host's IP lookup, which is approximate and labelled so.
--   * No full referrer URL — the host only, since a URL can carry someone
--     else's query string.
--   * No inferred gender or demographics of any kind. There is no column for it.
--   * No free-form JSON. Every field is a typed, length-bounded column, so the
--     table cannot quietly become a dumping ground.
--
-- TWO TIERS OF IDENTITY.
--   Without analytics consent an event carries NO identifier: it is a count
--   with a path, a coarse device and an approximate country. Nothing is stored
--   on the visitor's device to produce it.
--   With analytics consent (a later, separately approved change adds the
--   consent prompt) the collector reads a random first-party visitor id and
--   groups events into sessions (30 minutes of inactivity ends one). Until then
--   visitor_id and session_id simply stay null.
--
-- WHO MAY TOUCH IT.
--   anon / authenticated: nothing — no table grants, RLS on, no policies.
--   Writes come only through analytics_ingest(), executable by service_role
--   alone (the /api/events route, which validates first), and through two
--   triggers that record wishlist changes and paid online orders from the
--   authoritative rows themselves. The browser cannot claim a user id, a
--   purchase or a wishlist change.
--   Reads for the admin go through can_read_analytics() — is_admin() (0067:
--   staff + aal2 + live session) or service_role.
--
-- Times are stored in UTC. Reporting days are Asia/Kolkata (decided in the
-- aggregation work; nothing here groups by day).
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local search_path = public, pg_temp;

-- ── The admin read gate, made NULL-safe ───────
-- 0025's gate was `is_admin() or auth.role() = 'service_role'`. With no role
-- claim at all, that is `false or null` — NULL — and every caller wrote
-- `if not can_read_analytics() then raise`, which does NOT raise on NULL. Not
-- reachable through the Data API (every request there carries a role claim),
-- but a gate must not depend on that. Same meaning; never NULL. Every analytics
-- function, old and new, goes through it.
create or replace function public.can_read_analytics()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(public.is_admin(), false) or coalesce(auth.role() = 'service_role', false);
$fn$;

-- ── Sessions (consented visitors only) ────────
create table if not exists public.analytics_sessions (
  id            uuid primary key default gen_random_uuid(),
  visitor_id    uuid not null,
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  event_count   integer not null default 0 check (event_count >= 0),
  -- Set once the visitor is signed in during THIS session. Earlier sessions of
  -- the same visitor are never back-filled with an identity.
  user_id       uuid references auth.users(id) on delete set null,
  landing_path  text check (char_length(landing_path) <= 200),
  source        text check (source ~ '^[a-z0-9_.-]{1,40}$'),
  referrer_host text check (char_length(referrer_host) <= 100),
  utm_source    text check (char_length(utm_source) <= 60),
  utm_medium    text check (char_length(utm_medium) <= 60),
  utm_campaign  text check (char_length(utm_campaign) <= 60),
  device        text check (device in ('mobile', 'tablet', 'desktop')),
  country_code  text check (country_code ~ '^[A-Z]{2}$'),
  region        text check (region ~ '^[A-Z0-9]{1,3}$'),
  traffic       text not null default 'customer' check (traffic in ('customer', 'internal'))
);

create index if not exists analytics_sessions_visitor_idx
  on public.analytics_sessions (visitor_id, last_seen_at desc);
create index if not exists analytics_sessions_started_idx
  on public.analytics_sessions (started_at);

-- ── Events ────────────────────────────────────
create table if not exists public.analytics_events (
  id              bigint generated always as identity primary key,
  -- Random per event, minted in the browser. A beacon retried by the browser
  -- carries the same id and is stored once.
  client_event_id uuid unique,
  event_type      text not null check (event_type in (
                    'page_view', 'product_view', 'search',
                    'cart_add', 'cart_remove', 'checkout_start', 'whatsapp_click',
                    'wishlist_add', 'wishlist_remove', 'purchase')),
  occurred_at     timestamptz not null default now(),
  session_id      uuid references public.analytics_sessions(id) on delete set null,
  visitor_id      uuid,
  user_id         uuid references auth.users(id) on delete set null,
  product_id      uuid references public.products(id) on delete set null,
  category_id     uuid references public.categories(id) on delete set null,
  order_id        uuid references public.orders(id) on delete set null,
  path            text check (char_length(path) <= 200),
  -- The first page of a page load: where attribution (source/UTM) is read.
  is_entry        boolean not null default false,
  source          text check (source ~ '^[a-z0-9_.-]{1,40}$'),
  referrer_host   text check (char_length(referrer_host) <= 100),
  utm_source      text check (char_length(utm_source) <= 60),
  utm_medium      text check (char_length(utm_medium) <= 60),
  utm_campaign    text check (char_length(utm_campaign) <= 60),
  device          text check (device in ('mobile', 'tablet', 'desktop')),
  country_code    text check (country_code ~ '^[A-Z]{2}$'),
  region          text check (region ~ '^[A-Z0-9]{1,3}$'),
  search_term     text check (char_length(search_term) between 1 and 64),
  result_count    integer check (result_count between 0 and 10000),
  quantity        integer check (quantity between 1 and 99),
  traffic         text not null default 'customer' check (traffic in ('customer', 'internal')),
  constraint analytics_events_search_has_term
    check (event_type <> 'search' or search_term is not null),
  constraint analytics_events_attribution_on_entry_only
    check (is_entry or (source is null and referrer_host is null
                        and utm_source is null and utm_medium is null and utm_campaign is null))
);

create index if not exists analytics_events_occurred_idx
  on public.analytics_events (occurred_at);
create index if not exists analytics_events_type_occurred_idx
  on public.analytics_events (event_type, occurred_at);
create index if not exists analytics_events_product_idx
  on public.analytics_events (product_id, occurred_at) where product_id is not null;
create index if not exists analytics_events_session_idx
  on public.analytics_events (session_id) where session_id is not null;
-- One purchase per order, whichever path (browser callback, webhook, replay)
-- marks it paid and however many times.
create unique index if not exists analytics_events_one_purchase_per_order
  on public.analytics_events (order_id) where event_type = 'purchase';

-- ── Rate limiter state (minutes-lived) ────────
create table if not exists public.analytics_rate (
  rate_key     text primary key check (rate_key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null default now(),
  event_count  integer not null default 0
);
create index if not exists analytics_rate_window_idx on public.analytics_rate (window_start);

-- ── Nobody but the server ─────────────────────
alter table public.analytics_sessions enable row level security;
alter table public.analytics_events   enable row level security;
alter table public.analytics_rate     enable row level security;
revoke all on public.analytics_sessions, public.analytics_events, public.analytics_rate
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.analytics_sessions, public.analytics_events, public.analytics_rate
  to service_role;

-- ── Ingest: the only way a browser event gets in ──
-- Called by /api/events with the service role after the route has validated
-- shape, size and environment. Re-checks what matters here, because a check
-- that lives only in TypeScript is a check one refactor away from gone:
--   * client event types only — never purchase or wishlist (those are derived
--     from the authoritative rows by the triggers below);
--   * products must exist; the category is taken from the product, not the
--     browser;
--   * at most 20 events per call and 120 per rate key per minute.
-- p_context.user_id is set by the route from a validated session, never from
-- the request body.
create or replace function public.analytics_ingest(
  p_rate_key text,
  p_context  jsonb,
  p_events   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_limit   constant integer  := 120;
  v_window  constant interval := interval '1 minute';
  v_n        integer;
  v_rate     public.analytics_rate%rowtype;
  v_visitor  uuid;
  v_user     uuid;
  v_device   text;
  v_country  text;
  v_region   text;
  v_traffic  text;
  v_session  uuid;
  v_first    jsonb;
  e          jsonb;
  v_type     text;
  v_product  uuid;
  v_category uuid;
  v_rows     integer;
  v_accepted integer := 0;
  v_dupes    integer := 0;
  v_skipped  integer := 0;
begin
  if p_rate_key is null or p_rate_key !~ '^[0-9a-f]{64}$' then
    raise exception 'analytics_ingest: invalid rate key';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'analytics_ingest: events must be an array';
  end if;
  v_n := jsonb_array_length(p_events);
  if v_n = 0 then
    return jsonb_build_object('accepted', 0, 'duplicates', 0, 'skipped', 0, 'limited', false);
  end if;
  if v_n > 20 then
    raise exception 'analytics_ingest: at most 20 events per batch';
  end if;

  -- Rate limit, counted in the database because serverless instances share no
  -- memory. A blocked caller is not charged, so retrying cannot push the reset
  -- further away. Old windows are swept on the way in.
  delete from public.analytics_rate where window_start < now() - interval '10 minutes';
  insert into public.analytics_rate (rate_key) values (p_rate_key) on conflict do nothing;
  select * into v_rate from public.analytics_rate where rate_key = p_rate_key for update;
  if v_rate.window_start < now() - v_window then
    update public.analytics_rate set window_start = now(), event_count = v_n where rate_key = p_rate_key;
  elsif v_rate.event_count + v_n > v_limit then
    return jsonb_build_object('accepted', 0, 'duplicates', 0, 'skipped', v_n, 'limited', true);
  else
    update public.analytics_rate set event_count = event_count + v_n where rate_key = p_rate_key;
  end if;

  v_visitor := nullif(p_context->>'visitor_id', '')::uuid;
  v_user    := nullif(p_context->>'user_id', '')::uuid;
  v_device  := p_context->>'device';
  v_country := p_context->>'country_code';
  v_region  := p_context->>'region';
  v_traffic := coalesce(p_context->>'traffic', 'customer');

  if v_user is not null and not exists (select 1 from auth.users where id = v_user) then
    v_user := null;
  end if;
  -- Staff are internal traffic whatever the browser says.
  if v_user is not null and exists (select 1 from public.profiles where id = v_user and is_admin) then
    v_traffic := 'internal';
  end if;

  -- Sessions exist only for a consented visitor id.
  if v_visitor is not null then
    select id into v_session
      from public.analytics_sessions
     where visitor_id = v_visitor and last_seen_at > now() - interval '30 minutes'
     order by last_seen_at desc
     limit 1
     for update;

    if v_session is null then
      select x.value into v_first
        from jsonb_array_elements(p_events) as x(value)
       order by coalesce((x.value->>'is_entry')::boolean, false) desc
       limit 1;
      insert into public.analytics_sessions
        (visitor_id, user_id, landing_path, source, referrer_host,
         utm_source, utm_medium, utm_campaign, device, country_code, region, traffic)
      values
        (v_visitor, v_user, v_first->>'path',
         case when (v_first->>'is_entry')::boolean then v_first->>'source' end,
         case when (v_first->>'is_entry')::boolean then v_first->>'referrer_host' end,
         case when (v_first->>'is_entry')::boolean then v_first->>'utm_source' end,
         case when (v_first->>'is_entry')::boolean then v_first->>'utm_medium' end,
         case when (v_first->>'is_entry')::boolean then v_first->>'utm_campaign' end,
         v_device, v_country, v_region, v_traffic)
      returning id into v_session;
    else
      update public.analytics_sessions
         set last_seen_at = now(),
             user_id = coalesce(user_id, v_user),
             traffic = case when v_traffic = 'internal' then 'internal' else traffic end
       where id = v_session;
    end if;
  end if;

  for e in select * from jsonb_array_elements(p_events) loop
    v_type := e->>'type';
    if v_type is null or v_type not in
       ('page_view', 'product_view', 'search', 'cart_add', 'cart_remove',
        'checkout_start', 'whatsapp_click') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_product := null;
    v_category := null;
    if nullif(e->>'product_id', '') is not null then
      select p.id, p.category_id into v_product, v_category
        from public.products p where p.id = (e->>'product_id')::uuid;
    end if;
    if v_type in ('product_view', 'cart_add', 'cart_remove') and v_product is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.analytics_events
      (client_event_id, event_type, session_id, visitor_id, user_id, product_id, category_id,
       path, is_entry, source, referrer_host, utm_source, utm_medium, utm_campaign,
       device, country_code, region, search_term, result_count, quantity, traffic)
    values
      (nullif(e->>'client_event_id', '')::uuid, v_type, v_session, v_visitor, v_user,
       v_product, v_category,
       e->>'path', coalesce((e->>'is_entry')::boolean, false),
       -- Attribution belongs to the entry page only; anything else is dropped.
       case when (e->>'is_entry')::boolean then e->>'source' end,
       case when (e->>'is_entry')::boolean then e->>'referrer_host' end,
       case when (e->>'is_entry')::boolean then e->>'utm_source' end,
       case when (e->>'is_entry')::boolean then e->>'utm_medium' end,
       case when (e->>'is_entry')::boolean then e->>'utm_campaign' end,
       v_device, v_country, v_region,
       e->>'search_term', (e->>'result_count')::integer, (e->>'quantity')::integer, v_traffic)
    on conflict (client_event_id) do nothing;

    get diagnostics v_rows = row_count;
    if v_rows = 1 then v_accepted := v_accepted + 1; else v_dupes := v_dupes + 1; end if;
  end loop;

  if v_session is not null and v_accepted > 0 then
    update public.analytics_sessions set event_count = event_count + v_accepted where id = v_session;
  end if;

  return jsonb_build_object('accepted', v_accepted, 'duplicates', v_dupes,
                            'skipped', v_skipped, 'limited', false);
end;
$fn$;

revoke execute on function public.analytics_ingest(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.analytics_ingest(text, jsonb, jsonb) to service_role;

-- ── Wishlist changes, from the wishlist itself ──
-- Signed-in only (a guest has no wishlist), so the authoritative row already
-- knows; the browser is not asked to report it a second time. No user id is
-- copied — the aggregate needs the product, not the person.
--
-- A cascade (a product or account being deleted) is not a customer removing
-- something, so rows deleted by another trigger are not recorded.
--
-- Never breaks the wishlist: a failure here is logged and swallowed.
create or replace function public.analytics_on_wishlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user    uuid;
  v_product uuid;
  v_type    text;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_user := new.user_id; v_product := new.product_id; v_type := 'wishlist_add';
  else
    v_user := old.user_id; v_product := old.product_id; v_type := 'wishlist_remove';
  end if;
  begin
    insert into public.analytics_events (event_type, product_id, category_id, traffic)
    select v_type, p.id, p.category_id,
           case when exists (select 1 from public.profiles pr where pr.id = v_user and pr.is_admin)
                then 'internal' else 'customer' end
      from public.products p
     where p.id = v_product;
  exception when others then
    raise warning 'analytics: wishlist event not recorded: %', sqlerrm;
  end;
  return null;
end;
$fn$;

revoke execute on function public.analytics_on_wishlist() from public, anon, authenticated;

drop trigger if exists analytics_wishlist_event on public.wishlists;
create trigger analytics_wishlist_event
  after insert or delete on public.wishlists
  for each row execute function public.analytics_on_wishlist();

-- ── Purchases, from the order becoming paid ───
-- The moment an ONLINE order (Razorpay) becomes paid — settle_order's UPDATE,
-- whichever caller triggered it — and never from a browser saying so.
-- In-person sales (0044) are real revenue but not web purchases, so they are
-- left to the orders reports. Replays are absorbed by the one-per-order index.
-- An order placed by a staff account's email is internal traffic.
create or replace function public.analytics_on_order_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.payment_status is distinct from 'paid' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then
    return null;
  end if;
  if coalesce(new.payment_method, 'razorpay') <> 'razorpay' then
    return null;
  end if;
  begin
    insert into public.analytics_events (event_type, order_id, traffic)
    values ('purchase', new.id,
            case when exists (select 1 from public.profiles p join auth.users u on u.id = p.id
                               where p.is_admin and lower(u.email) = lower(new.customer_email))
                 then 'internal' else 'customer' end)
    on conflict do nothing;
  exception when others then
    raise warning 'analytics: purchase event not recorded for order %: %', new.id, sqlerrm;
  end;
  return null;
end;
$fn$;

revoke execute on function public.analytics_on_order_paid() from public, anon, authenticated;

drop trigger if exists analytics_purchase_event on public.orders;
create trigger analytics_purchase_event
  after insert or update of payment_status on public.orders
  for each row execute function public.analytics_on_order_paid();

-- ── Diagnostics for the admin ─────────────────
-- "Why did this number move?" — counts by event and traffic class for a
-- window, how many carried a session, and any purchase whose order is no
-- longer paid. Counts only; never a visitor, a session id or a user id.
create or replace function public.analytics_diagnostics(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $fn$
declare
  result jsonb;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'analytics_diagnostics: invalid window';
  end if;

  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'by_type', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_type', event_type, 'traffic', traffic, 'events', n,
               'with_session', with_session, 'first', first_at, 'last', last_at)
             order by event_type, traffic)
        from (select event_type, traffic, count(*) n,
                     count(*) filter (where session_id is not null) with_session,
                     min(occurred_at) first_at, max(occurred_at) last_at
                from public.analytics_events
               where occurred_at >= p_from and occurred_at < p_to
               group by event_type, traffic) t), '[]'::jsonb),
    'purchases_no_longer_paid', (
      select count(*) from public.analytics_events e
        join public.orders o on o.id = e.order_id
       where e.event_type = 'purchase' and e.occurred_at >= p_from and e.occurred_at < p_to
         and o.payment_status is distinct from 'paid'),
    'sessions', (
      select count(*) from public.analytics_sessions
       where started_at >= p_from and started_at < p_to)
  ) into result;

  return result;
end;
$fn$;

revoke execute on function public.analytics_diagnostics(timestamptz, timestamptz) from public, anon;
grant execute on function public.analytics_diagnostics(timestamptz, timestamptz) to authenticated, service_role;

-- ── Retention ─────────────────────────────────
-- Raw events and sessions are kept for p_days (recommended 180); daily
-- aggregates — added with the aggregation work — are what keeps the long view.
-- Not scheduled here; the aggregation work runs it after rolling a day up.
create or replace function public.analytics_purge(p_days integer default 180)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_events   integer;
  v_sessions integer;
begin
  if p_days is null or p_days < 30 then
    raise exception 'analytics_purge: keep at least 30 days';
  end if;
  delete from public.analytics_events where occurred_at < now() - make_interval(days => p_days);
  get diagnostics v_events = row_count;
  delete from public.analytics_sessions where last_seen_at < now() - make_interval(days => p_days);
  get diagnostics v_sessions = row_count;
  delete from public.analytics_rate where window_start < now() - interval '10 minutes';
  return jsonb_build_object('events', v_events, 'sessions', v_sessions);
end;
$fn$;

revoke execute on function public.analytics_purge(integer) from public, anon, authenticated;
grant execute on function public.analytics_purge(integer) to service_role;

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
  t text;
begin
  foreach t in array array['analytics_events', 'analytics_sessions', 'analytics_rate'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      problems := problems || (t || ' has RLS off');
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      problems := problems || (t || ' has a policy');
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'insert') then
      problems := problems || (t || ' is reachable by anon or authenticated');
    end if;
  end loop;
  if has_function_privilege('anon', 'public.analytics_ingest(text, jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.analytics_ingest(text, jsonb, jsonb)', 'execute') then
    problems := problems || 'analytics_ingest is executable by anon or authenticated'::text;
  end if;
  if has_function_privilege('anon', 'public.analytics_diagnostics(timestamptz, timestamptz)', 'execute') then
    problems := problems || 'analytics_diagnostics is executable by anon'::text;
  end if;
  if has_function_privilege('authenticated', 'public.analytics_purge(integer)', 'execute') then
    problems := problems || 'analytics_purge is executable by authenticated'::text;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name in ('analytics_events', 'analytics_sessions')
              and column_name in ('gender', 'inferred_gender', 'predicted_gender', 'ip', 'ip_address',
                                  'user_agent', 'latitude', 'longitude', 'city', 'email')) then
    problems := problems || 'an analytics table has a column it must not have'::text;
  end if;
  if public.can_read_analytics() is null then
    problems := problems || 'can_read_analytics() can still return NULL'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0068_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select c.relname as table_name, c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('analytics_events', 'analytics_sessions', 'analytics_rate')
 order by c.relname;
