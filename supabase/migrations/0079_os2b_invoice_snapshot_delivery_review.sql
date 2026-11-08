-- 0079 — OS-2b (WP-ORDER-SAFETY-08): an issued invoice keeps what it said
-- (D-1), and a corrected delivery PIN is reviewed before dispatch (D-2).
--
-- WHAT WAS WRONG (WP-ORDER-SAFETY-07, reproduced on 0001–0078):
--   D-1  Invoices and credit notes were rendered from the LIVE order row. 0078's
--        admin_correct_order_contact (and account deletion, 0033) change that
--        row, so every later reprint, resend and credit note of an invoice that
--        was already issued printed the new details. Nothing kept the original.
--   D-2  A corrected PIN was accepted with no serviceability check and nothing
--        held the order for a person to look at before dispatch. The delivery
--        charge follows the PIN prefix while 0078's lock compares the free-text
--        state, so a Kerala ₹99 order could be corrected to a Bengaluru PIN and
--        dispatched with nobody noticing.
--
-- WHAT THIS DOES
--   D-1  order_invoice_snapshots: written ONCE, by a trigger on the same UPDATE
--        that assigns the invoice number (0037's assign_invoice_number, not
--        redefined), so issue and snapshot commit or fail together. It holds
--        every invoice input the database owns: number, issue time, order date,
--        name, email, phone, delivery address, items, every amount, payment
--        provider / method / status / reference, and the tax array.
--          * Immutable. No API role can write it; a guard refuses every UPDATE
--            and DELETE, even the owner's, except the one sealing step below.
--          * source says what it is: at_issue (captured at issue),
--            reconstructed (0078 corrections made after issue reversed during
--            this migration), row_at_migration (the row as found — NOT proven
--            to be what was issued: before 0078 admins could edit it unaudited).
--          * Account deletion (0033) does NOT erase it. The personal fields are
--            moved, unchanged, into order_invoice_sealed_parties — no API role
--            can read that table — and the readable snapshot keeps the number
--            and figures with the personal fields null. Ordinary prints after a
--            deletion therefore look exactly as they did before this migration
--            (no name or address), while the original evidence is retained
--            under restriction until a retention rule is confirmed by a CA.
--   D-2  orders.delivery_hold + order_delivery_reviews:
--          * A PIN change on an order not yet dispatched opens a review and sets
--            delivery_hold = 'review_pending'. Once an order has had a review,
--            ANY later address change opens a new one, so an earlier approval
--            is never reused for a different address.
--          * The only hard refusal is a PIN that is not six digits starting 1–9
--            (it cannot be an Indian PIN). Everything else — including a PIN on
--            the admin's "we don't deliver here" list, which is not authoritative
--            (see WP-08 report) — is held for review, with the list match shown.
--          * An order on hold cannot move to shipped or delivered by any path.
--          * admin_decide_delivery_review approves or refuses, recording the
--            verified PIN, state and city, the serviceability decision and its
--            source, the delivery charged vs the published rate for the new PIN,
--            the expected courier cost, and a reason. Approval clears the hold;
--            refusal keeps it ('refused') until the address is corrected again
--            or the order is cancelled. A State different from the order's is
--            never approvable (place of supply and charge were set for it).
--          * The charge already paid is never re-quoted.
--          * Opening and clearing the hold change orders.delivery_hold, so
--            0078's orders_audit records both in order_events with the action
--            and reason. The review rows are immutable once decided.
--
-- WHAT THIS DOES NOT DO
--   No new invoice number or document on a correction. No change to the
--   numbering (0037/0043), to 0078's functions, or to Invoice V2 (off). No
--   courier integration. No purge of sealed records (needs the CA's retention
--   rule). Seller identity and GST registration are code constants
--   (lib/invoice.ts BUSINESS); see the WP-08 report.
--
-- COMPATIBILITY
--   Requires 0078. Works with or without 0074–0076. Apply BEFORE the code that
--   embeds order_invoice_snapshots (new code on an old database fails to load
--   invoices); old code on this database keeps working (it prints the live
--   row) and the hold still blocks dispatch. Rollback: proposed only, see
--   reports/order-safety/wp-order-safety-08-*/proposed/.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

