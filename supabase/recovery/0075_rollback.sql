-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK of 0075_order_dispatch.sql: guarded. Restores the database as it
-- was after 0074, ONLY when no dispatch or shipping-email evidence would be
-- lost and every order stays representable by the pre-E3 application.
--
-- NOT A MIGRATION. Run with scripts/run-recovery-sql.mjs, never with
-- scripts/run-migration.mjs. Order: 0076 first, then THIS, then 0074.
--
-- PRECONDITIONS (supabase/recovery/README.md):
--   1. Production code is already back on a deployment WITHOUT #221 (E3).
--   2. The dispatch freeze is still in force (no order marked shipped).
--   3. A fresh, verified backup exists.
--
-- REFUSES, changing nothing, if:
--   P1  0075 is not (fully) applied here;
--   P2  0076 is still applied (roll it back first; the only tested order);
--   R1  any shipping-email record exists in order_email_deliveries (kind
--       shipment_notification, in ANY status: pending, sending, accepted,
--       uncertain, retryable, failed or expired). It is the evidence of a
--       dispatch and of what the customer was or may have been told, and
--       0074's kind check cannot hold it;
--   R2  any delivery row has a kind 0074 does not know (defensive).
-- On refusal, FIX FORWARD (README). Never edit these guards to force it.
--
-- KEPT: every order, including the status, shipped_at, courier_name and
--   awb_number written by dispatch_order. Those are 0024 columns the pre-E3
--   Orders screen already reads and writes. An order dispatched in person
--   (no email row) is therefore fully represented after rollback.
-- RESTORED: 0074's kind check (order_confirmation only), and with the guard
--   trigger gone, the pre-E3 ability of a two-factor admin to mark orders
--   shipped directly (RLS and column grants are unchanged by 0075).
-- REMOVED: dispatch_order, is_speed_post_consignment, shipment_email_status,
--   orders_dispatch_guard (trigger + function), and the 0075 ledger row.
-- ═══════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';

do $pre$
begin
  if to_regprocedure('public.dispatch_order(uuid, text, text, boolean, boolean)') is null
     or to_regprocedure('public.orders_dispatch_guard()') is null
     or not exists (select 1 from pg_trigger where tgname = 'orders_dispatch_guard'
                     and tgrelid = 'public.orders'::regclass) then
    raise exception '0075 rollback refused (P1): 0075 is not (fully) applied here. Nothing changed.';
  end if;
  if to_regclass('public.style_rejection_notices') is not null
     or exists (select 1 from pg_attribute where attrelid = 'public.style_submissions'::regclass
                 and attname = 'rejection_round' and not attisdropped)
     or exists (select 1 from public.schema_migrations where filename = '0076_style_rejection_notices.sql') then
    raise exception '0075 rollback refused (P2): 0076 is still applied. Roll back 0076 first. Nothing changed.';
  end if;
end $pre$;

-- No dispatch, settlement or email write can interleave with the checks.
lock table public.orders, public.order_email_deliveries in access exclusive mode;

do $guard$
declare
  shipments text;
  odd       integer;
begin
  select string_agg(status || ':' || n, ', ' order by status) into shipments
    from (select status, count(*) n from public.order_email_deliveries
           where kind = 'shipment_notification' group by status) x;
  if shipments is not null then
    raise exception '0075 rollback refused (R1): shipping-email records exist (%). They are dispatch and customer-communication evidence; fix forward instead. Nothing changed.', shipments;
  end if;

  select count(*) into odd from public.order_email_deliveries where kind <> 'order_confirmation';
  if odd > 0 then
    raise exception '0075 rollback refused (R2): % delivery row(s) of an unknown kind. Nothing changed.', odd;
  end if;
end $guard$;

-- ── Remove what 0075 added ─────────────────────
drop trigger orders_dispatch_guard on public.orders;
drop function public.orders_dispatch_guard();
drop function public.dispatch_order(uuid, text, text, boolean, boolean);
drop function public.shipment_email_status(uuid[]);
drop function public.is_speed_post_consignment(text);

-- ── Restore 0074's kind check ──────────────────
alter table public.order_email_deliveries
  drop constraint order_email_deliveries_kind_check,
  add constraint order_email_deliveries_kind_check check (kind = 'order_confirmation');

delete from public.schema_migrations where filename = '0075_order_dispatch.sql';

-- ── Self-check: any failure undoes everything above ──
do $verify$
begin
  if to_regprocedure('public.dispatch_order(uuid, text, text, boolean, boolean)') is not null
     or to_regprocedure('public.orders_dispatch_guard()') is not null
     or to_regprocedure('public.shipment_email_status(uuid[])') is not null
     or to_regprocedure('public.is_speed_post_consignment(text)') is not null
     or exists (select 1 from pg_trigger where tgname = 'orders_dispatch_guard')
     or pg_get_constraintdef((select oid from pg_constraint where conname = 'order_email_deliveries_kind_check'
                                and conrelid = 'public.order_email_deliveries'::regclass))
        <> 'CHECK ((kind = ''order_confirmation''::text))'
     or exists (select 1 from public.schema_migrations where filename = '0075_order_dispatch.sql')
     -- 0074 must be untouched.
     or to_regprocedure('public.enqueue_order_confirmation(uuid)') is null
     or not exists (select 1 from pg_trigger where tgname = 'order_email_deliveries_guard')
     or not exists (select 1 from pg_trigger where tgname = 'order_email_deliveries_scrub') then
    raise exception '0075 rollback self-check failed; everything was undone.';
  end if;
end $verify$;

commit;

select 'ROLLED BACK 0075' as result,
       (select count(*) from public.orders where status in ('shipped', 'delivered')) as dispatched_orders_kept,
       (select count(*) from public.order_email_deliveries) as confirmation_rows_kept;
