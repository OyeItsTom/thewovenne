-- 0068 — Analytics foundation: first-party, no-identifier event collection
--
-- Wovenne's own record of what visitors DO on the shop — pages and products
-- viewed, searches, wishlist and bag changes, checkouts started, WhatsApp
-- hand-offs, purchases — kept in our own database rather than handed to a
-- third-party tag. Design notes: docs/analytics.md.
--
-- OFF UNTIL SOMEONE TURNS IT ON, HERE.
--   analytics_config.collecting is the one switch every event source passes
--   through. It starts FALSE, and while it is false NOTHING is written: not a
--   browser event, not a purchase, not even a rate-limiter row. It is changed
--   only by the database owner (scripts/analytics-switch.mjs); no API role can
--   write it. A missing row reads as off.
--
-- NO IDENTIFIERS. An event is a count with a path, a coarse device class, an
-- approximate country/region and the attribution of the page load it happened
-- in. There is no visitor id, no session id, no user id, no customer data —
-- so there are no "unique visitors" or "sessions" to report, and no column
-- that could become one. Adding them later is a new, consented design, not a
-- flag on this one.
--
-- WHAT IT REFUSES TO STORE. No IP address (the collector hashes it, under a
-- daily-rotating key, for the rate limiter only; that digest lives in
-- analytics_rate for minutes). No User-Agent (reduced to mobile / tablet /
-- desktop and discarded). No city, no coordinates. No full referrer URL — the
-- host only. No gender or demographics. No free-form JSON: every field is a
-- typed, bounded column.
--
-- WHO MAY TOUCH IT.
--   anon / authenticated: nothing — no table grants, RLS on, no policies.
--   Writes: analytics_ingest() (browser events, via /api/events) and
--   analytics_record_purchase() (from settlement), both service_role only.
--   Reads for the admin: analytics_diagnostics(), behind can_read_analytics()
--   → is_admin() (0067: staff + aal2 + live session).
--
-- Times are stored in UTC. Business reporting days are Asia/Kolkata (the
-- aggregation work groups by them; nothing here groups by day).
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local search_path = public, pg_temp;

-- ── The admin read gate, made NULL-safe ───────
-- 0025's gate was `is_admin() or auth.role() = 'service_role'`. With no role
-- claim at all, that is `false or null` — NULL — and every caller wrote
-- `if not can_read_analytics() then raise`, which does NOT raise on NULL. Not
-- reachable through the Data API (every request there carries a role claim),
-- but a gate must not depend on that. Same meaning; never NULL.
create or replace function public.can_read_analytics()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(public.is_admin(), false) or coalesce(auth.role() = 'service_role', false);
$fn$;

-- ── The switch ────────────────────────────────
create table if not exists public.analytics_config (
  id          boolean primary key default true check (id),
  collecting  boolean not null default false,
  changed_at  timestamptz not null default now(),
  changed_by  text not null default current_user
);
insert into public.analytics_config (id, collecting) values (true, false) on conflict (id) do nothing;

alter table public.analytics_config enable row level security;
revoke all on public.analytics_config from public, anon, authenticated, service_role;

-- Fail closed: no row, or anything but an explicit true, is off.
create or replace function public.analytics_collecting()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce((select collecting from public.analytics_config where id), false);
$fn$;

revoke execute on function public.analytics_collecting() from public, anon, authenticated;
grant execute on function public.analytics_collecting() to service_role;