do $pre$
begin
  if to_regprocedure('public.admin_correct_order_contact(uuid, text, text, jsonb, text)') is null
     or to_regclass('public.order_contact_corrections') is null
     or to_regclass('public.order_events') is null
     or to_regprocedure('public.order_correction_reason(text)') is null
     or to_regprocedure('public.order_transition_begin(text, text)') is null then
    raise exception '0079 needs 0078 (order_contact_corrections, order_events, the correction helpers) first.';
  end if;
  if to_regclass('public.order_invoice_snapshots') is not null
     or to_regclass('public.order_delivery_reviews') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'orders' and column_name = 'delivery_hold') then
    raise exception '0079 is already applied.';
  end if;
end
$pre$;

-- ══ D-1: the invoice as issued ══════════════════════════════════════════════

create table public.order_invoice_snapshots (
  order_id          uuid primary key references public.orders(id),
  invoice_number    text not null unique,
  invoice_issued_at timestamptz,
  order_created_at  timestamptz,
  customer_name     text,
  customer_email    text,
  customer_phone    text,
  delivery_address  jsonb,
  -- Every non-personal invoice input, as it stood: items, total_inr,
  -- shipping_cost_inr, coupon_code, coupon_discount_inr, loyalty_discount_inr,
  -- loyalty_points_spent, payment_provider, payment_method, payment_status,
  -- razorpay_order_id, tax.
  document          jsonb not null,
  source            text not null check (source in ('at_issue', 'reconstructed', 'row_at_migration')),
  provenance_note   text,
  captured_at       timestamptz not null default now(),
  sealed_at         timestamptz
);
comment on table public.order_invoice_snapshots is
  'What an invoice was issued with (OS-2b, 0079): written once when the invoice
   number is assigned, never rewritten. source: at_issue | reconstructed (0078
   corrections reversed at migration) | row_at_migration (the row as found, not
   proven to be as issued). sealed_at: the customer''s account was deleted; the
   personal fields were moved unchanged to order_invoice_sealed_parties
   (restricted) and are null here.';

-- Retained personal details of a deleted customer's invoices. No API role has
-- any privilege; RLS on with no policy. Read only by the database owner, under
-- the procedure in the WP-08 retention design, until a CA confirms the rule.
create table public.order_invoice_sealed_parties (
  order_id         uuid primary key references public.order_invoice_snapshots(order_id),
  invoice_number   text not null,
  customer_name    text,
  customer_email   text,
  customer_phone   text,
  delivery_address jsonb,
  sealed_at        timestamptz not null default now(),
  basis            text not null
);
comment on table public.order_invoice_sealed_parties is
  'Restricted (OS-2b, 0079): the issued name, email, phone and address of an
   invoice whose customer deleted their account. Retained as financial-record
   evidence pending a CA-confirmed retention period; no API access. Never
   updated or deleted by the app.';

alter table public.order_invoice_snapshots enable row level security;
alter table public.order_invoice_sealed_parties enable row level security;
-- Readable exactly when the order is (the subquery runs under the caller's
-- own orders policies: 0003 admins, 0023 customers by email).
create policy "Read with the order"
  on public.order_invoice_snapshots for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));
revoke all on table public.order_invoice_snapshots from public, anon, authenticated, service_role;
revoke all on table public.order_invoice_sealed_parties from public, anon, authenticated, service_role;
grant select on table public.order_invoice_snapshots to authenticated, service_role;

create function public.order_invoice_snapshots_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  s order_invoice_sealed_parties%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'An issued invoice''s record is kept.' using errcode = '55000';
  end if;
  -- The one change ever made: sealing. Every personal field goes to null, and
  -- only after the same values are in the restricted store.
  if new.order_id is distinct from old.order_id or new.invoice_number is distinct from old.invoice_number
     or new.invoice_issued_at is distinct from old.invoice_issued_at
     or new.order_created_at is distinct from old.order_created_at
     or new.document is distinct from old.document or new.source is distinct from old.source
     or new.provenance_note is distinct from old.provenance_note
     or new.captured_at is distinct from old.captured_at
     or not (old.sealed_at is null and new.sealed_at is not null
             and new.customer_name is null and new.customer_email is null
             and new.customer_phone is null and new.delivery_address is null) then
    raise exception 'The details an invoice was issued with do not change.' using errcode = '55000';
  end if;
  select * into s from order_invoice_sealed_parties where order_id = old.order_id;
  if not found
     or s.customer_name is distinct from old.customer_name or s.customer_email is distinct from old.customer_email
     or s.customer_phone is distinct from old.customer_phone or s.delivery_address is distinct from old.delivery_address then
    raise exception 'An invoice record is sealed only after its details are retained.' using errcode = '55000';
  end if;
  return new;
