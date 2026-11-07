-- 0078 — OS-2 (WP-ORDER-SAFETY-05): order status, stock return, credit notes
-- and admin edits are decided by the database, not by the screen.
--
-- WHAT WAS WRONG (WP-ORDER-SAFETY-01, reproduced again on 0001–0077):
--   D1  cancel_order on a SHIPPED or DELIVERED order put the stock back on the
--       shelf and issued a full credit note — for a parcel with the customer.
--   D2  a cancelled order could be re-opened by a plain UPDATE and cancelled
--       again: a second credit note and a SECOND restock (inventory invented).
--   D3  issue_credit_note had no cumulative cap and admins could call it
--       directly: 3 × ₹2,500 notes on a ₹2,500 order.
--   D4  admins held table-wide UPDATE on all 39 order columns: payment_status
--       (free text), total_inr, items, the delivery charge on the invoice …
--       and nothing recorded who changed what.
--
-- WHAT THIS DOES
--   1. Admins keep UPDATE on five operational columns only (admin_note,
--      needs_review, courier_name, awb_number, courier_actual_cost_inr).
--      Status moves through admin_set_order_status, cancel_unpaid_order and
--      cancel_order; dispatch (0075) keeps dispatch_order.
--   2. orders_integrity_guard (every role, every path): no transition out of
--      cancelled, no backward step, no status change outside an order
--      function, a paid order is never un-paid, and once paid its money and
--      basket columns are frozen. payment_status is constrained to
--      pending | paid.
--   3. cancel_order refuses a dispatched or delivered order. Stock comes back
--      only from this order's own sale movements, at most once per line
--      (stock_movements_order_return_guard + a unique index), and never after
--      dispatch. An order-linked 'return' movement needs a verified receipt,
--      which no function provides yet (OS-6), so it is refused.
--   4. Credit notes: never more in total than the order's paid total (a
--      trigger, whoever inserts), at most one cancellation note per order,
--      permanent once issued, and issue_credit_note is no longer callable
--      directly.
--   5. order_events: one row per insert / update / delete of an order, with
--      the actor, the action, from → to, the changed columns and the reason.
--      Contact details are recorded as changed, never copied.
--   6. Three narrow, audited corrections, each with a mandatory reason
--      (WP-ORDER-SAFETY-06, decisions O-2, O-6, O-7):
--        admin_correct_order_status    delivered → shipped, only for an order
--                                      that was dispatched (a mis-click). No
--                                      money, stock or credit note moves.
--        admin_correct_order_contact   name / phone / delivery address before
--                                      dispatch; never the email, state or
--                                      country. The values replaced are kept
--                                      in order_contact_corrections (admins
--                                      read; redacted when the customer's
--                                      details are erased).
--        admin_return_in_person_stock  an IN-PERSON order (payment_provider
--                                      'offline') is cancelled WITHOUT a
--                                      restock, because nothing records whether
--                                      the piece was handed over at the counter.
--                                      The admin states it is back on the shelf
--                                      and this returns it, once, with their
--                                      name on the stock movement.
--
-- WHAT THIS DOES NOT DO
--   No new order or payment status; no historical row is rewritten; refunds
--   stay out of the app (OS-3); loyalty and coupon reversal stay OS-4; returns
--   after dispatch stay OS-6.
--
-- COMPATIBILITY
--   Requires 0077. Works with or without 0074–0076: when dispatch_order
--   (0075) exists, admin_set_order_status refuses 'shipped' and points to it,
--   and 0075's guard keeps the courier fields. Applied in release order after
--   0077 (Gate G) and before the OS-2 application code: an older admin screen
--   still running plain UPDATEs of status or the delivery charge gets
--   "permission denied" until the new code is live — the orders freeze.
--
-- Additive: no column, constraint or row of existing data is changed. The
-- preflight below refuses to apply if existing rows would break a guard.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions and data preflight ────────────────────────────────────────
do $$
declare
  n bigint;
begin
  if to_regprocedure('public.settle_razorpay_payment(text, text, bigint, text, bigint, bigint, text)') is null
     or to_regclass('public.payment_refund_obligations') is null then
    raise exception '0078: 0077 (settle_razorpay_payment, payment_refund_obligations) is not applied';
  end if;
  if to_regprocedure('public.cancel_order(uuid, text)') is null
     or to_regprocedure('public.issue_credit_note(uuid, text, numeric, text, jsonb)') is null
     or to_regprocedure('public.release_stock(jsonb, uuid, text)') is null
     or to_regprocedure('public.is_admin()') is null then
    raise exception '0078: cancel_order / issue_credit_note / release_stock / is_admin are not where they are expected';
  end if;
  if to_regclass('public.order_events') is not null
     or to_regclass('public.order_contact_corrections') is not null
     or to_regprocedure('public.admin_set_order_status(uuid, text, text)') is not null
     or to_regprocedure('public.admin_correct_order_status(uuid, text)') is not null
     or to_regprocedure('public.admin_correct_order_contact(uuid, text, text, jsonb, text)') is not null
     or to_regprocedure('public.admin_return_in_person_stock(uuid, text)') is not null
     or to_regprocedure('public.cancel_unpaid_order(uuid, text)') is not null then
    raise exception '0078: already applied (order_events or the order functions exist); refusing to replace them';
  end if;

  select count(*) into n from orders where payment_status is null or payment_status not in ('pending', 'paid');
  if n > 0 then
    raise exception '0078 PREFLIGHT: % order(s) have a payment_status other than pending/paid; review them before applying', n;
  end if;

  select count(*) into n from (
    select order_id from credit_notes where kind = 'cancellation' and order_id is not null
     group by order_id having count(*) > 1) d;
  if n > 0 then
    raise exception '0078 PREFLIGHT: % order(s) have more than one cancellation credit note (D2); review them before applying', n;
  end if;

  select count(*) into n from (
    select order_id from stock_movements
     where reason = 'cancellation' and order_id is not null
     group by order_id, product_id, coalesce(size_label, '') having count(*) > 1) d;
  if n > 0 then
    raise exception '0078 PREFLIGHT: % order line(s) were restocked by cancellation more than once (D2); review them before applying', n;
  end if;

  select count(*) into n from (
    select o.id from orders o join credit_notes cn on cn.order_id = o.id
     group by o.id, o.total_inr having sum(cn.amount_inr) > o.total_inr) d;
  if n > 0 then
    raise exception '0078 PREFLIGHT: % order(s) are credited for more than their total (D3); review them before applying', n;
  end if;
