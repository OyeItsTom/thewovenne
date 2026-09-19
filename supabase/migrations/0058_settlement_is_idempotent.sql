-- 0058 — Settling a payment twice must change nothing the second time
--
-- A payment can be reported more than once. Today the customer's browser
-- calls back after the Razorpay modal closes; a webhook from Razorpay is the
-- next step, and Razorpay documents at-least-once delivery, retried with
-- backoff for 24 hours. Two reports of one payment — or the same report
-- replayed — are therefore normal traffic, not an error. This migration makes
-- them harmless at the database, where the concurrency actually is.
--
-- Today it is not harmless: reserve_stock decrements every time it is called,
-- and nothing stops a second confirmation email or a second loyalty
-- redemption. Each of those gets a guard below, and every guard is a database
-- object rather than an application check.
--
-- THE PATTERN IS NOT NEW HERE. 0029 already guards loyalty awards with a partial
-- unique index, and its comment says why: "a retried webhook or a
-- double-clicked verify must not pay out twice, and a partial unique index is a
-- stronger guarantee than remembering to check." That reasoning was right. It
-- was simply never extended to stock, to the redemption half of loyalty, or to
-- the email.
--
-- WHY INDEXES RATHER THAN `if already_settled then return`. A check-then-act in
-- application code has a window between the check and the act, and two
-- settlements arriving together is precisely the case this exists to survive.
-- A unique index has no window: the second writer loses, in the database,
-- under concurrency, whatever the application believes.
--
-- Applied over a direct connection by scripts/run-migration.mjs. Nothing in
-- here is read through PostgREST except the function, which service_role
-- alone may call.

-- ══ 0. Pre-flight ══
--
-- Both indexes below are unique, so either will fail on data that already
-- violates them — and the bug they close is precisely one that CREATES such
-- data. If a settlement was ever replayed before today, the duplicate rows are
-- sitting in the table right now and this migration must not apply.
--
-- Postgres' own error for that is "could not create unique index ... Key
-- (order_id, product_id, coalesce) = (...) is duplicated", which says what
-- collided but not what to do about it. This says both, and refuses before
-- anything has been changed rather than half way through.
--
-- IF THIS RAISES: the duplicates are real stock movements that double-counted a
-- sale, or real ledger rows that spent points twice. Decide per row whether the
-- stock was actually taken twice (correct it with a 'correction' movement and
-- delete the surplus 'sale' row) or whether only the record duplicated (delete
-- the surplus row). Do not widen the index to make the error go away — it is
-- reporting the bug, not causing it.
--
-- Grouped on the same expression the index uses, so what this counts is
-- exactly what the index would refuse.
do $$
declare
  dup_sales       integer;
  dup_redemptions integer;
begin
  select count(*) into dup_sales from (
    select order_id, product_id, coalesce(size_label, '') as lbl
      from stock_movements
     where reason = 'sale' and order_id is not null
     group by 1, 2, 3 having count(*) > 1
  ) d;

  select count(*) into dup_redemptions from (
    select order_id from loyalty_ledger
     where points < 0 and order_id is not null
     group by 1 having count(*) > 1
  ) d;

  if dup_sales > 0 or dup_redemptions > 0 then
    raise exception
      'Cannot apply 0058: % duplicated sale line(s) and % duplicated redemption(s) already exist. '
      'These are the double-settlements this migration exists to prevent. Resolve them first — '
      'see the comment above this block.', dup_sales, dup_redemptions;
  end if;
end $$;

-- ══ 1. One sale movement per sellable unit, per order ══
--
-- A sellable unit is a product and a size where the product has sizes, or the
-- product alone where it has none. Keyed on the unit rather than the order
-- because an order has one movement per unit and all of them are legitimate.
--
-- THE IDENTITY IS DECIDED BY reserve_stock BELOW, NOT BY ITS CALLERS. The
-- function merges whatever it is handed into one line per unit before it
-- writes anything, and it writes NULL as the size of a product that has no
-- sizes whatever label the caller used — so two calls for the same order
-- always describe the same units in the same words, and this index can tell
-- a repeat from a first attempt.
--
-- coalesce(), because NULL is the canonical size of an unsized product and two
-- NULLs do not conflict in a Postgres unique index. Without it, exactly the
-- products with no sizes would keep the bug. A real size label is never empty
-- (save_product_sizes drops blank labels and the function treats a blank as
-- NULL), so '' cannot collide with a genuine size.
--
-- Partial on reason = 'sale': a return, cancellation or correction against the
-- same order is a different, deliberate act and must stay possible. 0045's
-- cancellation path writes those, and this must not block it.
create unique index if not exists stock_movements_one_sale_per_line
  on stock_movements (order_id, product_id, coalesce(size_label, ''))
  where reason = 'sale' and order_id is not null;

