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
-- WP-ORDER-SAFETY-09 (finalisation, still 0079 — never applied anywhere):
--   * Seller identity and tax treatment are frozen per document. A versioned,
--     append-only invoice_issuer_profiles holds who issues invoices and under
--     what registration (today: NOT GST-registered, no GSTIN, no tax charged,
--     titled "Invoice"). The profile in force is copied into the invoice
--     snapshot at issue and into credit_note_issuer_snapshots when a credit
--     note is issued, in the same statement. A later profile (new address, GST
--     registration) cannot reach an older document. Registering is refused by
--     this version: it needs the GST work package and the CA's answer (RB-1).
--   * Historical documents get the v1 profile labelled code_history_at_migration
--     (the seller block and "Not registered for GST" statement have been
--     constant since invoicing began, d203c89 / #81), never at_issue. Any order
--     whose tax column holds a value is flagged in its provenance note for the
--     accountant, and left unchanged.
--   * Retention: sealed details stay until a CA-confirmed rule exists in
--     financial_record_retention_rules; then an owner-only purge removes them
--     once expired and logs it. Owner reads go through an owner-only function
--     that logs the purpose. No API role can do either.
--   * Delivery review (WP-09B): approval needs the State of the FULL six-digit
--     PIN, as looked up (verified_pin must equal the order's PIN, with the
--     lookup's source). The customer's typed State is what it is compared
--     with, never proof of where the PIN is. A looked-up State different from
--     the order's is never approved here: refuse and escalate (cancel and
--     re-order, or a separately approved correction). The two-digit postal
--     circle table is ADVISORY only — circles span several States/UTs and
--     have exceptions — so it never decides a State and never forces a
--     cancellation: when it does not cover the order's State (or knows no
--     circle for the prefix) the order stays held until a documented manual
--     verification note is recorded. Not a serviceability source.
--
-- WHAT THIS DOES NOT DO
--   No new invoice number or document on a correction. No change to the
--   numbering (0037/0043), to 0078's functions, or to Invoice V2 (off). No
--   courier integration. No GST calculation, rate, HSN or tax block. No
--   scheduled purge and no retention period (CA). Document layout versioning
--   stays Invoice V2's (#224, INVOICE_V2_FROM).
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

-- ══ Who issues the document, and under what tax registration (WP-09) ══════

