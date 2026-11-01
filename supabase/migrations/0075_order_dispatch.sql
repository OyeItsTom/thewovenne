-- 0075 — Dispatch through one server-controlled step, with one shipping email (WP-EMAIL-E3a)
--
-- Until now an order became "shipped" by a plain UPDATE from the admin's
-- browser (OrdersManager), and the database let any admin set status, courier
-- and tracking number on any order — paid or not. Nothing could send the
-- customer a shipping email, because nothing on a server saw the change.
--
-- This adds one way to dispatch, and closes the others:
--
--   dispatch_order(order, courier, consignment, confirm_unusual)
--       For a two-factor admin (is_admin(), 0067) only. In ONE transaction,
--       with the order row locked: checks the order is paid, not cancelled,
--       still placed/confirmed and has a delivery address; sets status
--       'shipped', shipped_at, courier_name and awb_number (the 0024 columns —
--       nothing new on orders); and creates exactly one shipping-email intent:
--       an order_email_deliveries row (0074) of kind shipment_notification,
--       generation 1, key shipment-notification/<order>/1, recipient frozen
--       from orders.customer_email. Sending, retries and recovery are R1's.
--       An in-person order (payment_provider is not razorpay) is dispatched
--       without one: those customers are never emailed automatically.
--
--       A repeat with the same consignment (double click, retried request,
--       two tabs) returns already_dispatched and the existing row: no second
--       row, no second email. A different consignment on a shipped order is
--       refused — corrections are a later, explicit step (E3c), never an edit.
--
--   orders_dispatch_guard (trigger)
--       Unless dispatch_order is doing it, refuses:
--         - moving an order INTO 'shipped';
--         - any change to courier_name, awb_number or shipped_at — they are
--           written by dispatch_order and nothing else;
--         - moving a shipped or delivered order back to placed or confirmed;
--         - moving an online order to 'delivered' without it having been
--           shipped (an in-person order may go confirmed -> delivered: it was
--           handed over at the stall).
--       Admins keep every other edit (notes, review flag, shipping cost,
--       shipped -> delivered); payment, stock, loyalty, invoices and
--       cancel_order are untouched (cancel_order changes status to
--       'cancelled', which this does not guard).
--
--   shipment_email_status(order ids)
--       What happened to each order's shipping email, for the Orders screen.
--       Two-factor admins only; never the payload.
--
-- Only India Post Speed Post is supported for now. The consignment number is
-- stored upper-case, letters and digits only, at most 30. A check-digit-valid
-- Speed Post number (UPU S10: E?, eight digits, check digit, IN) is accepted
-- as it is; anything else of that shape is accepted only with
-- confirm_unusual = true, which the Orders screen sends only after the admin
-- has been shown the warning and said yes. A legitimate but unusual number is
-- never refused outright. lib/couriers/indiaPost.ts classifies the same way
-- (tested against each other).
--
-- Depends on 0074 (order_email_deliveries). Applied with
-- scripts/run-migration.mjs, in one transaction. Rollback: see the guarded
-- removal in scripts/order-dispatch.test.ts.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ──
do $$
begin
  if to_regclass('public.order_email_deliveries') is null then
    raise exception '0075: order_email_deliveries (0074) does not exist';
  end if;
  if to_regprocedure('public.dispatch_order(uuid, text, text, boolean)') is not null
     or to_regprocedure('public.dispatch_order(uuid, text, text)') is not null then
    raise exception '0075: dispatch_order already exists; refusing to replace it';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception '0075: is_admin() does not exist';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.order_email_deliveries'::regclass
                    and conname = 'order_email_deliveries_kind_check') then
    raise exception '0075: the 0074 kind check is not where it is expected';
  end if;
end $$;

-- ── R1 learns a second kind ──
alter table public.order_email_deliveries
  drop constraint order_email_deliveries_kind_check,
  add constraint order_email_deliveries_kind_check
    check (kind in ('order_confirmation', 'shipment_notification'));

-- ── The guard ──
create function public.orders_dispatch_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  dispatching boolean := coalesce(current_setting('wovenne.dispatching', true), '') = 'on';
begin
  if dispatching then
    return new;
  end if;
  if new.status = 'shipped' and old.status is distinct from 'shipped' then
    raise exception 'Orders are marked shipped only by dispatching them (dispatch_order), which checks payment and the address and emails the customer once.'
      using errcode = '42501';
  end if;
  if new.courier_name is distinct from old.courier_name
     or new.awb_number is distinct from old.awb_number
     or new.shipped_at is distinct from old.shipped_at then
    raise exception 'The courier, consignment number and dispatch time are recorded only by dispatching the order; a correction is its own step.'
      using errcode = '42501';
  end if;
  if old.status in ('shipped', 'delivered') and new.status in ('placed', 'confirmed') then
    raise exception 'A dispatched order cannot be moved back before dispatch.'
      using errcode = '42501';
  end if;
  if new.status = 'delivered' and old.status is distinct from 'delivered'
     and old.status is distinct from 'shipped'
     and coalesce(old.payment_provider, '') = 'razorpay' then
    raise exception 'An online order is marked delivered only after it has been dispatched.'
      using errcode = '42501';
  end if;
  return new;