-- ══ 2. One redemption per order ══
--
-- The gap 0029 left. award_loyalty_points has had
-- loyalty_ledger_one_award_per_order since the beginning; the redeem side has an
-- advisory lock and a balance check, which serialise two DIFFERENT checkouts by
-- the same customer but do nothing about the SAME order settled twice. A replay
-- would simply spend the points again, and the balance check would happily allow
-- it whenever the customer had enough left.
create unique index if not exists loyalty_ledger_one_redemption_per_order
  on loyalty_ledger (order_id) where points < 0 and order_id is not null;

-- ══ 3. One confirmation email per order ══
--
-- Not an index but the same idea: a column that can only be claimed once. The
-- sender does an UPDATE ... WHERE confirmation_sent_at IS NULL RETURNING id, so
-- whichever settlement path gets there first wins the row and sends, and the
-- other gets nothing back and stays quiet. Compare-and-set, not check-then-act.
alter table orders
  add column if not exists confirmation_sent_at timestamptz;

comment on column orders.confirmation_sent_at is
  'When the confirmation email was sent. Claimed atomically by whichever
   settlement path arrives first (browser verification today, the Razorpay
   webhook once it exists), so the customer is emailed once even though more
   than one path may run.';

-- ══ 4. Webhook events already seen ══
--
-- Razorpay documents at-least-once delivery and gives every event a unique
-- x-razorpay-event-id for exactly this purpose. Recording the id before doing
-- the work means a duplicate delivery is recognised as a duplicate even if the
-- first attempt is still in flight — the primary key does the arbitration.
--
-- Created now, ahead of the route that will write to it, so the route can land
-- as pure application code. Kept deliberately thin: an id, a type and a
-- timestamp. This is a dedupe record, not an audit log of payment data, so
-- nothing from the payload is stored here.
create table if not exists razorpay_webhook_events (
  event_id    text primary key,
  event_type  text,
  received_at timestamptz not null default now()
);

comment on table razorpay_webhook_events is
  'Razorpay x-razorpay-event-id values already processed. Razorpay retries with
   exponential backoff for 24 hours and delivers at least once, so the same event
   will arrive again; inserting the id is what makes the second arrival a no-op.';

-- RLS on with no policy, so a leaked anon key cannot enumerate payment
-- activity through PostgREST. The webhook route writes with the service key,
-- which bypasses RLS but still needs the table privilege — 0004's default
-- privileges would grant it, but a guard this important is stated, not
-- inherited.
alter table razorpay_webhook_events enable row level security;
revoke all on razorpay_webhook_events from public, anon, authenticated;
grant select, insert on razorpay_webhook_events to service_role;