end $$;

-- ── payment_status is pending | paid ────────────────────────────────────────
alter table public.orders
  add constraint orders_payment_status_check
  check (payment_status in ('pending', 'paid')) not valid;
alter table public.orders validate constraint orders_payment_status_check;

-- ── Audit: order_events ─────────────────────────────────────────────────────
create table public.order_events (
  id                  bigint generated always as identity primary key,
  order_id            uuid not null,
  occurred_at         timestamptz not null default now(),
  actor_id            uuid,
  actor_email         text,
  actor_role          text not null,
  operation           text not null check (operation in ('insert', 'update', 'delete')),
  action              text not null,
  from_status         text,
  to_status           text,
  from_payment_status text,
  to_payment_status   text,
  changes             jsonb,
  reason              text,
  transaction_id      bigint not null default txid_current()
);
comment on table public.order_events is
  'Every insert, update and delete of an order (0078): who (actor id, email,
   API role), what (action: the order function, or a plain update), from → to,
   the changed columns and the reason. Customer contact details are recorded
   as changed, never copied. Written only by the orders_audit trigger.';
create index order_events_order_idx on public.order_events (order_id, occurred_at desc);

alter table public.order_events enable row level security;
create policy "Admins read order events"
  on public.order_events for select to authenticated using (public.is_admin());
revoke all on table public.order_events from public, anon, authenticated, service_role;
grant select on table public.order_events to authenticated, service_role;
revoke all on sequence public.order_events_id_seq from public, anon, authenticated, service_role;

create function public.orders_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  pii constant text[] := array['customer_email', 'customer_name', 'customer_phone', 'shipping_address'];
  v_old    jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new    jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_change jsonb;
  v_claims jsonb;
  v_actor  uuid := auth.uid();
  v_email  text;
  v_role   text;
  v_action text := nullif(current_setting('wovenne.order_action', true), '');
  v_reason text := nullif(current_setting('wovenne.order_reason', true), '');
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, case when k = any (pii) then jsonb_build_object('changed', true)
                                    else jsonb_build_object('from', v_old -> k, 'to', v_new -> k) end)
      into v_change
      from jsonb_object_keys(v_new) k
     where (v_new -> k) is distinct from (v_old -> k);
    if v_change is null then
      return new;
    end if;
  end if;

  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  v_role := coalesce(v_claims ->> 'role', session_user::text);
  if v_actor is not null then
    select p.email into v_email from profiles p where p.id = v_actor;
  end if;
  if v_action is null and current_setting('wovenne.dispatching', true) = 'on' then
    v_action := 'dispatch_order';
  end if;

  insert into order_events (order_id, actor_id, actor_email, actor_role, operation, action,
                            from_status, to_status, from_payment_status, to_payment_status,
                            changes, reason)
  values (coalesce((v_new ->> 'id'), (v_old ->> 'id'))::uuid, v_actor, v_email, v_role, lower(tg_op),
          coalesce(v_action, lower(tg_op)),
          v_old ->> 'status', v_new ->> 'status', v_old ->> 'payment_status', v_new ->> 'payment_status',
          v_change, v_reason);
  return coalesce(new, old);
end
$fn$;
revoke execute on function public.orders_audit() from public, anon, authenticated, service_role;

create trigger orders_audit
  after insert or update or delete on public.orders
  for each row execute function public.orders_audit();

-- ── The order guard: every role, every path ─────────────────────────────────
create function public.orders_integrity_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_in_function boolean := coalesce(current_setting('wovenne.order_transition', true), '') = 'on';
  v_dispatching boolean := coalesce(current_setting('wovenne.dispatching', true), '') = 'on';
  -- Only admin_correct_order_status sets this, and only for delivered → shipped
  -- on a dispatched order; the one backward step there is (O-2).
  v_undeliver   boolean := coalesce(current_setting('wovenne.order_correction', true), '') = 'undeliver'
                           and v_in_function
                           and old.status = 'delivered' and new.status = 'shipped'
                           and old.shipped_at is not null and new.shipped_at is not distinct from old.shipped_at
                           and new.delivered_at is null;
  v_rank_old int;
  v_rank_new int;
begin
  -- A cancelled order stays cancelled. A mistaken cancellation is put right
  -- forward (a new order, replaces_order_id), never by re-opening this one.
  if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    raise exception 'A cancelled order cannot be reopened. Record a new order instead (it can reference this one).'
      using errcode = '55000';
  end if;

  if new.status is distinct from old.status then
    if not (v_in_function or (v_dispatching and new.status = 'shipped')) then
      raise exception 'Order status changes only through the order functions (admin_set_order_status, cancel_unpaid_order, cancel_order, dispatch_order).'
        using errcode = '42501';
    end if;
    v_rank_old := array_position(array['placed', 'confirmed', 'shipped', 'delivered'], old.status);
    v_rank_new := array_position(array['placed', 'confirmed', 'shipped', 'delivered'], new.status);
    if new.status = 'cancelled' then
      if old.status in ('shipped', 'delivered') or old.shipped_at is not null or old.delivered_at is not null then
        raise exception 'A dispatched or delivered order cannot be cancelled. A return is a separate step.'
          using errcode = '55000';
      end if;
    elsif v_undeliver then
      null; -- the audited mis-click correction, checked above
    elsif v_rank_old is null or v_rank_new is null or v_rank_new < v_rank_old then
      raise exception 'An order does not move back from % to %.', old.status, new.status
        using errcode = '55000';
    end if;
  end if;

  if old.payment_status = 'paid' and new.payment_status is distinct from 'paid' then
    raise exception 'A paid order stays paid. Money returned is recorded as a credit note and a refund, not by un-paying the order.'
      using errcode = '55000';
  end if;

  -- What was charged is history once it was paid: the invoice and the P&L are
  -- built from these columns. Not the gateway's fee and tax: they are
  -- Razorpay's cost to us, not the customer's charge, and settlement-side code
  -- may correct them later (admins cannot write them at all).
  if old.payment_status = 'paid' and (
       new.total_inr               is distinct from old.total_inr
    or new.items                   is distinct from old.items
    or new.shipping_cost_inr       is distinct from old.shipping_cost_inr
    or new.cogs_inr                is distinct from old.cogs_inr
    or new.tax                     is distinct from old.tax
    or new.coupon_code             is distinct from old.coupon_code
    or new.coupon_discount_inr     is distinct from old.coupon_discount_inr
    or new.loyalty_points_spent    is distinct from old.loyalty_points_spent
    or new.loyalty_discount_inr    is distinct from old.loyalty_discount_inr
    or new.payment_method          is distinct from old.payment_method
    or new.payment_provider        is distinct from old.payment_provider
    or new.razorpay_order_id       is distinct from old.razorpay_order_id) then
    raise exception 'The amounts, items and payment details of a paid order cannot be changed.'
      using errcode = '55000';
  end if;

  if old.invoice_number is not null and new.invoice_number is distinct from old.invoice_number
     or old.invoice_issued_at is not null and new.invoice_issued_at is distinct from old.invoice_issued_at then
    raise exception 'An issued invoice number is permanent.' using errcode = '55000';
  end if;
  -- (The corrected delivery time is not lost: order_events keeps from → to.)
  if old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at
     or old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at and not v_undeliver then
    raise exception 'When an order was cancelled or delivered is recorded once.' using errcode = '55000';
  end if;
  return new;