end
$fn$;

revoke execute on function public.orders_dispatch_guard() from public, anon, authenticated;

create trigger orders_dispatch_guard
  before update of status, courier_name, awb_number, shipped_at on public.orders
  for each row execute function public.orders_dispatch_guard();

-- ── The Speed Post check, the same as lib/couriers/indiaPost.ts ──
-- 'speed_post' only for S10 with an E? service indicator, IN, and a valid check
-- digit. Anything else is the admin's to confirm.
create function public.is_speed_post_consignment(p text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  w constant int[] := array[8, 6, 4, 2, 3, 5, 9, 7];
  s int := 0;
  c int;
begin
  if p is null or p !~ '^E[A-Z][0-9]{9}IN$' then
    return false;
  end if;
  for i in 1..8 loop
    s := s + substr(p, 2 + i, 1)::int * w[i];
  end loop;
  c := 11 - (s % 11);
  if c = 10 then c := 0; elsif c = 11 then c := 5; end if;
  return c = substr(p, 11, 1)::int;
end
$fn$;

-- ── Dispatch ──
create function public.dispatch_order(p_order_id uuid, p_courier text, p_consignment text,
                                      p_confirm_unusual boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  o orders;
  v_email text;
  v_id uuid;
  v_online boolean;
  v_label constant text := 'India Post — Speed Post';
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  if p_courier is distinct from 'india_post_speed_post' then
    raise exception 'Only India Post Speed Post is supported.' using errcode = '22023';
  end if;
  if p_consignment is null or p_consignment !~ '^[A-Z0-9]{1,30}$' then
    raise exception 'The consignment number must be letters and digits only, at most 30.' using errcode = '22023';
  end if;

  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'That order does not exist.' using errcode = 'P0002';
  end if;

  -- A repeat of the same dispatch is an answer, not an error.
  if o.status in ('shipped', 'delivered') then
    if o.awb_number is not distinct from p_consignment and o.courier_name is not distinct from v_label then
      select d.id into v_id from order_email_deliveries d
       where d.order_id = o.id and d.kind = 'shipment_notification'
       order by d.generation desc limit 1;
      return jsonb_build_object('outcome', 'already_dispatched', 'delivery_id', v_id);
    end if;
    raise exception 'This order has already been dispatched with different details.' using errcode = '55000';
  end if;
  if o.status = 'cancelled' then
    raise exception 'A cancelled order cannot be dispatched.' using errcode = '55000';
  end if;
  if o.payment_status is distinct from 'paid' then
    raise exception 'Only a paid order can be dispatched.' using errcode = '55000';
  end if;
  if o.status not in ('placed', 'confirmed') then
    raise exception 'This order cannot be dispatched from its current status.' using errcode = '55000';
  end if;
  if o.shipping_address is null or jsonb_typeof(o.shipping_address) <> 'object'
     or nullif(btrim(coalesce(o.shipping_address ->> 'line1', '')), '') is null
     or nullif(btrim(coalesce(o.shipping_address ->> 'city', '')), '') is null
     or nullif(btrim(coalesce(o.shipping_address ->> 'postal_code', '')), '') is null then
    raise exception 'This order has no complete delivery address.' using errcode = '55000';
  end if;
  -- Checked last, so an admin is never asked to confirm a number for an order
  -- that could not be dispatched anyway.
  if not public.is_speed_post_consignment(p_consignment) and p_confirm_unusual is not true then
    raise exception 'This is not a check-digit-valid Speed Post number; confirm it before dispatching.'
      using errcode = '22023', hint = 'needs_confirmation';
  end if;

  perform set_config('wovenne.dispatching', 'on', true);
  update orders
     set status = 'shipped',
         shipped_at = now(),
         courier_name = v_label,
         awb_number = p_consignment
   where id = o.id;
  perform set_config('wovenne.dispatching', '', true);

  -- In person: never emailed automatically (the same rule as the confirmation,
  -- list_unqueued_paid_orders in 0074).
  v_online := coalesce(o.payment_provider, '') = 'razorpay';
  if not v_online then
    return jsonb_build_object('outcome', 'dispatched', 'delivery_id', null, 'emailed', false,
                              'email', 'in_person');
  end if;

  v_email := nullif(btrim(coalesce(o.customer_email, '')), '');
  insert into order_email_deliveries (order_id, kind, generation, idempotency_key, recipient, status, last_error_code)
  values (o.id, 'shipment_notification', 1, 'shipment-notification/' || o.id::text || '/1', v_email,
          case when v_email is null then 'failed' else 'pending' end,
          case when v_email is null then 'no_recipient' end)
  on conflict (order_id, kind, generation) do nothing
  returning id into v_id;

  if v_id is null then
    select d.id into v_id from order_email_deliveries d
     where d.order_id = o.id and d.kind = 'shipment_notification' and d.generation = 1;
  end if;

  return jsonb_build_object('outcome', 'dispatched', 'delivery_id', v_id, 'emailed', v_email is not null,
                            'email', case when v_email is null then 'no_recipient' else 'queued' end);
end
$fn$;

comment on function public.dispatch_order(uuid, text, text, boolean) is
  'The only way an order becomes shipped (0075). Two-factor admins only;
   paid, not cancelled, placed/confirmed, with an address; an unusual
   consignment number only with p_confirm_unusual. Records the courier and
   consignment and, for an online order, exactly one shipping-email intent.';

-- The admin's own session calls this (the route uses the caller's cookies, as
-- cancel_order does), so it is granted to authenticated and decided inside by
-- is_admin(). Never anon. service_role has no auth.uid() and is refused by the
-- same check.
revoke execute on function public.dispatch_order(uuid, text, text, boolean) from public, anon;
grant execute on function public.dispatch_order(uuid, text, text, boolean) to authenticated;
revoke execute on function public.is_speed_post_consignment(text) from public, anon;
grant execute on function public.is_speed_post_consignment(text) to authenticated, service_role;

-- ── What happened to the shipping email, for the Orders screen ──
-- order_email_deliveries stays service_role-only (0074); this hands a
-- two-factor admin the status columns of shipment rows and nothing else — no
-- recipient, no payload, no idempotency key.
create function public.shipment_email_status(p_order_ids uuid[])
returns table (order_id uuid, status text, possibly_accepted boolean, attempts integer,
               last_error_code text, accepted_at timestamptz, next_attempt_at timestamptz,
               updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_order_ids), 0) > 500 then
    raise exception 'At most 500 orders at a time.' using errcode = '22023';
  end if;
  return query
    select distinct on (d.order_id)
           d.order_id, d.status, d.possibly_accepted, d.attempts, d.last_error_code,
           d.accepted_at, d.next_attempt_at, d.updated_at
      from order_email_deliveries d
     where d.kind = 'shipment_notification'
       and d.order_id = any (p_order_ids)
     order by d.order_id, d.generation desc;