-- ══ 5. reserve_stock, now idempotent ══
--
-- Same signature as 0038 — reserve_stock(jsonb, uuid default null) — so every
-- existing caller keeps compiling, and `create or replace` on the identical
-- signature replaces rather than overloads. Three changes inside:
--
-- 1. IT MERGES ITS OWN INPUT. Nothing about a caller is trusted to have
--    supplied each sellable unit once: the in-person order form can legitimately
--    list the same piece on two lines at two prices, and a request body is
--    typed by whoever sends it. So the lines are grouped to one per unit, with
--    the quantities summed, BEFORE anything is claimed or decremented. A
--    duplicate that reached the claim un-merged would be mistaken for a repeat
--    settlement and silently not taken.
--
-- 2. THE MOVEMENT ROW IS THE CLAIM. It is inserted before the stock is
--    decremented, and a unique violation on that insert means this unit has
--    already been settled for this order — so the unit is skipped entirely and
--    nothing moves. Writing the movement first is what makes it the lock rather
--    than the receipt. Two settlements arriving together do not race a check:
--    the second insert waits on the first transaction and then either conflicts
--    (the first committed) or proceeds (the first rolled back).
--
-- 3. AN UNSIZED PRODUCT HAS NO SIZE. Callers say "One Size", "", or nothing;
--    the movement records NULL, so the identity is the same whichever they said.
--    A sized product records the label exactly as matched, which is exactly as
--    the caller must have supplied it — the same rule the UPDATE applies.
--
-- The guard is per unit, not per call, so a settlement that somehow
-- half-completed finishes correctly rather than being skipped wholesale.
--
-- SOLD_OUT STILL ABORTS EVERYTHING, AND THAT INCLUDES THE CLAIMS. The exception
-- propagates out of the function, and because the whole call is one statement
-- in one transaction, every movement row and every decrement already made in
-- this call rolls back with it — the claim for the unit that was short, the
-- claims for the units before it, all of them. An order is reserved completely
-- or not at all, and a refused reservation leaves no row behind that would make
-- the retry look like a repeat. (The unique_violation handler below is a
-- subtransaction around the INSERT alone; a successful INSERT leaves that block
-- normally and is then just part of the outer transaction like any other write.)
--
-- WITHOUT p_order_id THERE IS NO IDEMPOTENCY, and there cannot be — the index
-- has nothing to key on. The default stays so 0045 and any other caller still
-- compiles; the payment path always passes one.
--
-- Returns, in pieces: `reserved` (decremented by this call) and
-- `already_reserved` (found already claimed for this order and left alone).
-- No production caller reads the body today; they act on the error alone.
create or replace function public.reserve_stock(p_items jsonb, p_order_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  line      record;
  affected  integer;
  taken     integer := 0;
  skipped   integer := 0;
  conflict  text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'reserve_stock expects a JSON array of lines';
  end if;

  -- Every line is checked on its own before any is merged: two lines of zero
  -- must not become a silent no-op, and a negative must not eat a positive.
  if exists (
    select 1 from jsonb_array_elements(p_items) x
     where coalesce((x ->> 'quantity')::integer, 0) <= 0
  ) then
    raise exception 'Invalid quantity for product %', (
      select x ->> 'id' from jsonb_array_elements(p_items) x
       where coalesce((x ->> 'quantity')::integer, 0) <= 0
       limit 1
    );
  end if;

  -- One row per sellable unit. Whether a product has sizes is decided here,
  -- from product_sizes, not from whether the caller sent a label.
  for line in
    select e.product_id,
           s.has_sizes,
           case when s.has_sizes then e.label end as size_label,
           sum(e.qty)::integer as qty
      from (
        select (x ->> 'id')::uuid                   as product_id,
               nullif(btrim(x ->> 'size'), '')      as label,
               (x ->> 'quantity')::integer          as qty
          from jsonb_array_elements(p_items) x
      ) e
      cross join lateral (
        select exists (
          select 1 from product_sizes ps where ps.product_id = e.product_id
        ) as has_sizes
      ) s
     group by e.product_id, s.has_sizes, case when s.has_sizes then e.label end
  loop
    if line.has_sizes and line.size_label is null then
      raise exception 'SIZE_REQUIRED:%', line.product_id;
    end if;

    -- The claim. If it is already taken this settlement is a repeat, and the
    -- stock below must not move again.
    --
    -- Only a collision on THE CLAIM INDEX means that. Any other unique
    -- violation on this insert — the primary key, or an index added later —
    -- is a different problem and is re-raised, because reading it as "already
    -- reserved" would quietly not take stock that was never taken. An unknown
    -- product or order fails here too, as a foreign-key violation, which this
    -- block does not catch.
    begin
      insert into stock_movements (product_id, size_label, delta, reason, order_id)
      values (line.product_id, line.size_label, -line.qty, 'sale', p_order_id);
    exception when unique_violation then
      get stacked diagnostics conflict = constraint_name;
      if conflict is distinct from 'stock_movements_one_sale_per_line' then
        raise;
      end if;
      skipped := skipped + line.qty;
      continue;
    end;

    if line.has_sizes then
      update product_sizes
         set stock_quantity = stock_quantity - line.qty
       where product_id = line.product_id
         and label = line.size_label
         and stock_quantity >= line.qty;
      get diagnostics affected = row_count;
      if affected = 0 then
        raise exception 'SOLD_OUT:%:%', line.product_id, line.size_label;
      end if;
    else
      update product_versions
         set stock_quantity = stock_quantity - line.qty
       where product_id = line.product_id
         and state = 'published'
         and stock_quantity >= line.qty;
      get diagnostics affected = row_count;
      if affected = 0 then
        raise exception 'SOLD_OUT:%:', line.product_id;
      end if;
    end if;

    taken := taken + line.qty;
  end loop;

  return jsonb_build_object('reserved', taken, 'already_reserved', skipped);
end;
$fn$;

revoke execute on function public.reserve_stock(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.reserve_stock(jsonb, uuid) to service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*)::int from pg_indexes
     where indexname = 'stock_movements_one_sale_per_line') as sale_index,
  (select count(*)::int from pg_indexes
     where indexname = 'loyalty_ledger_one_redemption_per_order') as redemption_index,
  (select count(*)::int from information_schema.columns
     where table_name = 'orders' and column_name = 'confirmation_sent_at') as confirmation_column,
  (select to_regclass('public.razorpay_webhook_events') is not null) as webhook_table,
  (select relrowsecurity from pg_class
     where oid = 'razorpay_webhook_events'::regclass) as webhook_rls_on,
  (select has_table_privilege('service_role', 'razorpay_webhook_events', 'INSERT')) as webhook_service_insert,
  (select has_table_privilege('anon', 'razorpay_webhook_events', 'SELECT')) as webhook_anon_select_must_be_false,
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'reserve_stock') as reserve_stock_overloads_must_be_1;
