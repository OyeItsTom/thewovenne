-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK of 0074_order_confirmation_deliveries.sql: guarded. Restores the
-- database as it was after 0073, ONLY before any order-confirmation delivery
-- has been recorded.
--
-- NOT A MIGRATION. Run with scripts/run-recovery-sql.mjs, never with
-- scripts/run-migration.mjs. Order: 0076, then 0075, then THIS, last.
--
-- PRECONDITIONS (supabase/recovery/README.md):
--   1. Production code is already back on a deployment WITHOUT #220 (R1).
--      The pre-R1 application never touches 0074's objects, so OLD CODE WITH
--      0074 KEPT IS A SAFE STATE. Prefer it: this script is only for removing
--      a schema that is itself harmful, before it has been used.
--   2. A fresh, verified backup exists.
--
-- REFUSES, changing nothing, if:
--   P1  0074 is not (fully) applied here;
--   P2  0075 or 0076 is still applied (roll those back first);
--   R1  ANY row exists in order_email_deliveries, in ANY status (pending,
--       sending, accepted, uncertain, retryable, failed or expired). Each row is
--       a customer communication or its intent, with the idempotency key that
--       stops a duplicate. Removing one needs a separately reviewed archive and
--       recovery plan, never this script;
--   R2  order_email_recovery_settings does not hold exactly its one row.
-- On refusal, FIX FORWARD (README). Never edit these guards to force it.
--
-- KEPT: every order, including orders.confirmation_sent_at (0058's claim,
--   which is what stops the pre-R1 application from emailing twice).
-- REMOVED: order_email_deliveries, order_email_recovery_settings (its cutoff
--   orphan_recovery_since is printed as a NOTICE first, for the record), every
--   0074 function, the guard and scrub triggers, orders_unconfirmed_paid_idx,
--   and the 0074 ledger row. Re-applying 0074 later sets a NEW cutoff, which
--   only narrows automatic recovery (it never emails older orders).
-- ═══════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.order_email_deliveries') is null
     or to_regclass('public.order_email_recovery_settings') is null
     or to_regprocedure('public.enqueue_order_confirmation(uuid)') is null then
    raise exception '0074 rollback refused (P1): 0074 is not (fully) applied here. Nothing changed.';
  end if;
  if to_regprocedure('public.dispatch_order(uuid, text, text, boolean, boolean)') is not null
     or to_regprocedure('public.orders_dispatch_guard()') is not null
     or exists (select 1 from pg_trigger where tgname = 'orders_dispatch_guard')
     or pg_get_constraintdef((select oid from pg_constraint where conname = 'order_email_deliveries_kind_check'
                                and conrelid = 'public.order_email_deliveries'::regclass)) like '%shipment_notification%'
     or exists (select 1 from public.schema_migrations where filename = '0075_order_dispatch.sql') then
    raise exception '0074 rollback refused (P2): 0075 is still applied. Roll back 0076 and 0075 first. Nothing changed.';
  end if;
  if to_regclass('public.style_rejection_notices') is not null
     or exists (select 1 from pg_attribute where attrelid = 'public.style_submissions'::regclass
                 and attname = 'rejection_round' and not attisdropped)
     or exists (select 1 from public.schema_migrations where filename = '0076_style_rejection_notices.sql') then
    raise exception '0074 rollback refused (P2): 0076 is still applied. Roll back 0076 first. Nothing changed.';
  end if;
end $pre$;

-- No settlement (enqueue), worker or anonymisation can interleave.
lock table public.orders, public.order_email_deliveries, public.order_email_recovery_settings
  in access exclusive mode;

do $guard$
declare
  rows_by_status text;
  settings       integer;
  cutoff         timestamptz;
begin
  select string_agg(kind || '/' || status || ':' || n, ', ' order by kind, status) into rows_by_status
    from (select kind, status, count(*) n from public.order_email_deliveries group by kind, status) x;
  if rows_by_status is not null then
    raise exception '0074 rollback refused (R1): delivery records exist (%). Keep 0074 and roll back the code instead; removing records needs a separately reviewed plan. Nothing changed.', rows_by_status;
  end if;

  select count(*), max(orphan_recovery_since) into settings, cutoff from public.order_email_recovery_settings;
  if settings <> 1 then
    raise exception '0074 rollback refused (R2): order_email_recovery_settings holds % rows, expected 1. Nothing changed.', settings;
  end if;
  raise notice '0074 rollback: orphan_recovery_since was % (recorded here; a re-apply sets a new one).', cutoff;
end $guard$;

-- ── Remove what 0074 added (the reverse of its order) ──
drop trigger order_email_deliveries_scrub on public.orders;
drop function public.order_email_deliveries_scrub();
drop function public.order_email_delivery_summary();
drop function public.list_unqueued_paid_orders(integer);
drop function public.list_due_order_email_deliveries(integer);
drop table public.order_email_recovery_settings;
drop index public.orders_unconfirmed_paid_idx;
drop function public.expire_stale_order_email_deliveries(interval);
drop function public.record_order_email_outcome(uuid, uuid, text, text, integer, text, text);
drop function public.begin_order_email_request(uuid, uuid, text, text, text, text);
drop function public.claim_order_email_delivery(uuid, integer);
drop function public.enqueue_order_confirmation(uuid);
drop table public.order_email_deliveries;          -- its guard trigger, indexes and constraints go with it
drop function public.order_email_deliveries_guard();

delete from public.schema_migrations where filename = '0074_order_confirmation_deliveries.sql';

-- ── Self-check: any failure undoes everything above ──
do $verify$
begin
  if to_regclass('public.order_email_deliveries') is not null
     or to_regclass('public.order_email_recovery_settings') is not null
     or to_regclass('public.orders_unconfirmed_paid_idx') is not null
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in (
          'order_email_deliveries_guard', 'order_email_deliveries_scrub', 'enqueue_order_confirmation',
          'claim_order_email_delivery', 'begin_order_email_request', 'record_order_email_outcome',
          'expire_stale_order_email_deliveries', 'list_due_order_email_deliveries',
          'list_unqueued_paid_orders', 'order_email_delivery_summary'))
     or exists (select 1 from pg_trigger where tgname in ('order_email_deliveries_scrub', 'order_email_deliveries_guard'))
     or exists (select 1 from public.schema_migrations where filename = '0074_order_confirmation_deliveries.sql')
     -- The pre-R1 duplicate-send guard must still be there.
     or not exists (select 1 from pg_attribute where attrelid = 'public.orders'::regclass
                     and attname = 'confirmation_sent_at' and not attisdropped) then
    raise exception '0074 rollback self-check failed; everything was undone.';
  end if;
end $verify$;

commit;

select 'ROLLED BACK 0074' as result,
       (select count(*) from public.orders) as orders_kept,
       (select count(*) from public.orders where confirmation_sent_at is not null) as confirmation_claims_kept;