end
$fn$;
revoke execute on function public.orders_integrity_guard() from public, anon, authenticated, service_role;

create trigger orders_integrity_guard
  before update on public.orders
  for each row execute function public.orders_integrity_guard();

-- ── Admin column privileges ─────────────────────────────────────────────────
revoke update on table public.orders from authenticated;
grant update (admin_note, needs_review, courier_name, awb_number, courier_actual_cost_inr)
  on table public.orders to authenticated;

-- ── Stock returned for an order: its own sale, once, never after dispatch ───
create unique index stock_movements_one_cancellation_per_line
  on public.stock_movements (order_id, product_id, coalesce(size_label, ''))
  where reason = 'cancellation' and order_id is not null;

create function public.stock_movements_order_return_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  o        record;
  v_taken  bigint;
  v_back   bigint;
begin
  if new.order_id is null or new.reason not in ('cancellation', 'return') then
    return new;
  end if;
  if new.delta <= 0 then
    raise exception 'Stock returned for an order is a positive movement.' using errcode = '22023';
  end if;
  -- One decision at a time per order line, whoever calls.
  perform pg_advisory_xact_lock(hashtextextended(
    'wovenne.order_line_return:' || new.order_id::text || ':' || coalesce(new.product_id::text, '')
      || ':' || coalesce(new.size_label, ''), 0));

  select status, shipped_at, delivered_at into o from orders where id = new.order_id;
  if new.reason = 'return' and coalesce(current_setting('wovenne.return_verified', true), '') <> 'on' then
    raise exception 'Stock comes back for a returned order only after the parcel is received and checked (not available yet).'
      using errcode = '42501';
  end if;
  if new.reason = 'cancellation'
     and (o.status in ('shipped', 'delivered') or o.shipped_at is not null or o.delivered_at is not null) then
    raise exception 'Stock is not returned automatically for an order that has been dispatched.'
      using errcode = '55000';
  end if;
  -- A cancellation restock belongs to a cancellation: the order is cancelled
  -- already, or an order function is cancelling it in this transaction. Not a
  -- live order's stock put back while it is still going out (service_role can
  -- call release_stock and insert movements directly).
  if new.reason = 'cancellation' and o.status is distinct from 'cancelled'
     and coalesce(current_setting('wovenne.order_transition', true), '') <> 'on' then
    raise exception 'Stock comes back for an order only when it is cancelled.' using errcode = '55000';
  end if;

  select coalesce(-sum(delta) filter (where reason = 'sale'), 0),
         coalesce(sum(delta) filter (where reason in ('cancellation', 'return')), 0)
    into v_taken, v_back
    from stock_movements
   where order_id = new.order_id
     and product_id is not distinct from new.product_id
     and coalesce(size_label, '') = coalesce(new.size_label, '');
  if v_back + new.delta > v_taken then
    raise exception 'Only stock this order took can come back, and only once (took %, already back %, asked %).',
      v_taken, v_back, new.delta using errcode = '55000';
  end if;
  return new;
end
$fn$;
revoke execute on function public.stock_movements_order_return_guard() from public, anon, authenticated, service_role;

create trigger stock_movements_order_return_guard
  before insert on public.stock_movements
  for each row execute function public.stock_movements_order_return_guard();

-- What an order took and has not had back, per line, as release_stock lines.
create function public.order_unreturned_stock(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $fn$
  with lines as (
    select m.product_id, m.size_label,
           coalesce(-sum(m.delta) filter (where m.reason = 'sale'), 0)
             - coalesce(sum(m.delta) filter (where m.reason in ('cancellation', 'return')), 0) as qty
      from stock_movements m
     where m.order_id = p_order_id and m.product_id is not null
     group by m.product_id, m.size_label
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.product_id, 'size', l.size_label, 'quantity', l.qty,
           'name', (select x ->> 'name' from orders o, jsonb_array_elements(
                      case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) x
                     where o.id = p_order_id and x ->> 'id' = l.product_id::text limit 1))
           order by l.product_id, l.size_label), '[]'::jsonb)
    from lines l
   where l.qty > 0
$fn$;
revoke execute on function public.order_unreturned_stock(uuid) from public, anon, authenticated, service_role;

-- ── Credit notes: capped, one cancellation note, permanent ──────────────────
create unique index credit_notes_one_cancellation_per_order
  on public.credit_notes (order_id) where kind = 'cancellation';

create function public.credit_notes_integrity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  o         record;
  v_credited numeric;
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'issued_by' - 'order_id') = (to_jsonb(old) - 'issued_by' - 'order_id')
     and (new.issued_by is not distinct from old.issued_by or new.issued_by is null)
     and (new.order_id is not distinct from old.order_id or new.order_id is null) then
    -- Only what the foreign keys' ON DELETE SET NULL does when a staff account
    -- or an order row is removed; the document itself is unchanged.
    return new;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'A credit note is permanent once issued. A mistake is corrected by a further document, never by editing or deleting this one.'
      using errcode = '55000';
  end if;
  if new.order_id is null then
    raise exception 'A credit note is issued against an order.' using errcode = '22023';
  end if;
  -- The order row lock serialises every credit for this order.
  select total_inr, payment_status into o from orders where id = new.order_id for update;
  if not found then
    raise exception 'No such order.' using errcode = 'P0002';
  end if;
  if o.payment_status is distinct from 'paid' then
    raise exception 'That order was never paid, so there is nothing to credit.' using errcode = '55000';
  end if;
  select coalesce(sum(amount_inr), 0) into v_credited from credit_notes where order_id = new.order_id;
  if v_credited + new.amount_inr > o.total_inr then
    raise exception 'Credit notes for this order cannot exceed the % paid (already credited %, asked %).',
      o.total_inr, v_credited, new.amount_inr using errcode = '55000';
  end if;
  return new;