-- ── Events ────────────────────────────────────
create table if not exists public.analytics_events (
  id              bigint generated always as identity primary key,
  -- Random per event, minted in the browser. A beacon the browser retries is
  -- stored once. Identifies an EVENT, never a person or device.
  client_event_id uuid unique,
  event_type      text not null check (event_type in (
                    'page_view', 'product_view', 'search',
                    'wishlist_add', 'wishlist_remove', 'cart_add', 'cart_remove',
                    'checkout_start', 'whatsapp_click', 'purchase')),
  occurred_at     timestamptz not null default now(),
  product_id      uuid references public.products(id) on delete set null,
  category_id     uuid references public.categories(id) on delete set null,
  -- Purchases only: the order that became paid. What a future Google Ads
  -- conversion would be derived from; no customer data is copied here.
  order_id        uuid references public.orders(id) on delete set null,
  path            text check (char_length(path) <= 200),
  -- The first page view of a page load (the landing page).
  is_entry        boolean not null default false,
  -- Attribution of the page load the event happened in, as observed. NULL
  -- source = not known (e.g. a full reload from inside the site), which is
  -- different from 'direct' (arrived with no referrer and no campaign tags).
  source          text check (source ~ '^[a-z0-9_.+-]{1,40}$'),
  medium          text check (medium ~ '^[a-z0-9_.+-]{1,40}$'),
  referrer_host   text check (char_length(referrer_host) <= 100),
  utm_source      text check (char_length(utm_source) <= 60),
  utm_medium      text check (char_length(utm_medium) <= 60),
  utm_campaign    text check (char_length(utm_campaign) <= 60),
  utm_content     text check (char_length(utm_content) <= 60),
  utm_term        text check (char_length(utm_term) <= 60),
  device          text check (device in ('mobile', 'tablet', 'desktop')),
  -- Approximate, from the host's IP lookup: ISO country, first-level region.
  country_code    text check (country_code ~ '^[A-Z]{2}$'),
  region          text check (region ~ '^[A-Z0-9]{1,3}$'),
  search_term     text check (char_length(search_term) between 1 and 64),
  result_count    integer check (result_count between 0 and 10000),
  quantity        integer check (quantity between 1 and 99),
  -- customer: counts. internal: staff browsers and staff orders. test: test
  -- payments and any deliberately enabled non-production test. Reports show
  -- customer only.
  traffic         text not null default 'customer' check (traffic in ('customer', 'internal', 'test')),
  constraint analytics_events_search_has_term
    check (event_type <> 'search' or search_term is not null),
  -- An order id belongs on a purchase and nowhere else. (A purchase may lose
  -- it if the order row is ever deleted.)
  constraint analytics_events_order_only_on_purchase
    check (event_type = 'purchase' or order_id is null)
);

create index if not exists analytics_events_occurred_idx
  on public.analytics_events (occurred_at);
create index if not exists analytics_events_type_occurred_idx
  on public.analytics_events (event_type, occurred_at);
create index if not exists analytics_events_product_idx
  on public.analytics_events (product_id, occurred_at) where product_id is not null;
-- One purchase per order, however many times settlement runs.
create unique index if not exists analytics_events_one_purchase_per_order
  on public.analytics_events (order_id) where event_type = 'purchase';