-- Append-only. One row per seller profile; the one in force at issue is
-- copied into each document's snapshot, so a later row never reaches an older
-- document. No API role has any privilege: rows are added by the owner in a
-- migration, never from the app.
create table public.invoice_issuer_profiles (
  version          integer primary key check (version > 0),
  effective_from   timestamptz not null unique,
  seller_name      text not null check (btrim(seller_name) <> ''),
  address_lines    jsonb not null check (jsonb_typeof(address_lines) = 'array' and jsonb_array_length(address_lines) > 0),
  gst_registration text not null check (gst_registration in ('unregistered', 'registered')),
  gstin            text,
  document_title   text not null check (btrim(document_title) <> ''),
  tax_treatment    text not null check (tax_treatment in ('no_gst_charged_unregistered', 'gst_registered')),
  basis            text not null check (length(btrim(basis)) >= 20),
  recorded_at      timestamptz not null default now(),
  -- An unregistered seller has no GSTIN, charges no tax and does not call the
  -- document a tax invoice. A registered profile needs a GSTIN-shaped value.
  constraint invoice_issuer_profiles_consistent check (
    (gst_registration = 'unregistered' and gstin is null and tax_treatment = 'no_gst_charged_unregistered'
       and document_title !~* 'tax')
    or (gst_registration = 'registered' and tax_treatment = 'gst_registered'
        and gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'))
);
comment on table public.invoice_issuer_profiles is
  'Seller identity and tax treatment for invoices and credit notes (0079, WP-09).
   Append-only. Copied into each document at issue; never read back to render an
   older document. GST registration is refused until the GST work package.';
alter table public.invoice_issuer_profiles enable row level security;
revoke all on table public.invoice_issuer_profiles from public, anon, authenticated, service_role;

create function public.invoice_issuer_profiles_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op <> 'INSERT' then
    raise exception 'A seller profile is never changed or removed: add a new version.' using errcode = '55000';
  end if;
  if new.gst_registration = 'registered' then
    raise exception 'GST registration is not supported by this version: invoices would need GST, rates, HSN and place of supply (see the CA decision, RB-1).'
      using errcode = '0A000';
  end if;
  if new.version > 1 and new.effective_from < now() then
    raise exception 'A new seller profile takes effect now or later, never backdated.' using errcode = '22023';
  end if;
  return new;
end
$fn$;
revoke execute on function public.invoice_issuer_profiles_guard() from public, anon, authenticated, service_role;
create trigger invoice_issuer_profiles_guard
  before insert or update or delete on public.invoice_issuer_profiles
  for each row execute function public.invoice_issuer_profiles_guard();

-- v1: what every invoice and credit note has printed since invoicing began.
-- Must equal lib/invoice.ts ISSUER (scripts/os2b-invoice-delivery.test.ts).
insert into public.invoice_issuer_profiles (version, effective_from, seller_name, address_lines, gst_registration,
                                            gstin, document_title, tax_treatment, basis)
values (1, '-infinity', 'THE WOVENNE',
        '["Anns Building", "Kidangara", "Alappuzha", "Kerala 686102", "India"]'::jsonb,
        'unregistered', null, 'Invoice', 'no_gst_charged_unregistered',
        'Seller block and "Not registered for GST" statement printed since invoicing began (d203c89, #81, 8 Aug 2026). Not GST-registered: no GSTIN, no tax charged.');

-- The profile in force at a moment, as the copy a document keeps.
create function public.invoice_issuer_at(p_at timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v jsonb;
begin
  select jsonb_build_object('profile_version', p.version, 'seller_name', p.seller_name,
                            'address_lines', p.address_lines, 'gst_registration', p.gst_registration,
                            'gstin', p.gstin, 'document_title', p.document_title, 'tax_treatment', p.tax_treatment)
    into v
    from invoice_issuer_profiles p
   where p.effective_from <= p_at
   order by p.effective_from desc
   limit 1;
  if v is null then
    raise exception 'No seller profile is in force: a document cannot be issued.' using errcode = '55000';
  end if;
  return v;
end
$fn$;
revoke execute on function public.invoice_issuer_at(timestamptz) from public, anon, authenticated, service_role;

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
  -- The seller block and tax treatment the document was issued under (a copy
  -- of invoice_issuer_profiles, WP-09). issuer_source: at_issue, or
  -- code_history_at_migration for invoices issued before 0079.
  issuer            jsonb not null check (jsonb_typeof(issuer) = 'object' and issuer ? 'profile_version'),
  issuer_source     text not null check (issuer_source in ('at_issue', 'code_history_at_migration')),
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
     or new.issuer is distinct from old.issuer or new.issuer_source is distinct from old.issuer_source
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
  -- The one removal: owner_purge_sealed_invoice_parties, once a CA-confirmed
  -- retention rule says the period is over (it logs every row first). No API
  -- role has DELETE, so the flag alone opens nothing.
  if tg_op = 'DELETE' and coalesce(current_setting('wovenne.sealed_purge', true), '') = 'on'
     and exists (select 1 from sealed_record_purge_log l where l.order_id = old.order_id and l.purged_at = now()) then
    return old;
  end if;
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
                                       document, source, issuer, issuer_source)
  values (new.id, new.invoice_number, new.invoice_issued_at, new.created_at,
          new.customer_name, new.customer_email, new.customer_phone, new.shipping_address,
          public.order_invoice_document(new), 'at_issue', public.invoice_issuer_at(now()), 'at_issue');
  return new;
end
$fn$;
revoke execute on function public.order_invoice_snapshot_capture() from public, anon, authenticated, service_role;
create trigger orders_invoice_snapshot_capture
  after insert or update of invoice_number on public.orders
  for each row
  when (new.invoice_number is not null)
  execute function public.order_invoice_snapshot_capture();

-- A credit note keeps the seller block it was issued under, the same way
-- (WP-09). Its figures are already on its own row (0043); its party is the
-- reversed invoice's (order_invoice_snapshots).
create table public.credit_note_issuer_snapshots (
  credit_note_id     uuid primary key references public.credit_notes(id),
  credit_note_number text not null unique,
  issuer             jsonb not null check (jsonb_typeof(issuer) = 'object' and issuer ? 'profile_version'),
  issuer_source      text not null check (issuer_source in ('at_issue', 'code_history_at_migration')),
  captured_at        timestamptz not null default now()
);
comment on table public.credit_note_issuer_snapshots is
  'The seller block and tax treatment a credit note was issued under (0079,
   WP-09). Written once with the note; never rewritten.';
alter table public.credit_note_issuer_snapshots enable row level security;
-- Readable exactly when the credit note is (0043: admins, the customer).
create policy "Read with the credit note"
  on public.credit_note_issuer_snapshots for select to authenticated
  using (exists (select 1 from public.credit_notes cn where cn.id = credit_note_id));
revoke all on table public.credit_note_issuer_snapshots from public, anon, authenticated, service_role;
grant select on table public.credit_note_issuer_snapshots to authenticated, service_role;

create function public.credit_note_issuer_snapshots_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'The seller block a credit note was issued under does not change.' using errcode = '55000';
end
$fn$;
revoke execute on function public.credit_note_issuer_snapshots_guard() from public, anon, authenticated, service_role;
create trigger credit_note_issuer_snapshots_guard
  before update or delete on public.credit_note_issuer_snapshots
  for each row execute function public.credit_note_issuer_snapshots_guard();

create function public.credit_note_issuer_capture()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into credit_note_issuer_snapshots (credit_note_id, credit_note_number, issuer, issuer_source)
  values (new.id, new.credit_note_number, public.invoice_issuer_at(now()), 'at_issue');
  return new;
end
$fn$;
revoke execute on function public.credit_note_issuer_capture() from public, anon, authenticated, service_role;
create trigger credit_notes_issuer_capture
  after insert on public.credit_notes
  for each row execute function public.credit_note_issuer_capture();

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
     set previous_pin = null, new_pin = null, verified_city = null, verified_pin = null,
         circle_conflict_note = null, redacted_at = now()
   where order_id = new.id and redacted_at is null;
  perform set_config('wovenne.delivery_review', '', true);
  return new;
end
$fn$;
revoke execute on function public.orders_contact_erasure_followup() from public, anon, authenticated, service_role;

-- ══ Retention of sealed details: access and lawful deletion (WP-09) ═════════
--
-- Sealed details are NOT kept forever by design. They are kept until a
-- retention rule, confirmed by a CA/lawyer, is recorded here; after that the
-- owner's purge removes each record once its period has ended. Until a rule
-- exists nothing is purged (the period is unknown, not infinite). All three
-- tables are append-only and invisible to every API role; the two functions
-- are callable only by the database owner (an SQL session, never the app).

create table public.financial_record_retention_rules (
  id             bigint generated always as identity primary key,
  record_kind    text not null check (record_kind = 'invoice_party_details'),
  period_months  integer not null check (period_months between 1 and 1200),
  -- invoice_issued: from the issue date. financial_year_end: from 31 March
  -- (India) after the issue date.
  starts_from    text not null check (starts_from in ('invoice_issued', 'financial_year_end')),
  basis          text not null check (length(btrim(basis)) >= 20),
  confirmed_by   text not null check (length(btrim(confirmed_by)) >= 3),
  recorded_at    timestamptz not null default now()
);
comment on table public.financial_record_retention_rules is
  'How long sealed invoice party details are kept (0079, WP-09). Empty until a CA
   confirms the period and its basis; append-only.';

create table public.sealed_record_access_log (
  id             bigint generated always as identity primary key,
  order_id       uuid not null,
  invoice_number text,
  purpose        text not null check (purpose in ('tax_or_regulatory_enquiry', 'legal_claim_or_dispute',
                                                  'court_or_authority_order', 'customer_access_request',
                                                  'accountant_review')),
  reference      text not null check (length(btrim(reference)) >= 5),
  accessed_at    timestamptz not null default now(),
  accessed_by    text not null default session_user
);
comment on table public.sealed_record_access_log is
  'Every read of a sealed invoice record through owner_read_sealed_invoice_party (0079). Append-only.';

create table public.sealed_record_purge_log (
  id                   bigint generated always as identity primary key,
  order_id             uuid not null,
  invoice_number       text,
  rule_id              bigint not null references public.financial_record_retention_rules(id),
  retention_expired_at timestamptz not null,
  purged_at            timestamptz not null default now(),
  purged_by            text not null default session_user
);
comment on table public.sealed_record_purge_log is
  'Sealed invoice records removed at the end of their retention period (0079). Append-only; holds no personal data.';

alter table public.financial_record_retention_rules enable row level security;
alter table public.sealed_record_access_log enable row level security;
alter table public.sealed_record_purge_log enable row level security;
revoke all on table public.financial_record_retention_rules from public, anon, authenticated, service_role;
revoke all on table public.sealed_record_access_log from public, anon, authenticated, service_role;
revoke all on table public.sealed_record_purge_log from public, anon, authenticated, service_role;
revoke all on sequence public.financial_record_retention_rules_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.sealed_record_access_log_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.sealed_record_purge_log_id_seq from public, anon, authenticated, service_role;

create function public.append_only_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception '% is append-only.', tg_table_name using errcode = '55000';
end
$fn$;
revoke execute on function public.append_only_guard() from public, anon, authenticated, service_role;
create trigger financial_record_retention_rules_append_only
  before update or delete on public.financial_record_retention_rules
  for each row execute function public.append_only_guard();
create trigger sealed_record_access_log_append_only
  before update or delete on public.sealed_record_access_log
  for each row execute function public.append_only_guard();
create trigger sealed_record_purge_log_append_only
  before update or delete on public.sealed_record_purge_log
  for each row execute function public.append_only_guard();

-- Read one sealed record, for a stated purpose; the read is logged first.
create function public.owner_read_sealed_invoice_party(p_order_id uuid, p_purpose text, p_reference text)
returns table (order_id uuid, invoice_number text, customer_name text, customer_email text,
               customer_phone text, delivery_address jsonb, sealed_at timestamptz, basis text)
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  s order_invoice_sealed_parties%rowtype;
begin
  select * into s from order_invoice_sealed_parties sp where sp.order_id = p_order_id;
  if not found then
    raise exception 'No sealed record for that order.' using errcode = 'P0002';
  end if;
  insert into sealed_record_access_log (order_id, invoice_number, purpose, reference)
  values (s.order_id, s.invoice_number, p_purpose, p_reference);
  return query select s.order_id, s.invoice_number, s.customer_name, s.customer_email,
                      s.customer_phone, s.delivery_address, s.sealed_at, s.basis;
end
$fn$;
revoke execute on function public.owner_read_sealed_invoice_party(uuid, text, text) from public, anon, authenticated, service_role;

-- When a sealed record's period ends under a rule.
create function public.sealed_record_expiry(p_issued timestamptz, r public.financial_record_retention_rules)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $fn$
  select case r.starts_from
           when 'invoice_issued' then p_issued
           else (make_date(extract(year from (p_issued at time zone 'Asia/Kolkata'))::int
                           + case when extract(month from (p_issued at time zone 'Asia/Kolkata')) >= 4 then 1 else 0 end, 4, 1)::timestamp
                 at time zone 'Asia/Kolkata')
         end + make_interval(months => r.period_months);
$fn$;
revoke execute on function public.sealed_record_expiry(timestamptz, public.financial_record_retention_rules) from public, anon, authenticated, service_role;

-- List (p_execute false, the default) or remove (true) the sealed records
-- whose period under rule p_rule_id has ended. Each removal is logged first.
-- The readable snapshot keeps the invoice number and figures (no personal data).
create function public.owner_purge_sealed_invoice_parties(p_rule_id bigint, p_execute boolean default false)
returns table (order_id uuid, invoice_number text, retention_expired_at timestamptz, purged boolean)
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  r   financial_record_retention_rules%rowtype;
  x   record;
begin
  select * into r from financial_record_retention_rules where id = p_rule_id;
  if not found then
    raise exception 'No such retention rule: nothing is purged until a CA-confirmed rule is recorded.' using errcode = 'P0002';
  end if;
  for x in
    select sp.order_id, sp.invoice_number,
           public.sealed_record_expiry(coalesce(s.invoice_issued_at, s.order_created_at), r) as exp
      from order_invoice_sealed_parties sp
      join order_invoice_snapshots s on s.order_id = sp.order_id
     where coalesce(s.invoice_issued_at, s.order_created_at) is not null
     order by sp.order_id
  loop
    continue when x.exp > now();
    if p_execute then
      insert into sealed_record_purge_log (order_id, invoice_number, rule_id, retention_expired_at)
      values (x.order_id, x.invoice_number, r.id, x.exp);
      perform set_config('wovenne.sealed_purge', 'on', true);
      delete from order_invoice_sealed_parties sp where sp.order_id = x.order_id;
      perform set_config('wovenne.sealed_purge', '', true);
    end if;
    order_id := x.order_id; invoice_number := x.invoice_number; retention_expired_at := x.exp; purged := p_execute;
    return next;
  end loop;
end
$fn$;
revoke execute on function public.owner_purge_sealed_invoice_parties(bigint, boolean) from public, anon, authenticated, service_role;

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
  -- The States/UTs the new PIN's postal circle (first two digits) can belong
  -- to (WP-09). ADVISORY: empty = the table knows no circle for the prefix.
  pin_circle_states          text[],
  status                     text not null default 'pending'
                             check (status in ('pending', 'approved', 'refused', 'superseded')),
  decided_at                 timestamptz,
  decided_by                 uuid,
  decided_by_email           text,
  pin_verified               boolean,
  state_city_verified        boolean,
  verified_state             text,
  verified_city              text,
  -- WP-09B: the exact six-digit PIN that was looked up, and where.
  verified_pin               text,
  pin_lookup_source          text,
  -- The advisory postal-circle table vs the order's State, at decision time:
  -- consistent | not_covered (table disagrees) | no_circle (table has none).
  circle_check               text check (circle_check in ('consistent', 'not_covered', 'no_circle')),
  -- Required to approve when circle_check is not 'consistent'.
  circle_conflict_note       text,
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
    -- Redaction only touches the PINs, city and the manual-verification note.
    if new.redacted_at is distinct from old.redacted_at then
      if old.redacted_at is not null or new.previous_pin is not null or new.new_pin is not null
         or new.verified_city is not null or new.verified_pin is not null or new.circle_conflict_note is not null
         or new.status is distinct from old.status then
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

-- A State as typed at checkout (free text), reduced to a comparable key.
create function public.indian_state_key(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case k
           when 'new delhi' then 'delhi' when 'nct of delhi' then 'delhi' when 'delhi ncr' then 'delhi'
           when 'orissa' then 'odisha' when 'pondicherry' then 'puducherry' when 'uttaranchal' then 'uttarakhand'
           when 'j and k' then 'jammu and kashmir' when 'jammu kashmir' then 'jammu and kashmir'
           when 'andaman and nicobar' then 'andaman and nicobar islands'
           when 'dadra and nagar haveli' then 'dadra and nagar haveli and daman and diu'
           when 'daman and diu' then 'dadra and nagar haveli and daman and diu'
           else k end
    from (select btrim(regexp_replace(regexp_replace(lower(coalesce(p, '')), '&', ' and ', 'g'), '[^a-z]+', ' ', 'g')) k) s;
$fn$;
revoke execute on function public.indian_state_key(text) from public, anon, authenticated, service_role;

-- The States/UTs an Indian PIN's postal circle (its first two digits) can
-- belong to. ADVISORY ONLY (WP-09B): two digits name a postal region/circle,
-- not a State. Circles span several States/UTs (Kerala circle: Lakshadweep,
-- Mahe; Maharashtra: Goa; Punjab: Chandigarh; West Bengal: Sikkim, Andaman)
-- and have enclaves served by a neighbour's circle (Yanam, Puducherry: 533464).
-- It never decides a State and never forces a cancellation; a disagreement
-- only keeps the order held for documented manual verification. It is not
-- evidence that the PIN exists or that a courier serves it. 90–99 (Army
-- Postal Service) and unused prefixes give an empty array (= unknown).
create function public.indian_pin_circle_states(p_pin text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case
    when p_pin !~ '^[1-9][0-9]{5}$' then '{}'::text[]
    when d = 11             then array['delhi']
    when d between 12 and 13 then array['haryana']
    when d between 14 and 16 then array['punjab', 'chandigarh']
    when d = 17             then array['himachal pradesh']
    when d between 18 and 19 then array['jammu and kashmir', 'ladakh']
    when d between 20 and 28 then array['uttar pradesh', 'uttarakhand']
    when d between 30 and 34 then array['rajasthan']
    when d between 36 and 39 then array['gujarat', 'dadra and nagar haveli and daman and diu']
    when d between 40 and 44 then array['maharashtra', 'goa']
    when d between 45 and 49 then array['madhya pradesh', 'chhattisgarh']
    when d between 50 and 53 then array['telangana', 'andhra pradesh', 'puducherry']
    when d between 56 and 59 then array['karnataka']
    when d between 60 and 64 then array['tamil nadu', 'puducherry']
    when d between 67 and 69 then array['kerala', 'lakshadweep', 'puducherry']
    when d between 70 and 74 then array['west bengal', 'sikkim', 'andaman and nicobar islands']
    when d between 75 and 77 then array['odisha']
    when d = 78             then array['assam']
    when d = 79             then array['assam', 'arunachal pradesh', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'tripura']
    when d between 80 and 85 then array['bihar', 'jharkhand']
    else '{}'::text[]
  end
  from (select case when p_pin ~ '^[1-9][0-9]{5}$' then left(p_pin, 2)::int end d) s;
$fn$;
revoke execute on function public.indian_pin_circle_states(text) from public, anon, authenticated, service_role;

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
                                          charged_delivery_inr, listed_unserviceable_prefix, pin_circle_states)
      values (new.id, auth.uid(), v_email,
              coalesce(nullif(current_setting('wovenne.order_action', true), ''), 'update'), v_kind,
              nullif(v_old_pin, ''), v_new_pin, public.order_address_fingerprint(new.shipping_address),
              new.shipping_address ->> 'state', new.shipping_cost_inr, v_listed,
              public.indian_pin_circle_states(v_new_pin))
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
--   p_evidence  { pin_verified, verified_pin, pin_lookup_source,
--                 state_city_verified, verified_state, verified_city, circle_conflict_note,
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
  v_pin    text;
  v_circle text[];
  v_vpin   text;
  v_lsrc   text;
  v_note   text;
  v_okey   text;
  v_check  text;
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
  v_vpin   := nullif(regexp_replace(coalesce(e ->> 'verified_pin', ''), '\s', '', 'g'), '');
  v_lsrc   := nullif(btrim(coalesce(e ->> 'pin_lookup_source', '')), '');
  v_note   := nullif(btrim(coalesce(e ->> 'circle_conflict_note', '')), '');
  v_pin    := regexp_replace(coalesce(o.shipping_address ->> 'postal_code', ''), '\D', '', 'g');
  v_okey   := public.indian_state_key(o.shipping_address ->> 'state');
  -- Advisory only: recorded with the decision, never a State by itself.
  if lower(btrim(coalesce(o.shipping_address ->> 'country', 'india'))) in ('india', 'in', '') then
    v_circle := public.indian_pin_circle_states(v_pin);
    v_check  := case when cardinality(v_circle) = 0 then 'no_circle'
                     when v_okey = any (v_circle) then 'consistent'
                     else 'not_covered' end;
  end if;
  if e ? 'published_rate_inr' and jsonb_typeof(e -> 'published_rate_inr') = 'number' then
    v_rate := (e ->> 'published_rate_inr')::numeric::integer;
  end if;
  if e ? 'courier_cost_estimate_inr' and jsonb_typeof(e -> 'courier_cost_estimate_inr') = 'number' then
    v_cost := (e ->> 'courier_cost_estimate_inr')::numeric::integer;
  end if;
  foreach b in array array['pin_verified', 'state_city_verified', 'serviceable', 'cost_difference_reviewed', 'listed_exclusion_overridden'] loop
    -- JSON null = not answered (a refusal need not answer every question).
    if e ? b and jsonb_typeof(e -> b) not in ('boolean', 'null') then
      raise exception '% is true or false.', b using errcode = '22023';
    end if;
  end loop;

  if p_decision = 'approve' then
    if coalesce((e ->> 'pin_verified')::boolean, false) is not true then
      raise exception 'Check the corrected PIN exists (India Post PIN search) before approving.' using errcode = '22023';
    end if;
    -- WP-09B: the State comes from a lookup of the FULL PIN on the order — not
    -- from its first two digits and not from what the customer typed.
    if v_vpin is null or v_vpin is distinct from v_pin then
      raise exception 'Record the full six-digit PIN you looked up (the order''s PIN is %). A lookup of another or a partial PIN does not count.',
        v_pin using errcode = '22023';
    end if;
    if v_lsrc is null or length(v_lsrc) < 3 then
      raise exception 'Say where the State of PIN % was looked up (for example "India Post PIN search, % → district, State").',
        v_pin, v_pin using errcode = '22023';
    end if;
    if coalesce((e ->> 'state_city_verified')::boolean, false) is not true or v_state is null or v_city is null then
      raise exception 'Record the State and city the PIN belongs to, as looked up.' using errcode = '22023';
    end if;
    if v_okey = '' then
      raise exception 'The order has no State recorded, so the PIN''s State cannot be compared. Correct the address to include it (a new review opens), then review again.'
        using errcode = '55000';
    end if;
    if public.indian_state_key(v_state) is distinct from v_okey then
      raise exception 'The lookup puts PIN % in %, but the order is for %. The delivery charge, invoice and place of supply were set for %: a delivery in another State is not approved here. Refuse this review and escalate: cancel and re-order, or a separately approved correction.',
        v_pin, v_state, coalesce(o.shipping_address ->> 'state', 'no State'), coalesce(o.shipping_address ->> 'state', 'no State')
        using errcode = '55000';
    end if;
    -- The advisory table disagrees, or knows no circle: not a refusal and not
    -- a reason to cancel — the order stays held until the manual check of the
    -- full PIN is written down.
    if v_check in ('not_covered', 'no_circle') and (v_note is null or length(v_note) < 20) then
      raise exception 'PIN % could not be confirmed in % from the postal-circle table (%). That table is rough, so this is not a refusal: the order stays held. Verify the full PIN''s State manually (the India Post office record for %, or the courier) and write what you checked as the manual verification note (at least 20 characters). If it is in another State, refuse and escalate instead.',
        v_pin, coalesce(o.shipping_address ->> 'state', 'no State'),
        case when v_check = 'no_circle' then 'no circle known for prefix ' || left(v_pin, 2)
             else 'prefix ' || left(v_pin, 2) || ' is usually ' || array_to_string(v_circle, ' / ') end,
        v_pin using errcode = '55000';
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
         verified_pin = left(v_vpin, 12), pin_lookup_source = left(v_lsrc, 300),
         circle_check = v_check, circle_conflict_note = left(v_note, 1000),
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
  -- Invoices before 0079 were all drawn with the v1 seller block (constant in
  -- code since invoicing began), labelled as such — not as captured at issue.
  v_issuer jsonb := public.invoice_issuer_at('-infinity');
  v_tax_flag text;
  v_flagged int := 0;
begin
  for o in select * from orders where invoice_number is not null order by invoice_issued_at nulls first, id loop
    v_name := o.customer_name; v_phone := o.customer_phone; v_addr := o.shipping_address;
    v_src := 'row_at_migration'; n := 0;
    v_note := 'Order row as found when 0079 was applied. Before 0078 these details could be edited without a record, so they are not proven to be what was issued.';
    -- Nothing in the app writes orders.tax and the seller is not registered,
    -- so it should be empty. If it is not, keep it exactly as found (it is in
    -- document.tax; nothing is printed for an unregistered seller) and flag it.
    v_tax_flag := null;
    if o.tax is not null and jsonb_typeof(o.tax) <> 'null' and o.tax not in ('[]'::jsonb, '{}'::jsonb) then
      v_tax_flag := ' ACCOUNTANT REVIEW: orders.tax held a value when 0079 was applied (kept unchanged in document.tax; not printed: the seller was not GST-registered).';
      v_flagged := v_flagged + 1;
    end if;
    if o.customer_email is null and o.customer_name is null and o.customer_phone is null and o.shipping_address is null then
      insert into order_invoice_snapshots (order_id, invoice_number, invoice_issued_at, order_created_at,
                                           document, source, provenance_note, issuer, issuer_source)
      values (o.id, o.invoice_number, o.invoice_issued_at, o.created_at, public.order_invoice_document(o),
              'row_at_migration', 'Customer details were already erased (account deletion) before 0079; none retained.' || coalesce(v_tax_flag, ''),
              v_issuer, 'code_history_at_migration');
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
                                         document, source, provenance_note, issuer, issuer_source)
    values (o.id, o.invoice_number, o.invoice_issued_at, o.created_at, v_name, o.customer_email, v_phone, v_addr,
            public.order_invoice_document(o), v_src, v_note || coalesce(v_tax_flag, ''), v_issuer, 'code_history_at_migration');
  end loop;
  if v_flagged > 0 then
    raise notice '0079: % invoiced order(s) had a value in orders.tax — flagged for accountant review, unchanged.', v_flagged;
  end if;
  -- Credit notes issued before 0079: the same v1 seller block, same label.
  insert into credit_note_issuer_snapshots (credit_note_id, credit_note_number, issuer, issuer_source)
  select cn.id, cn.credit_note_number, v_issuer, 'code_history_at_migration' from credit_notes cn;
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
  if exists (select 1 from credit_notes cn
              where not exists (select 1 from credit_note_issuer_snapshots s where s.credit_note_id = cn.id)) then
    raise exception '0079 self-check: a credit note has no seller snapshot.';
  end if;
  if (select count(*) from invoice_issuer_profiles) <> 1
     or exists (select 1 from invoice_issuer_profiles where gst_registration <> 'unregistered' or gstin is not null) then
    raise exception '0079 self-check: the seller profile is not the single unregistered v1.';
  end if;
  foreach r in array array['authenticated', 'service_role', 'anon'] loop
    if has_table_privilege(r, 'public.invoice_issuer_profiles', 'SELECT')
       or has_table_privilege(r, 'public.invoice_issuer_profiles', 'INSERT')
       or has_table_privilege(r, 'public.credit_note_issuer_snapshots', 'INSERT')
       or has_table_privilege(r, 'public.credit_note_issuer_snapshots', 'UPDATE')
       or has_table_privilege(r, 'public.credit_note_issuer_snapshots', 'DELETE')
       or has_table_privilege(r, 'public.financial_record_retention_rules', 'SELECT')
       or has_table_privilege(r, 'public.financial_record_retention_rules', 'INSERT')
       or has_table_privilege(r, 'public.sealed_record_access_log', 'SELECT')
       or has_table_privilege(r, 'public.sealed_record_access_log', 'INSERT')
       or has_table_privilege(r, 'public.sealed_record_purge_log', 'SELECT')
       or has_table_privilege(r, 'public.sealed_record_purge_log', 'INSERT')
       or has_table_privilege(r, 'public.order_invoice_sealed_parties', 'DELETE')
       or has_function_privilege(r, 'public.owner_read_sealed_invoice_party(uuid, text, text)', 'EXECUTE')
       or has_function_privilege(r, 'public.owner_purge_sealed_invoice_parties(bigint, boolean)', 'EXECUTE')
       or has_function_privilege(r, 'public.invoice_issuer_at(timestamptz)', 'EXECUTE') then
      raise exception '0079 self-check: % can reach a seller, retention or sealed-record object.', r;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.credit_note_issuer_snapshots', 'SELECT') then
    raise exception '0079 self-check: credit-note seller snapshots are public.';
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
