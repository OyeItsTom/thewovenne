-- 0037 — Coupon codes, and the numbering an invoice needs
--
-- Two features, one migration, because both add columns to `orders` and
-- splitting them would mean two ALTERs on the same table in the same session
-- for no gain.
--
-- ── COUPONS ───────────────────────────────────
--
-- THE REDEMPTION COUNT IS INCREMENTED IN THE DATABASE, NOT THE APP. "First 50
-- uses" read in JavaScript and written back is a lost update waiting to happen:
-- two people paying at once both read 49 and both write 50. redeem_coupon()
-- does it in one guarded UPDATE, the same shape as reserve_stock in 0024.
--
-- IT IS INCREMENTED ON PAYMENT, NOT AT CHECKOUT. handleCreate writes a pending
-- order before the customer has paid, and counting there would let abandoned
-- payment modals burn a launch code's entire allowance. The cost is the same
-- window reserve_stock has: for a few seconds more people can be mid-payment
-- than there are uses left, so a limit can overshoot slightly. Overshooting a
-- promotion is a rounding error; refusing someone who has already paid is not.
--
-- ONE USE PER CUSTOMER IS KEYED ON EMAIL, and that is a speed bump rather than
-- a control — checkout is open to guests, so an email is all there is, and
-- plus-addressing defeats it. Said plainly here so nobody later mistakes it for
-- a guarantee.
--
-- ── INVOICES ──────────────────────────────────
--
-- A GAPLESS SEQUENTIAL SERIES, from a Postgres sequence. Not the order UUID,
-- not the Razorpay id, and not a count of rows — under GST a missing invoice
-- number is a question you have to answer, and a number derived by counting
-- changes retrospectively when a row is deleted.
--
-- Assigned when an order is PAID and never again: the number identifies a
-- financial event, so it cannot be handed out at checkout-start where most of
-- them would belong to orders that were abandoned.
--
-- GST IS NOT ENABLED. The shop is not registered yet. What this adds is the
-- SHAPE the data will need — an hsn_code per product and a tax block per order
-- — so registering later is populating fields rather than migrating live
-- financial records. Both are nullable and both stay empty until then.

-- ══ Coupons ═══════════════════════════════════

create table if not exists coupons (
  id              uuid primary key default gen_random_uuid(),
  -- Stored uppercase and compared uppercase. "launch10" and "LAUNCH10" are the
  -- same promotion, and a customer who types it in lower case has not made a
  -- mistake worth an error message.
  code            text not null unique check (code = upper(code) and length(btrim(code)) between 3 and 32),
  -- 'percent' takes 1-100; 'flat' takes rupees off the goods subtotal.
  discount_type   text not null check (discount_type in ('percent', 'flat')),
  discount_value  numeric(10,2) not null check (discount_value > 0),
  -- Optional qualifying threshold, on the goods subtotal before any discount.
  min_order_inr   numeric(10,2) check (min_order_inr is null or min_order_inr >= 0),
  -- Optional. Null means no expiry; the check is inclusive of the moment.
  expires_at      timestamptz,
  -- Optional cap on total redemptions. Null means unlimited.
  max_uses        integer check (max_uses is null or max_uses > 0),
  -- Redemptions so far. Only ever moved by redeem_coupon().
  times_used      integer not null default 0 check (times_used >= 0),
  -- One redemption per email address, ever.
  once_per_customer boolean not null default false,
  -- An admin can pull a code without deleting it, so the orders that used it
  -- keep pointing at something that explains itself.
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null
);

comment on table coupons is
  'Promotional codes. times_used is maintained ONLY by redeem_coupon() — never
   write it from the application, or concurrent checkouts will lose updates.';

-- A percentage over 100 is not a discount, it is a refund with extra steps.
alter table coupons drop constraint if exists coupons_percent_range;
alter table coupons add constraint coupons_percent_range
  check (discount_type <> 'percent' or discount_value <= 100);

create index if not exists coupons_active_idx on coupons (code) where is_active;

-- Which order used which code. A separate table rather than only a column on
-- orders, because "has this email used this code before?" is the question
-- once_per_customer has to answer, and it must stay answerable after an admin
-- edits or deletes the coupon.
create table if not exists coupon_redemptions (
  id            uuid primary key default gen_random_uuid(),
  coupon_id     uuid not null references coupons(id) on delete cascade,
  -- The code as text too: if the coupon row is ever removed, the order history
  -- still says what was used.
  code          text not null,
  order_id      uuid references orders(id) on delete set null,
  customer_email text not null,
  discount_inr  numeric(10,2) not null check (discount_inr >= 0),
  redeemed_at   timestamptz not null default now()
);

create index if not exists coupon_redemptions_coupon_idx on coupon_redemptions (coupon_id);
create index if not exists coupon_redemptions_email_idx on coupon_redemptions (lower(customer_email));
-- One redemption per order, so a retried payment verification cannot count twice.
create unique index if not exists coupon_redemptions_one_per_order
  on coupon_redemptions (order_id) where order_id is not null;

-- ══ Order columns ═════════════════════════════

alter table orders
  add column if not exists coupon_code text,
  add column if not exists coupon_discount_inr numeric(10,2) not null default 0,
  add column if not exists invoice_number text unique,
  add column if not exists invoice_issued_at timestamptz,
  -- Empty until GST registration. Shaped as a block rather than columns so the
  -- CGST/SGST/IGST split, the rate and the place of supply can arrive together
  -- without another migration against live financial rows.
  add column if not exists tax jsonb;