end
$fn$;
revoke execute on function public.order_invoice_snapshots_guard() from public, anon, authenticated, service_role;
create trigger order_invoice_snapshots_guard
  before update or delete on public.order_invoice_snapshots
  for each row execute function public.order_invoice_snapshots_guard();

create function public.order_invoice_sealed_parties_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'Retained invoice details are not changed or removed by the application.' using errcode = '55000';
end
$fn$;
revoke execute on function public.order_invoice_sealed_parties_guard() from public, anon, authenticated, service_role;
create trigger order_invoice_sealed_parties_guard
  before update or delete on public.order_invoice_sealed_parties
  for each row execute function public.order_invoice_sealed_parties_guard();

-- The non-personal invoice inputs of an order row.
create function public.order_invoice_document(o public.orders)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'items', o.items, 'total_inr', o.total_inr, 'shipping_cost_inr', o.shipping_cost_inr,
    'coupon_code', o.coupon_code, 'coupon_discount_inr', o.coupon_discount_inr,
    'loyalty_discount_inr', o.loyalty_discount_inr, 'loyalty_points_spent', o.loyalty_points_spent,
    'payment_provider', o.payment_provider, 'payment_method', o.payment_method,
    'payment_status', o.payment_status, 'razorpay_order_id', o.razorpay_order_id, 'tax', o.tax);
$fn$;
revoke execute on function public.order_invoice_document(public.orders) from public, anon, authenticated, service_role;

-- Capture: AFTER the UPDATE (or INSERT) that sets the number, in the same
-- statement — an error here undoes the number too.
create function public.order_invoice_snapshot_capture()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' and old.invoice_number is not null then
    return new;  -- already issued (0078 keeps the number permanent)
  end if;
  insert into order_invoice_snapshots (order_id, invoice_number, invoice_issued_at, order_created_at,
                                       customer_name, customer_email, customer_phone, delivery_address,
                                       document, source)
  values (new.id, new.invoice_number, new.invoice_issued_at, new.created_at,
          new.customer_name, new.customer_email, new.customer_phone, new.shipping_address,
          public.order_invoice_document(new), 'at_issue');
  return new;
end
$fn$;
revoke execute on function public.order_invoice_snapshot_capture() from public, anon, authenticated, service_role;
create trigger orders_invoice_snapshot_capture
  after insert or update of invoice_number on public.orders
  for each row
  when (new.invoice_number is not null)
  execute function public.order_invoice_snapshot_capture();

-- Erasure (0033 nulls all four contact fields): seal the snapshot and redact
-- the PINs and city of any delivery review. The snapshot's details are moved,
-- not destroyed.
create function public.orders_contact_erasure_followup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  s order_invoice_snapshots%rowtype;
begin
  select * into s from order_invoice_snapshots where order_id = new.id for update;
  if found and s.sealed_at is null then
    insert into order_invoice_sealed_parties (order_id, invoice_number, customer_name, customer_email,
                                              customer_phone, delivery_address, basis)
    values (s.order_id, s.invoice_number, s.customer_name, s.customer_email,
            s.customer_phone, s.delivery_address, 'order contact details erased (account deletion, 0033)');
    update order_invoice_snapshots
       set customer_name = null, customer_email = null, customer_phone = null,
           delivery_address = null, sealed_at = now()
     where order_id = s.order_id;
  end if;
  perform set_config('wovenne.delivery_review', 'on', true);
  update order_delivery_reviews
     set previous_pin = null, new_pin = null, verified_city = null, redacted_at = now()
   where order_id = new.id and redacted_at is null;
  perform set_config('wovenne.delivery_review', '', true);
  return new;
end
$fn$;
revoke execute on function public.orders_contact_erasure_followup() from public, anon, authenticated, service_role;

-- ══ D-2: delivery review ════════════════════════════════════════════════════

alter table public.orders
  add column delivery_hold text
  constraint orders_delivery_hold_check check (delivery_hold in ('review_pending', 'refused'));