end
$fn$;
revoke execute on function public.credit_notes_integrity() from public, anon, authenticated, service_role;

create trigger credit_notes_integrity
  before insert or update or delete on public.credit_notes
  for each row execute function public.credit_notes_integrity();

-- Same signature and result. Locks the order and states the cap; the trigger
-- above is the guarantee whoever inserts.
create or replace function public.issue_credit_note(
  p_order_id uuid,
  p_kind text,
  p_amount numeric,
  p_reason text default null,
  p_items jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  target   orders%rowtype;
  number   text;
  created  credit_notes%rowtype;
  credited numeric;
begin
  if not public.is_admin() then
    raise exception 'Only admins can issue a credit note';
  end if;
  select * into target from orders where id = p_order_id for update;
  if not found then
    raise exception 'No such order';
  end if;
  if target.payment_status <> 'paid' then
    raise exception 'That order was never paid, so there is nothing to credit';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A credit note is for a positive amount';
  end if;
  select coalesce(sum(amount_inr), 0) into credited from credit_notes where order_id = p_order_id;
  if credited + p_amount > target.total_inr then
    raise exception 'Credit notes cannot exceed the % that was paid (already credited %)', target.total_inr, credited;
  end if;

  number := 'CN-' || to_char(now(), 'YYYY') || '-' ||
            lpad(nextval('credit_note_number_seq')::text, 4, '0');
  insert into credit_notes
    (credit_note_number, order_id, invoice_number, kind, amount_inr, reason, items, issued_by)
  values
    (number, p_order_id, target.invoice_number, p_kind, p_amount, p_reason, p_items, auth.uid())
  returning * into created;
  return to_jsonb(created);
end;
$fn$;
-- Only the order functions issue credit notes now (cancel_order; OS-6's
-- record_return later). service_role never could: is_admin() refuses it.
revoke execute on function public.issue_credit_note(uuid, text, numeric, text, jsonb)
  from public, anon, authenticated, service_role;

-- ── The order functions ─────────────────────────────────────────────────────
-- Inside one of them, the guard allows the status change and the audit row
-- carries the action and the reason. Both settings are transaction-local and
-- cleared straight after the update.
create function public.order_transition_begin(p_action text, p_reason text)
returns void
language sql
set search_path = public, pg_temp
as $fn$
  select set_config('wovenne.order_transition', 'on', true),
         set_config('wovenne.order_action', p_action, true),
         set_config('wovenne.order_reason', coalesce(p_reason, ''), true);
$fn$;
create function public.order_transition_end()
returns void
language sql
set search_path = public, pg_temp
as $fn$
  select set_config('wovenne.order_transition', '', true),
         set_config('wovenne.order_action', '', true),
         set_config('wovenne.order_reason', '', true);
$fn$;
revoke execute on function public.order_transition_begin(text, text) from public, anon, authenticated, service_role;
revoke execute on function public.order_transition_end() from public, anon, authenticated, service_role;

-- Stock an order took and has not had back, returned once. Internal. The
-- movements it writes carry who returned them and why (release_stock leaves
-- actor and note empty).
create function public.order_return_unreturned_stock(p_order_id uuid, p_note text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_lines    jsonb := public.order_unreturned_stock(p_order_id);
  v_taken    boolean;
  v_released jsonb;
  v_missing  jsonb := '[]'::jsonb;
begin
  select exists (select 1 from stock_movements where order_id = p_order_id and reason = 'sale') into v_taken;
  if jsonb_array_length(v_lines) > 0 then
    v_released := public.release_stock(v_lines, p_order_id, 'cancellation');
    v_missing := coalesce(v_released -> 'unreturned', '[]'::jsonb);
    -- At most one cancellation movement per line ever exists (unique index),
    -- so the untagged ones written in this transaction are these.
    update stock_movements
       set actor_id = auth.uid(), note = p_note
     where order_id = p_order_id and reason = 'cancellation'
       and created_at = now() and actor_id is null and note is null;
  end if;
  return jsonb_build_object(
    'stock_taken', v_taken,
    'lines', jsonb_array_length(v_lines),
    'released', coalesce((v_released ->> 'released')::int, 0),
    'stock_returned', v_taken and jsonb_array_length(v_lines) > 0 and jsonb_array_length(v_missing) = 0,
    'stock_unreturned', v_missing,
    'stock_note', case
      when not v_taken then
        'No stock was returned: this order never decremented stock, so putting it back would have created inventory that never existed.'
      when jsonb_array_length(v_lines) = 0 then
        'No stock was returned: everything this order took has already been put back.'
      when jsonb_array_length(v_missing) > 0 then
        format('Stock was not returned for %s line(s): %s. Each no longer matches a live product or size, so nothing was added and nothing was logged. Check the shelf and adjust the count by hand.',
               jsonb_array_length(v_missing),
               (select string_agg(coalesce(m ->> 'name', m ->> 'id')
                                  || coalesce(' (' || nullif(m ->> 'size', '') || ')', ''), ', ')
                  from jsonb_array_elements(v_missing) m))
      else null
    end);
end
$fn$;
revoke execute on function public.order_return_unreturned_stock(uuid, text) from public, anon, authenticated, service_role;

-- Confirm, mark shipped (only before 0075 exists) or mark delivered.
create function public.admin_set_order_status(p_order_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  o orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  if p_status = 'cancelled' then
    raise exception 'Cancel through cancel_unpaid_order or cancel_order, which handle the stock and the credit note.'
      using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('confirmed', 'shipped', 'delivered') then
    raise exception 'Unknown order status: %', coalesce(p_status, 'none') using errcode = '22023';
  end if;

  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'That order does not exist.' using errcode = 'P0002';
  end if;
  if o.status = p_status then
    return jsonb_build_object('outcome', 'unchanged', 'status', o.status);
  end if;
  if o.status = 'cancelled' then
    raise exception 'A cancelled order cannot be reopened. Record a new order instead (it can reference this one).'
      using errcode = '55000';
  end if;
  if o.payment_status is distinct from 'paid' then
    raise exception 'Only a paid order moves on from placed.' using errcode = '55000';
  end if;

  if p_status = 'confirmed' then
    if o.status <> 'placed' then
      raise exception 'Only a placed order can be confirmed.' using errcode = '55000';
    end if;
  elsif p_status = 'shipped' then
    if to_regprocedure('public.dispatch_order(uuid, text, text, boolean, boolean)') is not null then
      raise exception 'Mark an order shipped by dispatching it (dispatch_order), which records the consignment and emails the customer once.'
        using errcode = '55000';
    end if;
    if o.status not in ('placed', 'confirmed') then
      raise exception 'This order cannot be shipped from %.', o.status using errcode = '55000';
    end if;
    if o.needs_review then
      raise exception 'This order is flagged for review; clear the flag before shipping it.' using errcode = '55000';
    end if;
    if nullif(btrim(coalesce(o.awb_number, '')), '') is null then
      raise exception 'Save the tracking number before marking the order shipped.' using errcode = '55000';
    end if;
  else -- delivered
    if o.status = 'shipped' then
      null;
    elsif o.status in ('placed', 'confirmed') and o.payment_provider = 'offline' then
      null; -- handed over in person (only an order recorded in person: a legacy
            -- row with no provider is online, as 0044 reads it)
    else
      raise exception 'An online order is marked delivered only after it has been dispatched.' using errcode = '55000';
    end if;
  end if;

  perform public.order_transition_begin('admin_set_order_status', p_reason);
  update orders
     set status       = p_status,
         shipped_at   = case when p_status = 'shipped' then coalesce(shipped_at, now()) else shipped_at end,
         delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end
   where id = o.id;
  perform public.order_transition_end();
  return jsonb_build_object('outcome', 'changed', 'from', o.status, 'status', p_status);
end
$fn$;
revoke execute on function public.admin_set_order_status(uuid, text, text) from public, anon, service_role;
grant execute on function public.admin_set_order_status(uuid, text, text) to authenticated;

-- An order that was never paid. No credit note (there is no invoice); any stock
-- it took (an interrupted old-style settlement) comes back once.
create function public.cancel_unpaid_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  o       orders%rowtype;
  v_stock jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'That order does not exist.' using errcode = 'P0002';
  end if;
  if o.status = 'cancelled' then
    raise exception 'That order is already cancelled' using errcode = '55000';
  end if;
  if o.payment_status = 'paid' then
    raise exception 'That order is paid: cancel it with cancel_order, which issues the credit note.'
      using errcode = '55000';
  end if;
  if o.status in ('shipped', 'delivered') or o.shipped_at is not null or o.delivered_at is not null then
    raise exception 'A dispatched or delivered order cannot be cancelled. A return is a separate step.'
      using errcode = '55000';
  end if;

  perform public.order_transition_begin('cancel_unpaid_order', p_reason);
  v_stock := public.order_return_unreturned_stock(o.id, 'cancel_unpaid_order: ' || coalesce(nullif(btrim(p_reason), ''), 'no reason given'));
  update orders set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()) where id = o.id;
  perform public.order_transition_end();
  return jsonb_build_object('outcome', 'cancelled') || v_stock;
end
$fn$;
revoke execute on function public.cancel_unpaid_order(uuid, text) from public, anon, service_role;
grant execute on function public.cancel_unpaid_order(uuid, text) to authenticated;

-- A paid order before dispatch. Same signature and result keys as 0060.
--   * refused once dispatched or delivered (D1);
--   * stock: only what this order's sale took and has not had back (D1, D2);
--   * the credit note is for what is still creditable (D3);
--   * an order already cancelled WITHOUT its cancellation credit note (the
--     old bypass button, as on 9 Aug 2026) is completed in place — the note and
--     any stock still out — instead of being re-opened. One with its note is
--     refused as before.
create or replace function public.cancel_order(
  p_order_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  target      orders%rowtype;
  v_completing boolean := false;
  v_stock     jsonb;
  v_credited  numeric;
  note        jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can cancel an order';
  end if;

  select * into target from orders where id = p_order_id for update;
  if not found then
    raise exception 'No such order';
  end if;
  if target.status = 'cancelled' then
    if target.payment_status <> 'paid'
       or exists (select 1 from credit_notes where order_id = p_order_id and kind = 'cancellation') then
      raise exception 'That order is already cancelled';
    end if;
    v_completing := true;
  end if;
  if target.status in ('shipped', 'delivered') or target.shipped_at is not null or target.delivered_at is not null then
    raise exception 'A dispatched or delivered order cannot be cancelled. A return is a separate step.'
      using errcode = '55000';
  end if;
  if target.payment_status <> 'paid' then
    raise exception 'That order was never paid, so there is nothing to cancel';
  end if;

  perform public.order_transition_begin('cancel_order', p_reason);
  if target.payment_provider = 'offline' then
    -- In person, "confirmed" can mean the customer walked out with the piece:
    -- nothing records a handover at the counter. Putting stock back on that
    -- assumption could invent inventory, so it waits for an admin to say the
    -- piece is on the shelf (admin_return_in_person_stock) — O-6.
    v_stock := jsonb_build_object(
      'stock_returned', false,
      'stock_unreturned', '[]'::jsonb,
      'stock_note', case when exists (select 1 from stock_movements where order_id = p_order_id and reason = 'sale')
        then 'In-person order: the stock was NOT put back, because nothing records whether the piece was handed over. If it is back on the shelf, use "Back on the shelf" on this cancelled order.'
        else null end);
  else
    v_stock := public.order_return_unreturned_stock(p_order_id, 'cancel_order: ' || coalesce(nullif(btrim(p_reason), ''), 'no reason given'));
  end if;

  select coalesce(sum(amount_inr), 0) into v_credited from credit_notes where order_id = p_order_id;
  if target.total_inr - v_credited > 0 then
    note := public.issue_credit_note(
      p_order_id,
      'cancellation',
      target.total_inr - v_credited,
      coalesce(p_reason, 'Order cancelled'),
      target.items
    );
  end if;

  if not v_completing then
    update orders
       set status = 'cancelled',
           cancelled_at = coalesce(cancelled_at, now())
     where id = p_order_id;
  end if;
  perform public.order_transition_end();

  return jsonb_build_object(
    'credit_note', note,
    'completed_existing_cancellation', v_completing,
    'stock_returned', coalesce((v_stock ->> 'stock_returned')::boolean, false),
    'stock_unreturned', coalesce(v_stock -> 'stock_unreturned', '[]'::jsonb),
    'stock_note', v_stock ->> 'stock_note'
  );
end;
$fn$;
revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant execute on function public.cancel_order(uuid, text) to authenticated, service_role;

-- ── Corrections: narrow, audited, a reason every time (O-2, O-6, O-7) ───────
-- None of them touches an amount, a payment, an invoice number or a credit
-- note, and none re-opens a cancelled order.

create function public.order_correction_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'Say why, in a few words (at least 10 characters): a correction is kept with its reason.'
      using errcode = '22023';
  end if;
  return left(btrim(p_reason), 500);
end
$fn$;
revoke execute on function public.order_correction_reason(text) from public, anon, authenticated, service_role;

-- O-2: "Mark delivered" pressed by mistake on a dispatched order. It moves back
-- to shipped and its delivery time is cleared (order_events keeps the old one).
-- Nothing else: no stock, no credit note, no payment. An order handed over in
-- person (never dispatched) is not undone here — that would make it look
-- cancellable with the goods possibly gone (O-6).
create function public.admin_correct_order_status(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  o        orders%rowtype;
  v_reason text;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  v_reason := public.order_correction_reason(p_reason);
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'That order does not exist.' using errcode = 'P0002';
  end if;
  if o.status <> 'delivered' then
    raise exception 'Only an order marked delivered can be corrected back to dispatched.' using errcode = '55000';
  end if;
  if o.shipped_at is null then
    raise exception 'This order was handed over in person, not dispatched, so there is no dispatched state to go back to.'
      using errcode = '55000';
  end if;

  perform public.order_transition_begin('admin_correct_order_status', v_reason);
  perform set_config('wovenne.order_correction', 'undeliver', true);
  update orders set status = 'shipped', delivered_at = null where id = o.id;
  perform set_config('wovenne.order_correction', '', true);
  perform public.order_transition_end();
  return jsonb_build_object('outcome', 'corrected', 'from', 'delivered', 'status', 'shipped',
                            'delivered_at_was', o.delivered_at);
end
$fn$;
revoke execute on function public.admin_correct_order_status(uuid, text) from public, anon, service_role;
grant execute on function public.admin_correct_order_status(uuid, text) to authenticated;

-- O-7: what an admin corrected in a customer's contact details, and what it
-- replaced. Admins read it; nothing writes it but admin_correct_order_contact,
-- and when the customer's details are erased from the order (account
-- deletion) the values here are erased too.
create table public.order_contact_corrections (
  id            bigint generated always as identity primary key,
  order_id      uuid not null references public.orders(id) on delete cascade,
  corrected_at  timestamptz not null default now(),
  actor_id      uuid,
  actor_email   text,
  reason        text not null,
  before        jsonb not null,
  after         jsonb not null,
  redacted_at   timestamptz
);
comment on table public.order_contact_corrections is
  'Pre-dispatch corrections of an order''s name, phone or delivery address
   (0078): who, when, why, and the values before and after. The invoice
   number, amounts and items are never touched; the as-issued contact details
   are kept here. Redacted when the order''s contact details are erased.';
create index order_contact_corrections_order_idx on public.order_contact_corrections (order_id, corrected_at);
alter table public.order_contact_corrections enable row level security;
create policy "Admins read contact corrections"
  on public.order_contact_corrections for select to authenticated using (public.is_admin());
revoke all on table public.order_contact_corrections from public, anon, authenticated, service_role;
grant select on table public.order_contact_corrections to authenticated, service_role;
revoke all on sequence public.order_contact_corrections_id_seq from public, anon, authenticated, service_role;

-- Name, phone and delivery address, before dispatch. Null = leave as is.
--   * never the email: it is who the order belongs to and where its invoice
--     and emails go (and how account deletion finds it);
--   * never the state or country: the delivery charge was quoted for them and
--     is frozen once paid, and the state will decide the GST place of supply;
--   * the PIN code may change within the same state; the delivery charge is
--     NOT re-quoted (it is history once paid, O-3).
create function public.admin_correct_order_contact(
  p_order_id uuid,
  p_name     text,
  p_phone    text,
  p_address  jsonb,
  p_reason   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  o         orders%rowtype;
  v_reason  text;
  v_name    text;
  v_phone   text;
  v_addr    jsonb;
  v_before  jsonb := '{}'::jsonb;
  v_after   jsonb := '{}'::jsonb;
  v_email   text;
  k         text;
  v_allowed constant text[] := array['line1', 'line2', 'city', 'state', 'postal_code', 'country'];
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  v_reason := public.order_correction_reason(p_reason);
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'That order does not exist.' using errcode = 'P0002';
  end if;
  if o.status = 'cancelled' then
    raise exception 'A cancelled order''s details are not corrected.' using errcode = '55000';
  end if;
  if o.status in ('shipped', 'delivered') or o.shipped_at is not null or o.delivered_at is not null then
    raise exception 'Delivery details are corrected only before dispatch. After that, the consignment already carries the address.'
      using errcode = '55000';
  end if;

  if p_name is not null then
    v_name := btrim(p_name);
    if v_name = '' or length(v_name) > 120 then
      raise exception 'A name is 1 to 120 characters.' using errcode = '22023';
    end if;
    if v_name is distinct from o.customer_name then
      v_before := v_before || jsonb_build_object('customer_name', o.customer_name);
      v_after  := v_after  || jsonb_build_object('customer_name', v_name);
    end if;
  end if;

  if p_phone is not null then
    v_phone := btrim(p_phone);
    if v_phone !~ '^\+?[0-9][0-9 -]{6,30}$' then
      raise exception 'A phone number is digits, spaces or dashes, with an optional leading +.' using errcode = '22023';
    end if;
    if v_phone is distinct from o.customer_phone then
      v_before := v_before || jsonb_build_object('customer_phone', o.customer_phone);
      v_after  := v_after  || jsonb_build_object('customer_phone', v_phone);
    end if;
  end if;

  if p_address is not null then
    if jsonb_typeof(p_address) <> 'object' then
      raise exception 'The address is an object of line1, line2, city, state, postal_code, country.' using errcode = '22023';
    end if;
    for k in select jsonb_object_keys(p_address) loop
      if not (k = any (v_allowed)) or jsonb_typeof(p_address -> k) <> 'string' then
        raise exception 'Unexpected address field: %', k using errcode = '22023';
      end if;
    end loop;
    -- The stored address with the given fields replaced, each trimmed.
    v_addr := coalesce(o.shipping_address, '{}'::jsonb);
    for k in select jsonb_object_keys(p_address) loop
      v_addr := v_addr || jsonb_build_object(k, btrim(p_address ->> k));
    end loop;
    if lower(btrim(coalesce(v_addr ->> 'state', ''))) is distinct from lower(btrim(coalesce(o.shipping_address ->> 'state', '')))
       or lower(btrim(coalesce(v_addr ->> 'country', ''))) is distinct from lower(btrim(coalesce(o.shipping_address ->> 'country', ''))) then
      raise exception 'The state and country cannot be corrected here: the delivery charge and tax were worked out for them. Cancel and record a new order instead.'
        using errcode = '55000';
    end if;
    if coalesce(v_addr ->> 'line1', '') = '' or coalesce(v_addr ->> 'city', '') = ''
       or length(coalesce(v_addr ->> 'line1', '')) > 200 or length(coalesce(v_addr ->> 'line2', '')) > 200
       or length(coalesce(v_addr ->> 'city', '')) > 100 then
      raise exception 'An address needs a first line and a city (lines up to 200 characters, city up to 100).' using errcode = '22023';
    end if;
    if p_address ? 'postal_code'
       and lower(btrim(coalesce(v_addr ->> 'country', 'india'))) in ('india', '')
       and regexp_replace(coalesce(v_addr ->> 'postal_code', ''), '\D', '', 'g') !~ '^[1-9][0-9]{5}$' then
      raise exception 'An Indian PIN code is six digits.' using errcode = '22023';
    end if;
    if v_addr is distinct from o.shipping_address then
      v_before := v_before || jsonb_build_object('shipping_address', o.shipping_address);
      v_after  := v_after  || jsonb_build_object('shipping_address', v_addr);
    end if;
  end if;

  if v_after = '{}'::jsonb then
    return jsonb_build_object('outcome', 'unchanged');
  end if;

  if auth.uid() is not null then
    select p.email into v_email from profiles p where p.id = auth.uid();
  end if;
  insert into order_contact_corrections (order_id, actor_id, actor_email, reason, before, after)
  values (o.id, auth.uid(), v_email, v_reason, v_before, v_after);

  perform public.order_transition_begin('admin_correct_order_contact', v_reason);
  update orders
     set customer_name    = case when v_after ? 'customer_name' then v_after ->> 'customer_name' else customer_name end,
         customer_phone   = case when v_after ? 'customer_phone' then v_after ->> 'customer_phone' else customer_phone end,
         shipping_address = case when v_after ? 'shipping_address' then v_after -> 'shipping_address' else shipping_address end
   where id = o.id;
  perform public.order_transition_end();
  return jsonb_build_object('outcome', 'corrected', 'fields', (select jsonb_agg(x order by x) from jsonb_object_keys(v_after) x));
end
$fn$;
revoke execute on function public.admin_correct_order_contact(uuid, text, text, jsonb, text) from public, anon, service_role;
grant execute on function public.admin_correct_order_contact(uuid, text, text, jsonb, text) to authenticated;

-- When an order's contact details are erased (delete_my_account nulls all
-- four), the corrections ledger forgets them too. The fact of the correction,
-- who made it and why stay.
create function public.order_contact_corrections_redact()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  update order_contact_corrections
     set before = jsonb_build_object('redacted', true),
         after  = jsonb_build_object('redacted', true),
         redacted_at = now()
   where order_id = new.id and redacted_at is null;
  return new;
end
$fn$;
revoke execute on function public.order_contact_corrections_redact() from public, anon, authenticated, service_role;

create trigger orders_contact_redaction
  after update of customer_email, customer_name, customer_phone, shipping_address on public.orders
  for each row
  when (new.customer_email is null and new.customer_name is null and new.customer_phone is null
        and new.shipping_address is null)
  execute function public.order_contact_corrections_redact();

-- O-6: an in-person order was cancelled without a restock (cancel_order above).
-- The admin states the piece is physically back on the shelf; this returns what
-- the sale took and has not had back, once per line, with the admin and the
-- statement on each stock movement.
create function public.admin_return_in_person_stock(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  o        orders%rowtype;
  v_reason text;
  v_stock  jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  v_reason := public.order_correction_reason(p_reason);
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'That order does not exist.' using errcode = 'P0002';
  end if;
  if o.payment_provider is distinct from 'offline' then
    raise exception 'Only an in-person order is restocked this way; an online order''s stock comes back when it is cancelled.'
      using errcode = '55000';
  end if;
  if o.status <> 'cancelled' then
    raise exception 'Cancel the order first (with its credit note); then put the piece back on the shelf here.'
      using errcode = '55000';
  end if;
  if o.shipped_at is not null or o.delivered_at is not null then
    raise exception 'This order was dispatched or handed over; stock comes back only through a checked return (not available yet).'
      using errcode = '55000';
  end if;

  perform public.order_transition_begin('admin_return_in_person_stock', v_reason);
  v_stock := public.order_return_unreturned_stock(o.id, 'In-person cancellation, piece confirmed back on the shelf: ' || v_reason);
  perform public.order_transition_end();
  return jsonb_build_object('outcome', case when (v_stock ->> 'lines')::int = 0 then 'nothing_to_return' else 'returned' end) || v_stock;
end
$fn$;
revoke execute on function public.admin_return_in_person_stock(uuid, text) from public, anon, service_role;
grant execute on function public.admin_return_in_person_stock(uuid, text) to authenticated;

comment on function public.admin_set_order_status(uuid, text, text) is
  'Confirm (placed → confirmed), mark shipped (only where dispatch_order does
   not exist), or mark delivered (after shipping, or in person for an order not
   paid online). Two-factor admins only; paid orders only; audited (0078).';
comment on function public.cancel_unpaid_order(uuid, text) is
  'Cancel an order that was never paid and never dispatched. No credit note;
   any stock it took comes back once. Two-factor admins only (0078).';
comment on function public.cancel_order(uuid, text) is
  'Cancel a paid order before dispatch: the stock its sale took comes back
   once, a credit note for what is still creditable, status cancelled. Refuses
   dispatched and delivered orders. Completes an already-cancelled paid order
   that has no cancellation credit note, without re-opening it. An in-person
   order is not restocked here (admin_return_in_person_stock) (0078).';
comment on function public.admin_correct_order_status(uuid, text) is
  'Correct a mistaken "delivered" on a dispatched order back to shipped, with
   a reason. No stock, credit note or payment moves. Two-factor admins (0078).';
comment on function public.admin_correct_order_contact(uuid, text, text, jsonb, text) is
  'Correct the name, phone or delivery address before dispatch, with a reason;
   never the email, state or country. The values replaced are kept in
   order_contact_corrections. Two-factor admins (0078).';
comment on function public.admin_return_in_person_stock(uuid, text) is
  'Return the stock of a cancelled in-person order once an admin states the
   piece is back on the shelf; once per line, signed. Two-factor admins (0078).';

-- ── Self-check ──────────────────────────────────────────────────────────────
do $$
declare
  problems text[] := array[]::text[];
  f regprocedure;
begin
  if has_table_privilege('authenticated', 'public.orders', 'UPDATE') then
    problems := problems || 'authenticated still has table-wide UPDATE on orders'::text;
  end if;
  if has_column_privilege('authenticated', 'public.orders', 'status', 'UPDATE')
     or has_column_privilege('authenticated', 'public.orders', 'payment_status', 'UPDATE')
     or has_column_privilege('authenticated', 'public.orders', 'total_inr', 'UPDATE')
     or has_column_privilege('authenticated', 'public.orders', 'shipping_cost_inr', 'UPDATE')
     or has_column_privilege('authenticated', 'public.orders', 'items', 'UPDATE') then
    problems := problems || 'authenticated can still update a protected order column'::text;
  end if;
  if not has_column_privilege('authenticated', 'public.orders', 'admin_note', 'UPDATE') then
    problems := problems || 'authenticated lost UPDATE on admin_note'::text;
  end if;
  if has_function_privilege('authenticated', 'public.issue_credit_note(uuid, text, numeric, text, jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.issue_credit_note(uuid, text, numeric, text, jsonb)', 'EXECUTE') then
    problems := problems || 'issue_credit_note is still directly callable'::text;
  end if;
  foreach f in array array['public.admin_set_order_status(uuid, text, text)'::regprocedure,
                           'public.admin_correct_order_status(uuid, text)'::regprocedure,
                           'public.admin_correct_order_contact(uuid, text, text, jsonb, text)'::regprocedure,
                           'public.admin_return_in_person_stock(uuid, text)'::regprocedure,
                           'public.cancel_unpaid_order(uuid, text)'::regprocedure,
                           'public.cancel_order(uuid, text)'::regprocedure] loop
    if has_function_privilege('anon', f, 'EXECUTE') then
      problems := problems || format('anon can execute %s', f);
    end if;
    if f <> 'public.cancel_order(uuid, text)'::regprocedure and has_function_privilege('service_role', f, 'EXECUTE') then
      problems := problems || format('service_role can execute %s', f);
    end if;
    if not (select prosecdef and coalesce(proconfig, '{}') @> array['search_path=public, pg_temp'] from pg_proc where oid = f) then
      problems := problems || format('%s is not SECURITY DEFINER with a pinned search_path', f);
    end if;
  end loop;
  foreach f in array array['public.orders_audit()'::regprocedure, 'public.orders_integrity_guard()'::regprocedure,
                           'public.stock_movements_order_return_guard()'::regprocedure,
                           'public.credit_notes_integrity()'::regprocedure,
                           'public.order_unreturned_stock(uuid)'::regprocedure,
                           'public.order_return_unreturned_stock(uuid, text)'::regprocedure,
                           'public.order_correction_reason(text)'::regprocedure,
                           'public.order_contact_corrections_redact()'::regprocedure,
                           'public.order_transition_begin(text, text)'::regprocedure,
                           'public.order_transition_end()'::regprocedure] loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE')
       or has_function_privilege('service_role', f, 'EXECUTE') then
      problems := problems || format('%s is callable by an API role', f);
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.order_events', 'INSERT')
     or has_table_privilege('service_role', 'public.order_events', 'INSERT')
     or has_table_privilege('service_role', 'public.order_events', 'UPDATE')
     or has_table_privilege('service_role', 'public.order_events', 'DELETE') then
    problems := problems || 'order_events is writable by an API role'::text;
  end if;
  if has_table_privilege('anon', 'public.order_contact_corrections', 'SELECT')
     or has_table_privilege('authenticated', 'public.order_contact_corrections', 'INSERT')
     or has_table_privilege('authenticated', 'public.order_contact_corrections', 'UPDATE')
     or has_table_privilege('authenticated', 'public.order_contact_corrections', 'DELETE')
     or has_table_privilege('service_role', 'public.order_contact_corrections', 'INSERT')
     or has_table_privilege('service_role', 'public.order_contact_corrections', 'UPDATE')
     or has_table_privilege('service_role', 'public.order_contact_corrections', 'DELETE') then
    problems := problems || 'order_contact_corrections is writable or public'::text;
  end if;
  if (select count(*) from pg_trigger
       where not tgisinternal and tgenabled = 'O'
         and (tgrelid, tgname) in (('public.orders'::regclass, 'orders_audit'),
                                   ('public.orders'::regclass, 'orders_integrity_guard'),
                                   ('public.stock_movements'::regclass, 'stock_movements_order_return_guard'),
                                   ('public.credit_notes'::regclass, 'credit_notes_integrity'),
                                   ('public.orders'::regclass, 'orders_contact_redaction'))) <> 5 then
    problems := problems || 'a 0078 trigger is missing or disabled'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0078_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

select
  (select count(*) from order_events) as order_events,
  (select count(*) from pg_trigger where tgname in ('orders_audit', 'orders_integrity_guard',
     'stock_movements_order_return_guard', 'credit_notes_integrity', 'orders_contact_redaction')) as triggers;