comment on column orders.coupon_discount_inr is
  'Rupees taken off the goods subtotal by a coupon. total_inr is already net of
   this — it is kept separately so an invoice can show the line.';

comment on column orders.invoice_number is
  'WOV-YYYY-NNNN. Assigned once, when the order is first marked paid.';

-- ══ Invoice numbering ═════════════════════════

create sequence if not exists invoice_number_seq start with 1;

/**
 * Assign this order its invoice number, if it does not have one.
 *
 * Idempotent BY DESIGN. Payment verification can be retried — the Razorpay
 * handler already guards stock and loyalty the same way — and an order that
 * collected a second invoice number would have two identities in the books.
 * Returns the existing number unchanged on a second call.
 */
create or replace function public.assign_invoice_number(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  existing text;
  issued   text;
begin
  select invoice_number into existing from orders where id = p_order_id;
  if existing is not null then
    return existing;
  end if;

  -- The year comes from the issue date, not the order date: the number is
  -- allocated at the moment of issue and the series must read in order.
  issued := 'WOV-' || to_char(now(), 'YYYY') || '-' ||
            lpad(nextval('invoice_number_seq')::text, 4, '0');

  update orders
     set invoice_number = issued,
         invoice_issued_at = now()
   where id = p_order_id
     and invoice_number is null;

  -- Lost the race to a concurrent call: use whatever landed, and let the
  -- sequence value we burned go. A gap in the SEQUENCE is invisible; a gap in
  -- the issued series is not, and this cannot produce one.
  select invoice_number into existing from orders where id = p_order_id;
  return existing;
end;
$fn$;

revoke execute on function public.assign_invoice_number(uuid) from public, anon, authenticated;
grant execute on function public.assign_invoice_number(uuid) to service_role;

-- ══ Redemption ════════════════════════════════

/**
 * Claim one use of a coupon for a paid order.
 *
 * The counter moves in a single guarded UPDATE, so concurrent callers cannot
 * both read the same count and both write it back. Returns true when the use
 * was claimed, false when the code was exhausted, withdrawn or already counted
 * for this order.
 *
 * Deliberately does NOT re-validate the discount amount. What the customer was
 * charged is settled by then — Razorpay has the money — and disagreeing with it
 * here would leave the order and the payment saying different things.
 */
create or replace function public.redeem_coupon(
  p_code text,
  p_order_id uuid,
  p_email text,
  p_discount numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target coupons%rowtype;
  claimed integer;
begin
  select * into target from coupons where code = upper(btrim(p_code));
  if not found then
    return false;
  end if;

  -- Already counted for this order — a retried verification, not a second use.
  if exists (select 1 from coupon_redemptions where order_id = p_order_id) then
    return true;
  end if;

  -- The guard lives INSIDE the update. Checking first and updating after is the
  -- lost-update bug this function exists to avoid.
  update coupons
     set times_used = times_used + 1
   where id = target.id
     and is_active
     and (expires_at is null or expires_at > now())
     and (max_uses is null or times_used < max_uses)
  returning times_used into claimed;

  if claimed is null then
    return false;
  end if;

  insert into coupon_redemptions (coupon_id, code, order_id, customer_email, discount_inr)
  values (target.id, target.code, p_order_id, lower(btrim(p_email)), greatest(p_discount, 0));

  return true;
end;
$fn$;

revoke execute on function public.redeem_coupon(text, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.redeem_coupon(text, uuid, text, numeric) to service_role;

-- ══ Products: HSN ═════════════════════════════
-- Nullable, and empty until GST registration. Added now because backfilling a
-- code onto every product later is the same work whenever it happens, whereas
-- migrating the column onto a table that by then has live order history
-- attached is not.
alter table products add column if not exists hsn_code text;
alter table product_versions add column if not exists hsn_code text;

comment on column products.hsn_code is
  'HSN code for GST invoicing. Null until the shop is GST-registered.';

-- ══ RLS ═══════════════════════════════════════
alter table coupons enable row level security;
alter table coupon_redemptions enable row level security;

-- Admins only, both tables. A customer never reads the coupon list: it would
-- hand them every unused promotion in the shop.
--
-- Validation at checkout runs through the service role in the Razorpay route,
-- which bypasses RLS — so there is no policy here granting customers a peek,
-- and there does not need to be.
drop policy if exists "Admins manage coupons" on coupons;
create policy "Admins manage coupons"
  on coupons for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read redemptions" on coupon_redemptions;
create policy "Admins read redemptions"
  on coupon_redemptions for select to authenticated
  using (public.is_admin());

grant select, insert, update, delete on coupons to authenticated;
grant select on coupon_redemptions to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name in ('coupons', 'coupon_redemptions')) as tables_present,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('assign_invoice_number', 'redeem_coupon')) as functions_present,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('coupon_code','coupon_discount_inr','invoice_number','invoice_issued_at','tax')) as order_columns,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name in ('products','product_versions')
      and column_name = 'hsn_code') as hsn_columns,
  (select count(*) from pg_policies where tablename in ('coupons','coupon_redemptions')) as policies_present,
  (select count(*) from pg_sequences where sequencename = 'invoice_number_seq') as sequence_present;