comment on column public.orders.delivery_hold is
  'OS-2b (0079): review_pending after a delivery PIN correction, refused after a
   refused review; null otherwise. Set and cleared only by the database; an
   order on hold cannot be shipped or delivered.';

create table public.order_delivery_reviews (
  id                         bigint generated always as identity primary key,
  order_id                   uuid not null references public.orders(id),
  opened_at                  timestamptz not null default now(),
  opened_by                  uuid,
  opened_by_email            text,
  opened_action              text,
  trigger_kind               text not null check (trigger_kind in ('pin_changed', 'address_changed_after_review', 'migration_backfill')),
  previous_pin               text,
  new_pin                    text,
  address_fingerprint        text not null,
  order_state                text,
  charged_delivery_inr       numeric,
  listed_unserviceable_prefix text,
  status                     text not null default 'pending'
                             check (status in ('pending', 'approved', 'refused', 'superseded')),
  decided_at                 timestamptz,
  decided_by                 uuid,
  decided_by_email           text,
  pin_verified               boolean,
  state_city_verified        boolean,
  verified_state             text,
  verified_city              text,
  serviceable                boolean,
  serviceability_source      text,
  serviceability_reference   text,
  published_rate_inr         integer check (published_rate_inr >= 0),
  courier_cost_estimate_inr  integer check (courier_cost_estimate_inr >= 0),
  cost_difference_reviewed   boolean,
  listed_exclusion_overridden boolean,
  decision_reason            text,
  redacted_at                timestamptz
);
comment on table public.order_delivery_reviews is
  'OS-2b (0079): one row per delivery-address review. Opened by the database when
   a PIN is corrected (or any address change after an earlier review); decided
   once through admin_decide_delivery_review; immutable afterwards except
   redaction of PINs and city on account deletion.';
create unique index order_delivery_reviews_one_pending on public.order_delivery_reviews (order_id) where status = 'pending';
create index order_delivery_reviews_order_idx on public.order_delivery_reviews (order_id, id desc);

alter table public.order_delivery_reviews enable row level security;
create policy "Admins read delivery reviews"
  on public.order_delivery_reviews for select to authenticated using (public.is_admin());
revoke all on table public.order_delivery_reviews from public, anon, authenticated, service_role;
grant select on table public.order_delivery_reviews to authenticated, service_role;
revoke all on sequence public.order_delivery_reviews_id_seq from public, anon, authenticated, service_role;

create function public.order_delivery_reviews_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if coalesce(current_setting('wovenne.delivery_review', true), '') <> 'on' then
    raise exception 'Delivery reviews are opened and decided only by the order functions.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A delivery review is kept with the order.' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.order_id is distinct from old.order_id
       or new.opened_at is distinct from old.opened_at or new.address_fingerprint is distinct from old.address_fingerprint
       or new.trigger_kind is distinct from old.trigger_kind
       or new.charged_delivery_inr is distinct from old.charged_delivery_inr then
      raise exception 'A delivery review''s opening record does not change.' using errcode = '55000';
    end if;
    -- Redaction only touches the PINs and city.
    if new.redacted_at is distinct from old.redacted_at then
      if old.redacted_at is not null or new.previous_pin is not null or new.new_pin is not null
         or new.verified_city is not null or new.status is distinct from old.status then
        raise exception 'A delivery review is redacted once, and only its PINs and city.' using errcode = '55000';
      end if;
    elsif old.status <> 'pending' then
      raise exception 'A decided delivery review does not change.' using errcode = '55000';
    end if;
  end if;
  return coalesce(new, old);
end
$fn$;
revoke execute on function public.order_delivery_reviews_guard() from public, anon, authenticated, service_role;
create trigger order_delivery_reviews_guard
  before insert or update or delete on public.order_delivery_reviews
  for each row execute function public.order_delivery_reviews_guard();

