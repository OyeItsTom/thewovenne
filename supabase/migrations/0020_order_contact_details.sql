-- 0020 — Capture who an order is for, and where it goes
--
-- Orders were recorded with no email and no address. The consequences were not
-- theoretical: an order could not be confirmed, could not be tracked, and could
-- not be SHIPPED, because nothing in the system knew where to send it. The
-- concierge's order lookup joins on customer_email, so it could never match
-- either — every "where is my order?" was guaranteed to fail.
--
-- Razorpay's own modal collects a contact and email for the payment, but those
-- belong to Razorpay and never reach this application, and it never asks for a
-- delivery address at all.
--
-- Also changes WHEN an order row appears. It is now written before payment, in
-- the pending state, and updated on success. That keeps the details even when a
-- payment is abandoned, and stops verify inserting a second row for an order
-- that already exists.

alter table orders
  add column if not exists razorpay_order_id text,
  add column if not exists customer_name     text,
  add column if not exists customer_phone    text,
  add column if not exists shipping_address  jsonb;

-- The join key between our row and Razorpay's order. Unique so a replayed
-- verify updates the same row instead of creating another.
create unique index if not exists orders_razorpay_order_id_key
  on orders (razorpay_order_id) where razorpay_order_id is not null;

-- Order lookup by email is how a customer finds their own order, and how the
-- concierge answers "where is my order?".
create index if not exists orders_customer_email_idx
  on orders (lower(customer_email));

-- ── Existing rows ─────────────────────────────
-- Orders taken before this migration genuinely have no contact details; there
-- is nothing to backfill from. Left as they are rather than invented.

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_name = 'orders'
      and column_name in ('razorpay_order_id', 'customer_name',
                          'customer_phone', 'shipping_address')) as new_columns,
  (select count(*) from orders) as orders_total,
  (select count(*) from orders where customer_email is not null) as orders_with_email;