-- ── Rate limiter state (minutes-lived) ────────
create table if not exists public.analytics_rate (
  rate_key     text primary key check (rate_key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null default now(),
  event_count  integer not null default 0
);
create index if not exists analytics_rate_window_idx on public.analytics_rate (window_start);

alter table public.analytics_events enable row level security;
alter table public.analytics_rate   enable row level security;
revoke all on public.analytics_events, public.analytics_rate from public, anon, authenticated;
grant select, insert, update, delete on public.analytics_events, public.analytics_rate to service_role;

-- ── Ingest: the only way a browser event gets in ──
-- Called by /api/events with the service role after the route has checked
-- the deployment, validated the shape and size, and dropped bots and
-- opted-out browsers. Re-checks here what matters, because a check that lives
-- only in TypeScript is one refactor away from gone:
--   * the switch, first — off means nothing is written, not even rate state;
--   * browser event types only — never a purchase;
--   * products must exist; the category comes from the product;
--   * at most 20 events per call and 120 per rate key per minute.
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
  v_limit    constant integer  := 120;
  v_window   constant interval := interval '1 minute';
  v_n        integer;
  v_rate     public.analytics_rate%rowtype;
  v_device   text;
  v_country  text;
  v_region   text;
  v_traffic  text;
  e          jsonb;
  v_type     text;
  v_product  uuid;
  v_category uuid;
  v_rows     integer;
  v_accepted integer := 0;
  v_dupes    integer := 0;
  v_skipped  integer := 0;
begin
  if not public.analytics_collecting() then
    return jsonb_build_object('collecting', false, 'accepted', 0, 'duplicates', 0, 'skipped', 0, 'limited', false);
  end if;
  if p_rate_key is null or p_rate_key !~ '^[0-9a-f]{64}$' then
    raise exception 'analytics_ingest: invalid rate key';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'analytics_ingest: events must be an array';
  end if;
  v_n := jsonb_array_length(p_events);
  if v_n = 0 then
    return jsonb_build_object('collecting', true, 'accepted', 0, 'duplicates', 0, 'skipped', 0, 'limited', false);
  end if;
  if v_n > 20 then
    raise exception 'analytics_ingest: at most 20 events per batch';
  end if;

  -- Rate limit, in the database because serverless instances share no
  -- memory. A blocked caller is not charged, so retrying cannot push the reset
  -- further away. Old windows are swept on the way in.
  delete from public.analytics_rate where window_start < now() - interval '10 minutes';
  insert into public.analytics_rate (rate_key) values (p_rate_key) on conflict do nothing;
  select * into v_rate from public.analytics_rate where rate_key = p_rate_key for update;
  if v_rate.window_start < now() - v_window then
    update public.analytics_rate set window_start = now(), event_count = v_n where rate_key = p_rate_key;
  elsif v_rate.event_count + v_n > v_limit then
    return jsonb_build_object('collecting', true, 'accepted', 0, 'duplicates', 0, 'skipped', v_n, 'limited', true);
  else
    update public.analytics_rate set event_count = event_count + v_n where rate_key = p_rate_key;
  end if;

  v_device  := p_context->>'device';
  v_country := p_context->>'country_code';
  v_region  := p_context->>'region';
  v_traffic := coalesce(p_context->>'traffic', 'customer');

  for e in select * from jsonb_array_elements(p_events) loop
    v_type := e->>'type';
    if v_type is null or v_type not in
       ('page_view', 'product_view', 'search', 'wishlist_add', 'wishlist_remove',
        'cart_add', 'cart_remove', 'checkout_start', 'whatsapp_click') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_product := null;
    v_category := null;
    if nullif(e->>'product_id', '') is not null then
      select p.id, p.category_id into v_product, v_category
        from public.products p where p.id = (e->>'product_id')::uuid;
    end if;
    if v_type in ('product_view', 'wishlist_add', 'wishlist_remove', 'cart_add', 'cart_remove')
       and v_product is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.analytics_events
      (client_event_id, event_type, product_id, category_id, path, is_entry,
       source, medium, referrer_host, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       device, country_code, region, search_term, result_count, quantity, traffic)
    values
      (nullif(e->>'client_event_id', '')::uuid, v_type, v_product, v_category,
       e->>'path', coalesce((e->>'is_entry')::boolean, false),
       e->>'source', e->>'medium', e->>'referrer_host',
       e->>'utm_source', e->>'utm_medium', e->>'utm_campaign', e->>'utm_content', e->>'utm_term',
       v_device, v_country, v_region,
       e->>'search_term', (e->>'result_count')::integer, (e->>'quantity')::integer, v_traffic)
    on conflict (client_event_id) do nothing;

    get diagnostics v_rows = row_count;
    if v_rows = 1 then v_accepted := v_accepted + 1; else v_dupes := v_dupes + 1; end if;
  end loop;

  return jsonb_build_object('collecting', true, 'accepted', v_accepted, 'duplicates', v_dupes,
                            'skipped', v_skipped, 'limited', false);
end;
$fn$;

revoke execute on function public.analytics_ingest(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.analytics_ingest(text, jsonb, jsonb) to service_role;

-- ── Purchase: from the order, never from a browser ──
-- Called by settlement (lib/settleOrder) once Razorpay's API has confirmed the
-- capture and the order row is marked paid. Takes only the order id and
-- whether the payment was in Razorpay test mode; everything else is read from
-- the order here:
--   * the switch, first;
--   * only an ONLINE order (payment_method razorpay) that IS paid — an
--     in-person sale (0044) is revenue, not a web purchase;
--   * one per order (the unique index): a webhook arriving after the browser
--     callback, or a replay, is absorbed;
--   * a test payment is test traffic; a staff account's email is internal.
-- Returns what it did, for logs and tests.
create or replace function public.analytics_record_purchase(p_order_id uuid, p_test_mode boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_order   public.orders%rowtype;
  v_traffic text;
  v_rows    integer;
begin
  if not public.analytics_collecting() then
    return 'off';
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return 'no_order';
  end if;
  if v_order.payment_status is distinct from 'paid' then
    return 'not_paid';
  end if;
  if coalesce(v_order.payment_method, 'razorpay') <> 'razorpay' then
    return 'not_online';
  end if;

  -- Unknown mode counts as test: it is the side that cannot inflate demand.
  v_traffic := case
    when coalesce(p_test_mode, true) then 'test'
    when exists (select 1 from public.profiles p join auth.users u on u.id = p.id
                  where p.is_admin and lower(u.email) = lower(v_order.customer_email)) then 'internal'
    else 'customer'
  end;

  insert into public.analytics_events (event_type, order_id, traffic)
  values ('purchase', p_order_id, v_traffic)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  return case when v_rows = 1 then 'recorded' else 'duplicate' end;
end;
$fn$;

revoke execute on function public.analytics_record_purchase(uuid, boolean) from public, anon, authenticated;
grant execute on function public.analytics_record_purchase(uuid, boolean) to service_role;

-- ── Diagnostics for the admin ─────────────────
-- "Why did this number move?" — whether collection is on, counts by event and
-- traffic class for a window with first/last times, and any purchase whose
-- order is no longer paid. Counts only; never an id.
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
    'collecting', public.analytics_collecting(),
    'collecting_changed_at', (select changed_at from public.analytics_config where id),
    'from', p_from,
    'to', p_to,
    'by_type', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_type', event_type, 'traffic', traffic, 'events', n,
               'first', first_at, 'last', last_at)
             order by event_type, traffic)
        from (select event_type, traffic, count(*) n,
                     min(occurred_at) first_at, max(occurred_at) last_at
                from public.analytics_events
               where occurred_at >= p_from and occurred_at < p_to
               group by event_type, traffic) t), '[]'::jsonb),
    'purchases_no_longer_paid', (
      select count(*) from public.analytics_events e
        join public.orders o on o.id = e.order_id
       where e.event_type = 'purchase' and e.occurred_at >= p_from and e.occurred_at < p_to
         and o.payment_status is distinct from 'paid')
  ) into result;

  return result;