create function public.order_address_fingerprint(a jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$ select md5(coalesce(a::text, '')) $fn$;
revoke execute on function public.order_address_fingerprint(jsonb) from public, anon, authenticated, service_role;

-- Every path: opens reviews on a PIN change, keeps delivery_hold to the
-- database, and keeps a held order from being shipped or delivered.
create function public.orders_delivery_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ctx      boolean := coalesce(current_setting('wovenne.delivery_review', true), '') = 'on';
  v_old_pin  text := regexp_replace(coalesce(old.shipping_address ->> 'postal_code', ''), '\D', '', 'g');
  v_new_pin  text := regexp_replace(coalesce(new.shipping_address ->> 'postal_code', ''), '\D', '', 'g');
  v_history  boolean;
  v_kind     text;
  v_listed   text;
  v_id       bigint;
  v_email    text;
  v_country  text;
begin
  if new.delivery_hold is distinct from old.delivery_hold and not v_ctx then
    raise exception 'The delivery hold is set and cleared only by the delivery review (admin_decide_delivery_review).'
      using errcode = '42501';
  end if;

  if new.shipping_address is not null
     and new.shipping_address is distinct from old.shipping_address
     and new.status not in ('cancelled', 'shipped', 'delivered')
     and old.shipped_at is null and old.delivered_at is null then
    select exists (select 1 from order_delivery_reviews r where r.order_id = new.id) into v_history;
    if v_new_pin <> v_old_pin then
      v_kind := 'pin_changed';
    elsif v_history then
      v_kind := 'address_changed_after_review';
    end if;
    if v_kind is not null then
      v_country := lower(btrim(coalesce(new.shipping_address ->> 'country', 'india')));
      if v_country in ('india', 'in', '') and v_new_pin !~ '^[1-9][0-9]{5}$' then
        raise exception 'An Indian PIN code is six digits and does not start with 0.' using errcode = '22023';
      end if;
      select p into v_listed
        from site_content sc,
             jsonb_array_elements_text(case when jsonb_typeof(sc.value -> 'unserviceable_prefixes') = 'array'
                                            then sc.value -> 'unserviceable_prefixes' else '[]'::jsonb end) p
       where sc.key = 'delivery' and btrim(p) <> '' and v_new_pin like btrim(p) || '%'
       order by length(btrim(p)) desc
       limit 1;
      if auth.uid() is not null then
        select pr.email into v_email from profiles pr where pr.id = auth.uid();
      end if;
      perform set_config('wovenne.delivery_review', 'on', true);
      -- An earlier pending review no longer describes this address.
      update order_delivery_reviews set status = 'superseded'
       where order_id = new.id and status = 'pending';
      insert into order_delivery_reviews (order_id, opened_by, opened_by_email, opened_action, trigger_kind,
                                          previous_pin, new_pin, address_fingerprint, order_state,
                                          charged_delivery_inr, listed_unserviceable_prefix)
      values (new.id, auth.uid(), v_email,
              coalesce(nullif(current_setting('wovenne.order_action', true), ''), 'update'), v_kind,
              nullif(v_old_pin, ''), v_new_pin, public.order_address_fingerprint(new.shipping_address),
              new.shipping_address ->> 'state', new.shipping_cost_inr, v_listed)
      returning id into v_id;
      perform set_config('wovenne.delivery_review', '', true);
      new.delivery_hold := 'review_pending';
    end if;
  end if;

  if new.delivery_hold is not null
     and new.status in ('shipped', 'delivered') and old.status not in ('shipped', 'delivered') then
    raise exception 'This order''s delivery address was corrected and is held for review (%). Record the delivery review before dispatching it.',
      new.delivery_hold using errcode = '55000';
  end if;
  return new;
end
$fn$;
revoke execute on function public.orders_delivery_review() from public, anon, authenticated, service_role;
create trigger orders_delivery_review
  before update on public.orders
  for each row execute function public.orders_delivery_review();

create trigger orders_contact_erasure_followup
  after update of customer_email, customer_name, customer_phone, shipping_address on public.orders
  for each row
  when (new.customer_email is null and new.customer_name is null and new.customer_phone is null
        and new.shipping_address is null)
  execute function public.orders_contact_erasure_followup();

-- The review, decided by an admin (aal2, live session — is_admin()).
--   p_decision  'approve' | 'refuse'
--   p_evidence  { pin_verified, state_city_verified, verified_state, verified_city,
--                 serviceable, serviceability_source, serviceability_reference,
--                 published_rate_inr, courier_cost_estimate_inr,
--                 cost_difference_reviewed, listed_exclusion_overridden }
--   p_reason    at least 10 characters (0078's rule), kept on the review and in
--               order_events.
create function public.admin_decide_delivery_review(
  p_review_id bigint,
  p_decision  text,
  p_evidence  jsonb,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r        order_delivery_reviews%rowtype;
  o        orders%rowtype;
  v_reason text;
  v_email  text;
  e        jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_state  text;
  v_city   text;
  v_source text;
  v_rate   integer;
  v_cost   integer;
  v_hold   text;
  b        text;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  v_reason := public.order_correction_reason(p_reason);
  if p_decision is null or p_decision not in ('approve', 'refuse') then
    raise exception 'A delivery review is approved or refused.' using errcode = '22023';
  end if;
  if jsonb_typeof(e) <> 'object' then
    raise exception 'The review evidence is an object.' using errcode = '22023';
  end if;

  select * into r from order_delivery_reviews where id = p_review_id;
  if not found then
    raise exception 'That delivery review does not exist.' using errcode = 'P0002';
  end if;
  -- The order first (the same lock the correction takes), then the review.
  select * into o from orders where id = r.order_id for update;
  select * into r from order_delivery_reviews where id = p_review_id for update;

  if r.status <> 'pending' then
    raise exception 'This review is already %: the address it was opened for has been decided or corrected again. Review the latest one.',
      r.status using errcode = '55000';
  end if;
  if r.address_fingerprint is distinct from public.order_address_fingerprint(o.shipping_address) then
    raise exception 'The delivery address has changed since this review was opened. Review the latest one.' using errcode = '55000';
  end if;
  if o.status in ('cancelled', 'shipped', 'delivered') or o.shipped_at is not null then
    raise exception 'This order is % — there is no dispatch left to review.', o.status using errcode = '55000';
  end if;

  v_state  := nullif(btrim(coalesce(e ->> 'verified_state', '')), '');
  v_city   := nullif(btrim(coalesce(e ->> 'verified_city', '')), '');
  v_source := nullif(btrim(coalesce(e ->> 'serviceability_source', '')), '');
  if e ? 'published_rate_inr' and jsonb_typeof(e -> 'published_rate_inr') = 'number' then
    v_rate := (e ->> 'published_rate_inr')::numeric::integer;
  end if;
  if e ? 'courier_cost_estimate_inr' and jsonb_typeof(e -> 'courier_cost_estimate_inr') = 'number' then
    v_cost := (e ->> 'courier_cost_estimate_inr')::numeric::integer;
  end if;
  foreach b in array array['pin_verified', 'state_city_verified', 'serviceable', 'cost_difference_reviewed', 'listed_exclusion_overridden'] loop
    if e ? b and jsonb_typeof(e -> b) <> 'boolean' then
      raise exception '% is true or false.', b using errcode = '22023';
    end if;
  end loop;

  if p_decision = 'approve' then
    if coalesce((e ->> 'pin_verified')::boolean, false) is not true then
      raise exception 'Check the corrected PIN exists (India Post PIN search) before approving.' using errcode = '22023';
    end if;
    if coalesce((e ->> 'state_city_verified')::boolean, false) is not true or v_state is null or v_city is null then
      raise exception 'Record the State and city the PIN belongs to, as checked.' using errcode = '22023';
    end if;
    if lower(v_state) is distinct from lower(btrim(coalesce(o.shipping_address ->> 'state', ''))) then
      raise exception 'The PIN is in %, but the order is for %. The delivery charge and place of supply were set for %: refuse this review, then cancel and record a new order.',
        v_state, coalesce(o.shipping_address ->> 'state', 'no State'), coalesce(o.shipping_address ->> 'state', 'no State')
        using errcode = '55000';
    end if;
    if coalesce((e ->> 'serviceable')::boolean, false) is not true then
      raise exception 'Approve only when the courier serves this PIN; otherwise refuse the review.' using errcode = '22023';
    end if;
    if v_source is null or length(v_source) < 3 then
      raise exception 'Say where serviceability was confirmed (for example "India Post PIN search, Speed Post booking office").' using errcode = '22023';
    end if;
    if v_rate is null or v_rate < 0 or v_cost is null or v_cost < 0 then
      raise exception 'Record the published delivery rate for the new PIN and the expected courier cost (whole rupees).' using errcode = '22023';
    end if;
    if coalesce((e ->> 'cost_difference_reviewed')::boolean, false) is not true then
      raise exception 'Confirm you have reviewed the difference between what was charged and the courier cost.' using errcode = '22023';
    end if;
    if r.listed_unserviceable_prefix is not null
       and coalesce((e ->> 'listed_exclusion_overridden')::boolean, false) is not true then
      raise exception 'PIN % matches "%" in the "we don''t deliver here" list. Confirm the courier serves it (and say so in the reason), or refuse.',
        r.new_pin, r.listed_unserviceable_prefix using errcode = '22023';
    end if;
  end if;

  if auth.uid() is not null then
    select p.email into v_email from profiles p where p.id = auth.uid();
  end if;
  perform set_config('wovenne.delivery_review', 'on', true);
  update order_delivery_reviews
     set status = case when p_decision = 'approve' then 'approved' else 'refused' end,
         decided_at = now(), decided_by = auth.uid(), decided_by_email = v_email,
         pin_verified = (e ->> 'pin_verified')::boolean,
         state_city_verified = (e ->> 'state_city_verified')::boolean,
         verified_state = v_state, verified_city = v_city,
         serviceable = (e ->> 'serviceable')::boolean,
         serviceability_source = left(v_source, 300),
         serviceability_reference = left(nullif(btrim(coalesce(e ->> 'serviceability_reference', '')), ''), 300),
         published_rate_inr = v_rate, courier_cost_estimate_inr = v_cost,
         cost_difference_reviewed = (e ->> 'cost_difference_reviewed')::boolean,
         listed_exclusion_overridden = (e ->> 'listed_exclusion_overridden')::boolean,
         decision_reason = v_reason
   where id = r.id;

  v_hold := case when p_decision = 'approve' then null else 'refused' end;
  perform public.order_transition_begin('admin_decide_delivery_review', v_reason);
  update orders set delivery_hold = v_hold where id = o.id;
  perform public.order_transition_end();
  perform set_config('wovenne.delivery_review', '', true);

  return jsonb_build_object(
    'outcome', case when p_decision = 'approve' then 'approved' else 'refused' end,
    'review_id', r.id,
    'delivery_hold', v_hold,
    'charged_delivery_inr', r.charged_delivery_inr,
    'published_rate_inr', v_rate,
    'courier_cost_estimate_inr', v_cost);
end
$fn$;
revoke execute on function public.admin_decide_delivery_review(bigint, text, jsonb, text) from public, anon, service_role;
grant execute on function public.admin_decide_delivery_review(bigint, text, jsonb, text) to authenticated;

-- ══ Backfills ═══════════════════════════════════════════════════════════════

-- D-1: invoices issued before this migration. The issued values are recovered
-- only where 0078's ledger proves them; otherwise the row is labelled for what
-- it is. Nothing is invented. Orders already anonymised (0033) have nothing
-- personal to keep: their record is sealed with empty details.
do $bf$
declare
  o   public.orders%rowtype;
  c   record;
  v_name text; v_phone text; v_addr jsonb;
  v_src text; v_note text; n int;
begin
  for o in select * from orders where invoice_number is not null order by invoice_issued_at nulls first, id loop
    v_name := o.customer_name; v_phone := o.customer_phone; v_addr := o.shipping_address;
    v_src := 'row_at_migration'; n := 0;
    v_note := 'Order row as found when 0079 was applied. Before 0078 these details could be edited without a record, so they are not proven to be what was issued.';
    if o.customer_email is null and o.customer_name is null and o.customer_phone is null and o.shipping_address is null then
      insert into order_invoice_snapshots (order_id, invoice_number, invoice_issued_at, order_created_at,
                                           document, source, provenance_note)
      values (o.id, o.invoice_number, o.invoice_issued_at, o.created_at, public.order_invoice_document(o),
              'row_at_migration', 'Customer details were already erased (account deletion) before 0079; none retained.');
      insert into order_invoice_sealed_parties (order_id, invoice_number, basis)
      values (o.id, o.invoice_number, 'erased before 0079; nothing retained');
      update order_invoice_snapshots set sealed_at = now() where order_id = o.id;
      continue;
    end if;
    for c in select * from order_contact_corrections
              where order_id = o.id and corrected_at >= coalesce(o.invoice_issued_at, o.created_at)
                and redacted_at is null
              order by corrected_at desc, id desc loop
      if c.before ? 'customer_name'    then v_name  := c.before ->> 'customer_name'; end if;
      if c.before ? 'customer_phone'   then v_phone := c.before ->> 'customer_phone'; end if;
      if c.before ? 'shipping_address' then v_addr  := c.before -> 'shipping_address'; end if;
      n := n + 1;
    end loop;
    if n > 0 then
      v_src := 'reconstructed';
      v_note := format('%s correction(s) recorded after issue (0078 ledger) reversed when 0079 was applied. Changes before 0078 are not recorded and cannot be ruled out.', n);
    end if;
    insert into order_invoice_snapshots (order_id, invoice_number, invoice_issued_at, order_created_at,
                                         customer_name, customer_email, customer_phone, delivery_address,
                                         document, source, provenance_note)
    values (o.id, o.invoice_number, o.invoice_issued_at, o.created_at, v_name, o.customer_email, v_phone, v_addr,
            public.order_invoice_document(o), v_src, v_note);
  end loop;
end
$bf$;

-- D-2: an order whose PIN was corrected under 0078 and not yet dispatched is
-- held, exactly as it would have been had 0079 been live. (Gate H applies 0078
-- and 0079 in one freeze, so this is expected to find nothing.)
do $bf2$
declare
  o public.orders%rowtype;
begin
  perform set_config('wovenne.delivery_review', 'on', true);
  for o in select ord.* from orders ord
            where ord.status not in ('cancelled', 'shipped', 'delivered')
              and ord.shipped_at is null and ord.delivered_at is null and ord.shipping_address is not null
              and exists (select 1 from order_contact_corrections c
                           where c.order_id = ord.id and c.redacted_at is null
                             and c.after ? 'shipping_address'
                             and regexp_replace(coalesce(c.after -> 'shipping_address' ->> 'postal_code', ''), '\D', '', 'g')
                                 is distinct from regexp_replace(coalesce(c.before -> 'shipping_address' ->> 'postal_code', ''), '\D', '', 'g'))
  loop
    insert into order_delivery_reviews (order_id, opened_action, trigger_kind, new_pin, address_fingerprint,
                                        order_state, charged_delivery_inr)
    values (o.id, 'migration_0079', 'migration_backfill',
            regexp_replace(coalesce(o.shipping_address ->> 'postal_code', ''), '\D', '', 'g'),
            public.order_address_fingerprint(o.shipping_address), o.shipping_address ->> 'state', o.shipping_cost_inr);
    perform public.order_transition_begin('migration_0079', 'PIN corrected under 0078 before 0079: held for delivery review');
    update orders set delivery_hold = 'review_pending' where id = o.id;
    perform public.order_transition_end();
  end loop;
  perform set_config('wovenne.delivery_review', '', true);
end
$bf2$;

-- ══ Self-check ══════════════════════════════════════════════════════════════
do $chk$
declare r text;
begin
  if exists (select 1 from orders o where o.invoice_number is not null
               and not exists (select 1 from order_invoice_snapshots s where s.order_id = o.id)) then
    raise exception '0079 self-check: an invoiced order has no snapshot.';
  end if;
  foreach r in array array['authenticated', 'service_role', 'anon'] loop
    if has_table_privilege(r, 'public.order_invoice_snapshots', 'INSERT')
       or has_table_privilege(r, 'public.order_invoice_snapshots', 'UPDATE')
       or has_table_privilege(r, 'public.order_invoice_snapshots', 'DELETE')
       or has_table_privilege(r, 'public.order_invoice_sealed_parties', 'SELECT')
       or has_table_privilege(r, 'public.order_invoice_sealed_parties', 'INSERT')
       or has_table_privilege(r, 'public.order_delivery_reviews', 'INSERT')
       or has_table_privilege(r, 'public.order_delivery_reviews', 'UPDATE')
       or has_table_privilege(r, 'public.order_delivery_reviews', 'DELETE') then
      raise exception '0079 self-check: % can write a protected table or read the sealed one.', r;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.order_invoice_snapshots', 'SELECT') then
    raise exception '0079 self-check: snapshots are public.';
  end if;
  -- orders.delivery_hold is guarded by orders_delivery_review for every role
  -- (grants on orders are 0078's and the posture manifest's to assert).
end
$chk$;