end
$fn$;

revoke execute on function public.shipment_email_status(uuid[]) from public, anon;
grant execute on function public.shipment_email_status(uuid[]) to authenticated;

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
  f regprocedure := 'public.dispatch_order(uuid, text, text, boolean)'::regprocedure;
  st regprocedure := 'public.shipment_email_status(uuid[])'::regprocedure;
begin
  if has_function_privilege('anon', f, 'EXECUTE') then
    problems := problems || 'anon can execute dispatch_order'::text;
  end if;
  if not has_function_privilege('authenticated', f, 'EXECUTE') then
    problems := problems || 'authenticated cannot execute dispatch_order'::text;
  end if;
  if has_function_privilege('anon', st, 'EXECUTE') then
    problems := problems || 'anon can execute shipment_email_status'::text;
  end if;
  if not public.is_speed_post_consignment('EE123456785IN') or public.is_speed_post_consignment('EE123456784IN')
     or public.is_speed_post_consignment('RR123456785IN') or public.is_speed_post_consignment('EE123456785GB') then
    problems := problems || 'is_speed_post_consignment disagrees with S10'::text;
  end if;
  if not (select prosecdef and coalesce(proconfig, '{}') @> array['search_path=public, pg_temp'] from pg_proc where oid = f) then
    problems := problems || 'dispatch_order is not SECURITY DEFINER with a pinned search_path'::text;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'orders_dispatch_guard'
                   and tgrelid = 'public.orders'::regclass and tgenabled = 'O') then
    problems := problems || 'the dispatch guard is missing or disabled'::text;
  end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'order_email_deliveries_kind_check'
                             and conrelid = 'public.order_email_deliveries'::regclass)) not like '%shipment_notification%' then
    problems := problems || 'order_email_deliveries does not accept shipment_notification'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0075_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select
  has_function_privilege('anon', 'public.dispatch_order(uuid, text, text, boolean)', 'EXECUTE') as anon_execute_must_be_false,
  has_function_privilege('authenticated', 'public.dispatch_order(uuid, text, text, boolean)', 'EXECUTE') as authenticated_execute,
  (select count(*) from public.orders where status = 'shipped') as orders_already_shipped_untouched;