end;
$fn$;

revoke execute on function public.analytics_diagnostics(timestamptz, timestamptz) from public, anon;
grant execute on function public.analytics_diagnostics(timestamptz, timestamptz) to authenticated, service_role;

-- ── Retention ─────────────────────────────────
-- Raw events are kept for p_days (Wovenne's product decision: 180); daily
-- aggregates, added with the aggregation work, keep the long view. Not
-- scheduled here — the aggregation work runs it after rolling a day up.
create or replace function public.analytics_purge(p_days integer default 180)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_events integer;
begin
  if p_days is null or p_days < 30 then
    raise exception 'analytics_purge: keep at least 30 days';
  end if;
  delete from public.analytics_events where occurred_at < now() - make_interval(days => p_days);
  get diagnostics v_events = row_count;
  delete from public.analytics_rate where window_start < now() - interval '10 minutes';
  return jsonb_build_object('events', v_events);
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
  if public.analytics_collecting() then
    problems := problems || 'analytics_config is not OFF'::text;
  end if;
  foreach t in array array['analytics_events', 'analytics_rate', 'analytics_config'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      problems := problems || (t || ' has RLS off');
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      problems := problems || (t || ' has a policy');
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('anon', 'public.' || t, 'update') or has_table_privilege('authenticated', 'public.' || t, 'update') then
      problems := problems || (t || ' is reachable by anon or authenticated');
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.analytics_config', 'update') then
    problems := problems || 'service_role can change the analytics switch'::text;
  end if;
  if has_function_privilege('anon', 'public.analytics_ingest(text, jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.analytics_ingest(text, jsonb, jsonb)', 'execute') then
    problems := problems || 'analytics_ingest is executable by anon or authenticated'::text;
  end if;
  if has_function_privilege('authenticated', 'public.analytics_record_purchase(uuid, boolean)', 'execute') then
    problems := problems || 'analytics_record_purchase is executable by authenticated'::text;
  end if;
  if has_function_privilege('anon', 'public.analytics_diagnostics(timestamptz, timestamptz)', 'execute') then
    problems := problems || 'analytics_diagnostics is executable by anon'::text;
  end if;
  if has_function_privilege('authenticated', 'public.analytics_purge(integer)', 'execute') then
    problems := problems || 'analytics_purge is executable by authenticated'::text;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'analytics_events'
              and column_name in ('visitor_id', 'session_id', 'user_id', 'customer_email', 'email',
                                  'gender', 'inferred_gender', 'predicted_gender', 'ip', 'ip_address',
                                  'user_agent', 'latitude', 'longitude', 'city')) then
    problems := problems || 'analytics_events has a column it must not have'::text;
  end if;
  if public.can_read_analytics() is null then
    problems := problems || 'can_read_analytics() can still return NULL'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0068_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select (select collecting from public.analytics_config) as collecting,
       c.relname as table_name, c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('analytics_events', 'analytics_rate', 'analytics_config')
 order by c.relname;
