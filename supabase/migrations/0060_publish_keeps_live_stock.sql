-- 0060 — Publishing a description must never put sold stock back on the shelf
--
-- THE BUG. An unsized product's stock lives on its PUBLISHED product_versions
-- row: reserve_stock takes a sale off that row and nothing else. A draft is a
-- copy of the published row taken when somebody opened it, so it carries the
-- stock figure from that moment. publish_one and publish_all then promote the
-- draft row wholesale, which makes the draft's old figure the live one:
--
--   published stock 1 → draft opened (stock 1) → sale (published 0)
--   → publish the name change → published stock 1 again.
--
-- No movement is written, so stock_movements stops adding up, and the piece —
-- most of this catalogue is one of a kind — can be sold a second time.
--
-- The product form made it worse in two further ways, both fixed here:
--
--   * It saved the stock it had loaded into the draft on every save, so even a
--     freshly forked draft took a stale figure from an open browser tab.
--   * For a SIZED product it saved every size's loaded quantity straight back
--     through save_product_sizes, live, the moment the form was saved. A size
--     that sold while the form was open was restocked by a description edit.
--
-- ══ THE RULE ══
--
-- Stock is operational state, not content. Drafts describe a product; they do
-- not own its inventory once it is live. So:
--
--   1. Publishing carries the LIVE stock forward onto the version it promotes.
--      A brand-new product (no published version yet) keeps the opening stock
--      its draft was given — that is the only moment a draft's figure means
--      anything.
--   2. Deliberate stock changes are made live, immediately, by functions that
--      check the figure the admin was looking at is still the figure on the
--      shelf (set_product_stock for unsized products, save_product_sizes for
--      sized ones), and record a movement.
--   3. The draft's stock column no longer counts as a pending change.
--
-- ══ THE LOCK PROTOCOL ══
--
-- Carrying stock forward is only safe if nothing can change it between the
-- read and the promotion, and a sale must not be refused because the row it
-- aimed at was archived underneath it. Every function that changes stock or
-- promotes a version therefore takes the same locks in the same order:
--
--   (1) the orders row, when there is one        FOR KEY SHARE   sale, release
--                                                FOR UPDATE      cancel_order (0045, unchanged)
--   (2) the products rows involved, by id        FOR UPDATE      publish (it may rewrite the
--                                                                unique slug, a key column)
--                                                FOR NO KEY UPDATE  every stock writer
--   (3) then the admin request claim (stock_requests, section 1), and the
--       version, size and movement rows.
--
-- Why each step is safe:
--
--   * Every lock is taken at its final strength up front. Nothing in any of
--     these functions later needs a stronger lock on a row it already holds, so
--     there is no lock upgrade to deadlock on. (publish later UPDATEs products,
--     which needs FOR UPDATE when the slug changes; it already holds that.)
--   * Products rows are always locked with ORDER BY id, so two multi-product
--     operations acquire them in the same order.
--   * The orders row comes first because the stock_movements INSERT carries a
--     foreign key to orders, which takes KEY SHARE on the order. Taking it
--     after the product lock would invert cancel_order's order (orders FOR
--     UPDATE, then release_stock's product locks) and could deadlock.
--   * Once a function holds the product lock, every other stock writer for that
--     product is queued behind it, so the version and size rows it touches next
--     can only be contended by single-statement writers (an admin saving a
--     draft through PostgREST) that hold one row and wait on nothing. No cycle.
--   * These functions are VOLATILE PL/pgSQL under READ COMMITTED, so each
--     statement after a lock wait takes a fresh snapshot: a sale that waited
--     for a publish sees the newly promoted row, not the archived one.
--
-- The loop in reserve_stock now also runs in product-then-size order; it ran in
-- whatever order GROUP BY produced, which let two multi-product orders take
-- their row locks in opposite orders.
--
-- ══ WHAT THIS DOES NOT CHANGE ══
--
-- Sale idempotency (0058's claim index and its handling), SOLD_OUT, the
-- service_role-only grants on reserve/release, cancel_order's refusal rules,
-- 0056's derivation of a sized product's total, and version history: archived
-- rows keep the stock they had.
--
-- Applied with scripts/run-migration.mjs in one transaction.

-- Applied in one transaction (scripts/run-migration.mjs). If a long-running
-- transaction holds a lock this needs, give up cleanly after 10 seconds rather
-- than queue — a DDL statement waiting in the lock queue would hold up every
-- checkout query behind it. Rerun at a quieter moment.
set local lock_timeout = '10s';

-- ══ 0. Nothing a caller creates can stand in for a real table ══
--
-- A SECURITY DEFINER function runs with its owner's rights but resolves names
-- through its search_path, and Postgres searches the caller's temporary schema
-- (pg_temp) FIRST for tables unless the path lists it explicitly. With
-- `search_path = public`, a session that can create a temporary table named
-- product_sizes changes what these functions read. That was reproduced on a
-- real engine during review: a temporary product_sizes row made 0056's
-- derivation trigger write 99 onto a live product.
--
-- Who can do that: every role holds TEMP on the database by default, but none
-- of the app's interfaces lets a caller run a CREATE — PostgREST exposes tables
-- and functions, not statements. So it is not reachable from the shop or the
-- admin today. It is still wrong for a privileged function to depend on that,
-- so every function this migration relies on, and every trigger that fires
-- inside it, now resolves names with pg_temp LAST, and the three 0056 stock
-- functions are restated with every table qualified.
--
-- `public` is the only other schema on the path, so it must not be writable by
-- the API roles either; the CREATE revoke below makes that true whatever the
-- project's defaults were. Nothing in the app creates schema objects.
revoke create on schema public from public, anon, authenticated;

create or replace function public.product_size_total(p_product_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when count(*) = 0 then null else coalesce(sum(ps.stock_quantity), 0)::integer end
    from public.product_sizes ps
   where ps.product_id = p_product_id;
$fn$;

create or replace function public.derive_version_stock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  total integer;
begin
  if new.state not in ('draft', 'published') then
    return new;
  end if;

  total := public.product_size_total(new.product_id);
  if total is not null then
    new.stock_quantity := total;
  end if;

  return new;
end;
$fn$;

create or replace function public.resync_versions_from_sizes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  pid   uuid := coalesce(new.product_id, old.product_id);
  total integer;
begin
  total := public.product_size_total(pid);

  if total is null then
    return coalesce(new, old);
  end if;

  update public.product_versions
     set stock_quantity = total
   where product_id = pid
     and state in ('draft', 'published')
     and stock_quantity is distinct from total;

  return coalesce(new, old);
end;
$fn$;

-- Everything else that runs inside a stock, publish, cancel or draft path —
-- the functions they call and the triggers their writes fire. Only the search
-- path changes; each body is exactly as its own migration left it.
alter function public.is_admin()                                        set search_path = public, pg_temp;
alter function public.log_admin_action()                                set search_path = public, pg_temp;
alter function public.record_product_path()                             set search_path = public, pg_temp;
alter function public.product_path(uuid)                                set search_path = public, pg_temp;
alter function public.require_images_to_publish()                       set search_path = public, pg_temp;
alter function public.sync_published_product_extras()                   set search_path = public, pg_temp;
alter function public.orders_cancel_needs_credit_note()                 set search_path = public, pg_temp;
alter function public.issue_credit_note(uuid, text, numeric, text, jsonb) set search_path = public, pg_temp;
alter function public.validate_publish()                                set search_path = public, pg_temp;
alter function public.ensure_product_draft(uuid)                        set search_path = public, pg_temp;
alter function public.create_product_draft()                            set search_path = public, pg_temp;
alter function public.draft_is_noop(text, uuid)                         set search_path = public, pg_temp;
alter function public.settle_draft(text, uuid)                          set search_path = public, pg_temp;
alter function public.gallery_matches(uuid, uuid)                       set search_path = public, pg_temp;
alter function public.pending_queue()                                   set search_path = public, pg_temp;
alter function public.pending_changes()                                 set search_path = public, pg_temp;
alter function public.discard_one(text, uuid, text)                     set search_path = public, pg_temp;
alter function public.discard_drafts()                                  set search_path = public, pg_temp;
alter function public.checkout_prices(uuid[])                           set search_path = public, pg_temp;

-- ══ 1. A request is claimed once, for one operation ══
--
-- An admin stock edit is an absolute figure, and an absolute figure cannot be
-- made idempotent by comparing it with what is on the shelf: "the shelf already
-- says 3" is equally true when my first attempt landed and when a sale took the
-- shelf from 4 to 3 in between. So the caller names each attempt, and the name
-- is CLAIMED — bound to the product, the operation and a digest of exactly what
-- was asked — in the same transaction as the change:
--
--   * the same name, the same request      → the answer it got the first time,
--                                            nothing changes ('already_applied');
--   * the same name, anything different     → REQUEST_ID_REUSED, nothing changes;
--   * two identical requests at once        → the primary key makes the second
--                                            wait for the first, then see its claim;
--   * a request that is refused or fails    → its claim rolls back with it, so the
--                                            name was never spent.
--
-- The movement a request writes carries the name too, so the log shows which
-- admin action produced it.
create table if not exists stock_requests (
  request_id  uuid primary key,
  product_id  uuid not null references products(id) on delete cascade,
  operation   text not null check (operation in ('set_product_stock', 'save_product_sizes')),
  digest      text not null,
  outcome     jsonb not null default '{}'::jsonb,
  actor_id    uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table stock_requests is
  'One row per admin stock request that changed or confirmed stock (0060). The
   request id is bound to its product, operation and payload digest, so a retry
   is recognised and a reused id with a different payload is refused.';

-- Written only by the two SECURITY DEFINER functions. RLS on with no policy,
-- and no grants to the API roles: nothing outside those functions needs it.
alter table stock_requests enable row level security;
revoke all on stock_requests from public, anon, authenticated;
grant select on stock_requests to service_role;

alter table stock_movements
  add column if not exists request_id uuid;

comment on column stock_movements.request_id is
  'The admin request (stock_requests) that wrote this movement. Null for
   sales, returns and anything written before 0060.';

create unique index if not exists stock_movements_one_per_request
  on stock_movements (request_id, product_id, coalesce(size_label, ''))
  where request_id is not null;

-- The movement log is written by the stock functions and nothing else. 0038
-- granted the API roles SELECT only, but a project's default privileges can
-- grant more; RLS would still refuse an insert, and this says so outright.
revoke insert, update, delete, truncate on stock_movements from public, anon, authenticated;

-- ══ 2. Draft stock is not a pending change ══
--
-- A draft of a live product no longer decides its stock, so a draft whose only
-- difference is a stale stock figure changes nothing and must not be queued,
-- counted, or kept. New products are unaffected: the queue lists them as new
-- rather than diffing them, and they are never no-ops.
create or replace function public.version_noise()
returns text[]
language sql
immutable
as $$
  select array['id', 'state', 'version', 'created_by', 'created_at',
                'published_at', 'pending_delete', 'stock_quantity']::text[];
$$;

-- ══ 3. Stock and publication cannot be written around these functions ══
--
-- product_versions is writable by admins through PostgREST, because that is how
-- drafts are saved. Without a guard that same access lets a browser:
--
--   * write stock onto the PUBLISHED row (today only by accident — a save
--     racing a publish — but an accident is all it takes);
--   * write stock into the DRAFT of a live product, which publishing now
--     ignores — so an old admin tab would appear to save a stock edit that
--     silently never happens;
--   * promote or archive a version by writing `state`, skipping publish_one's
--     locks and its carry-forward of live stock;
--   * insert a version that is already published or archived.
--
-- For the API roles (anon, authenticated) all four now raise. Inside the
-- SECURITY DEFINER functions current_user is the function's owner, so the
-- publish, stock and draft RPCs are unaffected, as is service_role. A new
-- product's draft still takes its opening stock directly — there is no shelf
-- yet — and a sized product's column is derived by 0056, so it is not judged
-- here. Deleting a version is not a stock write and is left to RLS.
create or replace function public.guard_live_stock()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.state is distinct from 'draft' then
      raise exception 'VERSION_STATE_LOCKED'
        using hint = 'Versions are created as drafts; publish_one and publish_all publish them.';
    end if;
    return new;
  end if;

  if new.state is distinct from old.state then
    raise exception 'VERSION_STATE_LOCKED'
      using hint = 'Publishing and archiving happen through publish_one and publish_all.';
  end if;

  if new.stock_quantity is distinct from old.stock_quantity
     and public.product_size_total(new.product_id) is null then
    if old.state = 'published' then
      raise exception 'LIVE_STOCK_LOCKED'
        using hint = 'Live stock changes through set_product_stock, which checks the figure you saw is still the figure on the shelf.';
    end if;
    if exists (
      select 1 from public.product_versions pub
       where pub.product_id = new.product_id and pub.state = 'published'
    ) then
      raise exception 'STOCK_IS_LIVE'
        using hint = 'This product is live: its stock is changed on the shelf with set_product_stock, not in a draft. Reload the admin.';
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists guard_live_stock on product_versions;
create trigger guard_live_stock
  before insert or update on product_versions
  for each row execute function public.guard_live_stock();

-- A trigger function is never called directly, and firing a trigger does not
-- check EXECUTE; nobody needs it.
revoke execute on function public.guard_live_stock() from public, anon, authenticated;

-- Sizes are written by save_product_sizes (0039) and nothing else in the app.
-- The direct grant let a browser bypass both the lock order and the check
-- below; it goes.
revoke insert, update, delete, truncate on product_sizes from public, anon, authenticated;

-- ══ 4. reserve_stock: same function as 0058, now in the lock order ══
create or replace function public.reserve_stock(p_items jsonb, p_order_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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

  -- Lock order (1): the order. See the header.
  if p_order_id is not null then
    perform 1 from orders where id = p_order_id for key share;
  end if;

  -- Lock order (2): every product in the order, by id. A publish of any of
  -- them either finished before this (and the rows below are the new ones) or
  -- waits until this commits.
  perform 1 from products
   where id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_items) x)
   order by id
   for no key update;

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
     order by e.product_id, case when s.has_sizes then e.label end
  loop
    if line.has_sizes and line.size_label is null then
      raise exception 'SIZE_REQUIRED:%', line.product_id;
    end if;

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

-- ══ 5. release_stock: a movement only for stock that actually moved ══
--
-- 0038's version wrote the return movement whether or not its UPDATE matched a
-- row. A size renamed or removed since the sale, a product deleted, or (before
-- this migration) a publish landing mid-cancellation all matched nothing — and
-- the log still recorded the piece as back on the shelf. Now a line that
-- matches nothing is reported back and logs nothing, and cancel_order says so.
create or replace function public.release_stock(
  p_items jsonb,
  p_order_id uuid default null,
  p_reason text default 'return'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  item       jsonb;
  p_id       uuid;
  p_label    text;
  p_qty      integer;
  has_sizes  boolean;
  affected   integer;
  given      integer := 0;
  unreturned jsonb := '[]'::jsonb;
begin
  if p_reason not in ('return', 'cancellation', 'correction', 'restock') then
    raise exception 'Unknown stock movement reason: %', p_reason;
  end if;

  if p_order_id is not null then
    perform 1 from orders where id = p_order_id for key share;
  end if;

  perform 1 from products
   where id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_items) x)
   order by id
   for no key update;

  for item in
    select x from jsonb_array_elements(p_items) x
     order by (x ->> 'id'), (x ->> 'size')
  loop
    p_id    := (item ->> 'id')::uuid;
    p_label := item ->> 'size';
    p_qty   := coalesce((item ->> 'quantity')::integer, 0);

    if p_qty <= 0 then
      raise exception 'Invalid quantity for product %', p_id;
    end if;

    select exists (select 1 from product_sizes where product_id = p_id)
      into has_sizes;

    if has_sizes then
      update product_sizes
         set stock_quantity = stock_quantity + p_qty
       where product_id = p_id and label = p_label;
    else
      update product_versions
         set stock_quantity = stock_quantity + p_qty
       where product_id = p_id and state = 'published';
    end if;
    get diagnostics affected = row_count;

    if affected = 0 then
      unreturned := unreturned || jsonb_build_array(item);
      continue;
    end if;

    insert into stock_movements (product_id, size_label, delta, reason, order_id)
    values (p_id, p_label, p_qty, p_reason, p_order_id);

    given := given + p_qty;
  end loop;

  return jsonb_build_object('released', given, 'unreturned', unreturned);
end;
$fn$;

revoke execute on function public.release_stock(jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.release_stock(jsonb, uuid, text) to service_role;

-- ══ 6. cancel_order: says which lines did not go back ══
-- Identical to 0045 except that it reads release_stock's answer. A cancellation
-- still completes when a line cannot be returned — the credit note is owed
-- either way — but it no longer claims the stock came back.
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
  stock_taken boolean;
  released    jsonb;
  missing     jsonb := '[]'::jsonb;
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
    raise exception 'That order is already cancelled';
  end if;
  if target.payment_status <> 'paid' then
    raise exception 'That order was never paid, so there is nothing to cancel';
  end if;

  select exists (
    select 1 from stock_movements
     where order_id = p_order_id and reason = 'sale'
  ) into stock_taken;

  if stock_taken then
    released := public.release_stock(target.items, p_order_id, 'cancellation');
    missing  := coalesce(released -> 'unreturned', '[]'::jsonb);
  end if;

  note := public.issue_credit_note(
    p_order_id,
    'cancellation',
    target.total_inr,
    coalesce(p_reason, 'Order cancelled'),
    target.items
  );

  update orders
     set status = 'cancelled',
         cancelled_at = now()
   where id = p_order_id;

  return jsonb_build_object(
    'credit_note', note,
    'stock_returned', stock_taken and jsonb_array_length(missing) = 0,
    'stock_unreturned', missing,
    'stock_note', case
      when not stock_taken then
        'No stock was returned: this order never decremented stock, so putting it back would have created inventory that never existed.'
      when jsonb_array_length(missing) > 0 then
        format('Stock was not returned for %s line(s): %s. Each no longer matches a live product or size, so nothing was added and nothing was logged. Check the shelf and adjust the count by hand.',
               jsonb_array_length(missing),
               (select string_agg(coalesce(m ->> 'name', m ->> 'id')
                                  || coalesce(' (' || nullif(m ->> 'size', '') || ')', ''), ', ')
                  from jsonb_array_elements(missing) m))
      else null
    end
  );
end;
$fn$;

revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant execute on function public.cancel_order(uuid, text) to authenticated, service_role;

-- ══ 7. Claiming a request ══
--
-- Shared by the two admin stock functions; see section 1. Returns NULL when
-- this call has just claimed the id (go ahead), or the first answer marked
-- 'already_applied' when the same request was already done. Anything else
-- about the id — another product, another operation, another payload — is
-- REQUEST_ID_REUSED. Called only from inside those functions, after the
-- product lock, so a concurrent duplicate waits on the primary key.
create or replace function public.claim_stock_request(
  p_request_id uuid,
  p_product_id uuid,
  p_operation text,
  p_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  prior public.stock_requests%rowtype;
begin
  insert into public.stock_requests (request_id, product_id, operation, digest, actor_id)
  values (p_request_id, p_product_id, p_operation, p_digest, auth.uid())
  on conflict (request_id) do nothing;
  if found then
    return null;
  end if;

  select * into prior from public.stock_requests where request_id = p_request_id;
  if prior.product_id is distinct from p_product_id
     or prior.operation is distinct from p_operation
     or prior.digest is distinct from p_digest then
    raise exception 'REQUEST_ID_REUSED'
      using hint = 'Each stock request needs its own id. This one was already used for a different change.';
  end if;
  return prior.outcome || jsonb_build_object('status', 'already_applied');
end;
$fn$;

revoke execute on function public.claim_stock_request(uuid, uuid, text, text) from public, anon, authenticated;

-- ══ 8. set_product_stock: the one way to change an unsized product's stock ══
--
-- Contract:
--   p_expected    the figure the admin was looking at. If the shelf no longer
--                 says that, nothing changes and STOCK_CHANGED:<live> is raised.
--   p_quantity    the new absolute figure. Never negative.
--   p_request_id  names this attempt (section 1). The same id with the same
--                 product, expected, quantity and reason returns the first
--                 answer as 'already_applied'; with anything different it is
--                 REQUEST_ID_REUSED. A refused attempt does not spend its id.
--
-- Outcomes: 'applied' (moved, movement written), 'unchanged' (expected matched
-- and was already the requested figure — nothing moved), 'already_applied', or
-- — for a product never published — 'opening_stock', which sets the draft's
-- figure (there is no shelf yet, so no movement).
--
-- The draft, if there is one, is brought to the same figure so the admin's
-- draft-merged view does not show a number the next publish would ignore.
create or replace function public.set_product_stock(
  p_product_id uuid,
  p_expected integer,
  p_quantity integer,
  p_request_id uuid,
  p_note text default null,
  p_reason text default 'correction'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  live_id  uuid;
  live_qty integer;
  replay   jsonb;
  result   jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit stock';
  end if;
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  if p_expected is null then
    raise exception 'EXPECTED_REQUIRED';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'NEGATIVE_STOCK';
  end if;
  if p_reason is null or p_reason not in ('correction', 'restock') then
    raise exception 'Unknown stock movement reason: %', p_reason;
  end if;

  perform 1 from public.products where id = p_product_id for no key update;
  if not found then
    raise exception 'No such product';
  end if;

  replay := public.claim_stock_request(
    p_request_id, p_product_id, 'set_product_stock',
    md5(concat_ws('|', p_product_id, p_expected, p_quantity, p_reason)));
  if replay is not null then
    return replay;
  end if;

  if exists (select 1 from public.product_sizes where product_id = p_product_id) then
    raise exception 'SIZED_PRODUCT'
      using hint = 'A sized product''s stock is per size: use save_product_sizes.';
  end if;

  select id, stock_quantity into live_id, live_qty
    from public.product_versions
   where product_id = p_product_id and state = 'published'
   for update;

  if not found then
    -- Never published: the only figure is the draft's opening stock.
    select id, stock_quantity into live_id, live_qty
      from public.product_versions
     where product_id = p_product_id and state = 'draft'
     for update;
    if not found then
      raise exception 'No such product';
    end if;
    if live_qty <> p_expected then
      raise exception 'STOCK_CHANGED:%', live_qty;
    end if;
    update public.product_versions set stock_quantity = p_quantity where id = live_id;
    result := jsonb_build_object('status', 'opening_stock', 'quantity', p_quantity);
  elsif live_qty <> p_expected then
    raise exception 'STOCK_CHANGED:%', live_qty;
  elsif p_quantity = live_qty then
    result := jsonb_build_object('status', 'unchanged', 'quantity', live_qty);
  else
    update public.product_versions set stock_quantity = p_quantity where id = live_id;
    update public.product_versions set stock_quantity = p_quantity
     where product_id = p_product_id and state = 'draft';
    update public.products set stock_quantity = p_quantity where id = p_product_id;

    insert into public.stock_movements
      (product_id, size_label, delta, reason, note, actor_id, request_id)
    values
      (p_product_id, null, p_quantity - live_qty, p_reason,
       coalesce(p_note, 'Edited in the admin'), auth.uid(), p_request_id);

    result := jsonb_build_object('status', 'applied', 'quantity', p_quantity,
                                 'delta', p_quantity - live_qty);
  end if;

  update public.stock_requests set outcome = result where request_id = p_request_id;
  return result;
end;
$fn$;

revoke execute on function public.set_product_stock(uuid, integer, integer, uuid, text, text) from public, anon;
grant execute on function public.set_product_stock(uuid, integer, integer, uuid, text, text) to authenticated, service_role;

-- ══ 9. save_product_sizes: only what the admin changed, and only if unchanged since ══
--
-- 0039's version upserted every size the form sent at the quantity the form
-- sent, and deleted every size it did not send. A form open across a sale
-- therefore restocked the sold size, and a form open across another admin
-- adding a size deleted it.
--
-- Each element is now one of:
--   {id?, label, stock_quantity, expected}  an existing size. When
--                                       stock_quantity equals expected the
--                                       admin did not touch the count: only the
--                                       label's casing and position are saved,
--                                       and the live count is left alone. Else
--                                       the live count must still be
--                                       `expected`, or STOCK_CHANGED.
--   {label, stock_quantity}             a new size (expected absent or null).
--                                       If the size exists after all, the admin
--                                       could not have seen its count: refused.
--   {id?, label, remove: true, expected} delete a size, only if its count is
--                                       still `expected`. Already gone is fine.
-- Sizes not mentioned are left exactly as they are.
--
-- `id`, when given, is the size row the form loaded. It must belong to
-- p_product_id and carry the same name, so a payload built for one product can
-- never reach another product's sizes; the form always sends it.
--
-- p_request_id, when given, is claimed as in section 1, over the product and
-- the whole payload.
--
-- BOUNDED COMPATIBILITY. The old 3-argument function is dropped, not kept
-- beside this one: a PostgREST call naming p_product_id and p_sizes resolves to
-- this function, so a browser still running the old admin reaches the checks
-- and is refused (EXPECTED_REQUIRED) the first time it names an existing size
-- without saying what it saw. There is no path that skips them.
drop function if exists public.save_product_sizes(uuid, jsonb, text);

create or replace function public.save_product_sizes(
  p_product_id uuid,
  p_sizes jsonb,
  p_note text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  item      jsonb;
  v_id      uuid;
  v_row_id  uuid;
  v_row     text;
  v_label   text;
  v_qty     integer;
  v_expect  integer;
  v_remove  boolean;
  v_live    integer;
  v_found   boolean;
  v_sort    integer := 0;
  v_logged  integer := 0;
  v_saved   integer := 0;
  seen      text[] := array[]::text[];
  replay    jsonb;
  result    jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit stock';
  end if;

  perform 1 from public.products where id = p_product_id for no key update;
  if not found then
    raise exception 'No such product';
  end if;

  if p_request_id is not null then
    replay := public.claim_stock_request(
      p_request_id, p_product_id, 'save_product_sizes',
      md5(p_product_id::text || '|' || coalesce(p_sizes, '[]'::jsonb)::text));
    if replay is not null then
      return replay;
    end if;
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_sizes, '[]'::jsonb)) loop
    v_label  := btrim(coalesce(item ->> 'label', ''));
    v_remove := coalesce((item ->> 'remove')::boolean, false);
    v_expect := (item ->> 'expected')::integer;
    v_qty    := (item ->> 'stock_quantity')::integer;
    v_id     := nullif(item ->> 'id', '')::uuid;

    if v_label = '' then
      continue;
    end if;

    if lower(v_label) = any(seen) then
      raise exception 'DUPLICATE_SIZE:%', v_label;
    end if;
    seen := seen || lower(v_label);

    if not v_remove and (v_qty is null or v_qty < 0) then
      raise exception 'NEGATIVE_STOCK:%', v_label;
    end if;

    if v_id is not null then
      select id, label, stock_quantity into v_row_id, v_row, v_live
        from public.product_sizes
       where id = v_id and product_id = p_product_id
       for update;
      v_found := found;
      if v_found and lower(v_row) <> lower(v_label) then
        raise exception 'SIZE_MISMATCH:%', v_label;
      end if;
    else
      select id, label, stock_quantity into v_row_id, v_row, v_live
        from public.product_sizes
       where product_id = p_product_id and lower(label) = lower(v_label)
       for update;
      v_found := found;
    end if;

    if v_remove then
      if not v_found then
        continue;
      end if;
      if v_expect is null or v_live <> v_expect then
        raise exception 'STOCK_CHANGED:%:%', v_label, v_live;
      end if;
      if v_live <> 0 then
        insert into public.stock_movements (product_id, size_label, delta, reason, note, actor_id, request_id)
        values (p_product_id, v_label, -v_live, 'correction',
                coalesce(p_note, 'Size removed in the product form'), auth.uid(), p_request_id);
        v_logged := v_logged + 1;
      end if;
      delete from public.product_sizes where id = v_row_id;
      continue;
    end if;

    if v_found then
      if v_expect is null then
        raise exception 'EXPECTED_REQUIRED:%', v_label;
      end if;

      if v_qty = v_expect then
        -- The admin did not touch this count. Save the label and position only.
        update public.product_sizes
           set label = v_label, sort_order = v_sort
         where id = v_row_id;
      else
        if v_live <> v_expect then
          raise exception 'STOCK_CHANGED:%:%', v_label, v_live;
        end if;
        update public.product_sizes
           set stock_quantity = v_qty, label = v_label, sort_order = v_sort
         where id = v_row_id;
        insert into public.stock_movements (product_id, size_label, delta, reason, note, actor_id, request_id)
        values (p_product_id, v_label, v_qty - v_live, 'correction',
                coalesce(p_note, 'Edited in the product form'), auth.uid(), p_request_id);
        v_logged := v_logged + 1;
      end if;
    else
      if v_expect is not null or v_id is not null then
        -- The admin saw this size, and it has since been removed (or it was
        -- never this product's size at all).
        raise exception 'STOCK_CHANGED:%:gone', v_label;
      end if;
      insert into public.product_sizes (product_id, label, stock_quantity, sort_order)
      values (p_product_id, v_label, v_qty, v_sort);
      if v_qty > 0 then
        insert into public.stock_movements (product_id, size_label, delta, reason, note, actor_id, request_id)
        values (p_product_id, v_label, v_qty, 'restock',
                coalesce(p_note, 'Size added in the product form'), auth.uid(), p_request_id);
        v_logged := v_logged + 1;
      end if;
    end if;

    v_sort  := v_sort + 1;
    v_saved := v_saved + 1;
  end loop;

  result := jsonb_build_object('status', 'applied', 'saved', v_saved, 'logged', v_logged);
  if p_request_id is not null then
    update public.stock_requests set outcome = result where request_id = p_request_id;
  end if;
  return result;
end;
$fn$;

revoke execute on function public.save_product_sizes(uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.save_product_sizes(uuid, jsonb, text, uuid) to authenticated, service_role;

-- ══ 10. publish_one: carry the live stock forward ══
-- Only the product branch changes; the others are restated from 0018 as they
-- were, because a function is replaced whole.
create or replace function public.publish_one(p_kind text, p_id uuid, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d        record;
  live_qty integer;
begin
  if not public.is_admin() then
    raise exception 'Only admins can publish';
  end if;

  if p_kind = 'product' then
    -- Lock order (2), then the version rows. From here until commit no sale,
    -- cancellation or stock edit can change this product's stock.
    perform 1 from products where id = p_id for update;

    select * into d from product_versions
     where product_id = p_id and state = 'draft'
     for update;
    if not found then raise exception 'Nothing pending for that product'; end if;

    if not d.pending_delete then
      if d.name = '' or d.slug = '' then
        raise exception 'This product is missing its name or web address.';
      end if;
      if d.category_id is not null and not exists (
        select 1 from category_versions cv
         where cv.category_id = d.category_id and cv.state = 'published'
      ) then
        raise exception 'Publish its category first — "%" is in a category that is not live yet.', d.name;
      end if;

      select stock_quantity into live_qty
        from product_versions
       where product_id = p_id and state = 'published'
       for update;

      -- A live product keeps its live stock. A new one keeps its opening stock.
      -- (For a sized product 0056's trigger re-derives the figure from its
      -- sizes on this write and again on promotion, so this is a no-op there.)
      if found then
        update product_versions set stock_quantity = live_qty where id = d.id;
        select * into d from product_versions where id = d.id;
      end if;

      update products p
         set name = d.name, slug = d.slug, description = d.description,
             price_inr = d.price_inr, category_id = d.category_id, fabric = d.fabric,
             colour = d.colour, stock_quantity = d.stock_quantity,
             image_url = d.image_url, is_active = d.is_active
       where p.id = p_id;
      update product_versions set state = 'archived'
       where product_id = p_id and state = 'published';
      update product_versions set state = 'published', published_at = now()
       where id = d.id;
    else
      delete from products where id = p_id;
    end if;

  elsif p_kind = 'category' then
    select * into d from category_versions where category_id = p_id and state = 'draft';
    if not found then raise exception 'Nothing pending for that category'; end if;

    if not d.pending_delete then
      update categories c
         set name = d.name, slug = d.slug, parent_id = d.parent_id,
             is_visible = d.is_visible, sort_order = d.sort_order
       where c.id = p_id;
      update category_versions set state = 'archived'
       where category_id = p_id and state = 'published';
      update category_versions set state = 'published', published_at = now()
       where id = d.id;
    else
      delete from categories where id = p_id;
    end if;

  elsif p_kind = 'journal' then
    select * into d from journal_versions where journal_id = p_id and state = 'draft';
    if not found then raise exception 'Nothing pending for that post'; end if;

    if not d.pending_delete then
      update journal_posts j
         set title = d.title, slug = d.slug, body = d.body,
             image_url = d.image_url, published = d.published
       where j.id = p_id;
      update journal_versions set state = 'archived'
       where journal_id = p_id and state = 'published';
      update journal_versions set state = 'published', published_at = now()
       where id = d.id;
    else
      delete from journal_posts where id = p_id;
    end if;

  elsif p_kind = 'page' then
    select * into d from site_page_versions where page_id = p_id and state = 'draft';
    if not found then raise exception 'Nothing pending for that page'; end if;

    if not d.pending_delete then
      update site_page_versions set state = 'archived'
       where page_id = p_id and state = 'published';
      update site_page_versions set state = 'published', published_at = now()
       where id = d.id;
    else
      delete from site_pages where id = p_id;
    end if;

  elsif p_kind = 'content' then
    update site_content set value = draft_value, updated_at = now()
     where key = p_key and draft_value is not null;

  else
    raise exception 'Unknown kind %', p_kind;
  end if;

  return jsonb_build_object('kind', p_kind, 'published', 1);
end;
$$;

revoke execute on function public.publish_one(text, uuid, text) from public, anon;
grant execute on function public.publish_one(text, uuid, text) to authenticated;

-- ══ 11. publish_all: the same, for every product at once ══
-- Restated from 0015. The product section now works on a fixed set: the
-- products that had drafts when their locks were taken, locked by id. A draft
-- opened for another product while this runs is left for the next publish
-- rather than promoted unlocked.
create or replace function public.publish_all()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  problem      text;
  locked       uuid[];
  n_products   integer := 0;
  n_categories integer := 0;
  n_journal    integer := 0;
  n_content    integer := 0;
  n_pages      integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Only admins can publish';
  end if;

  -- Lock order (2): every product with a draft, by id, before anything is
  -- validated or written, so what is checked is what gets published.
  with l as (
    select p.id from products p
     where p.id in (select product_id from product_versions where state = 'draft')
     order by p.id
     for update
  ) select coalesce(array_agg(id), '{}') into locked from l;

  perform 1 from product_versions
   where product_id = any(locked) and state in ('draft', 'published')
   order by product_id, state
   for update;

  problem := public.validate_publish();
  if problem is not null then
    raise exception '%', problem;
  end if;

  update categories c
     set name = d.name, slug = d.slug, parent_id = d.parent_id,
         is_visible = d.is_visible, sort_order = d.sort_order
    from category_versions d
   where d.category_id = c.id and d.state = 'draft' and not d.pending_delete;
  update category_versions set state = 'archived'
   where state = 'published'
     and category_id in (select category_id from category_versions where state = 'draft');
  with promoted as (
    update category_versions set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete returning 1
  ) select count(*) into n_categories from promoted;
  delete from categories
   where id in (select category_id from category_versions where state = 'draft' and pending_delete);

  -- Live stock forward onto each draft of a live product. New products keep
  -- their opening stock; sized products are re-derived by 0056 either way.
  update product_versions d
     set stock_quantity = pub.stock_quantity
    from product_versions pub
   where d.product_id = any(locked)
     and d.state = 'draft' and not d.pending_delete
     and pub.product_id = d.product_id and pub.state = 'published'
     and d.stock_quantity is distinct from pub.stock_quantity;

  update products p
     set name = d.name, slug = d.slug, description = d.description,
         price_inr = d.price_inr, category_id = d.category_id, fabric = d.fabric,
         colour = d.colour, stock_quantity = d.stock_quantity,
         image_url = d.image_url, is_active = d.is_active
    from product_versions d
   where d.product_id = p.id and d.product_id = any(locked)
     and d.state = 'draft' and not d.pending_delete;
  update product_versions set state = 'archived'
   where state = 'published'
     and product_id = any(locked)
     and product_id in (select product_id from product_versions where state = 'draft');
  with promoted as (
    update product_versions set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete and product_id = any(locked)
    returning 1
  ) select count(*) into n_products from promoted;
  delete from products
   where id = any(locked)
     and id in (select product_id from product_versions where state = 'draft' and pending_delete);

  update journal_posts j
     set title = d.title, slug = d.slug, body = d.body,
         image_url = d.image_url, published = d.published
    from journal_versions d
   where d.journal_id = j.id and d.state = 'draft' and not d.pending_delete;
  update journal_versions set state = 'archived'
   where state = 'published'
     and journal_id in (select journal_id from journal_versions where state = 'draft');
  with promoted as (
    update journal_versions set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete returning 1
  ) select count(*) into n_journal from promoted;
  delete from journal_posts
   where id in (select journal_id from journal_versions where state = 'draft' and pending_delete);

  update site_page_versions set state = 'archived'
   where state = 'published'
     and page_id in (select page_id from site_page_versions where state = 'draft');
  with promoted as (
    update site_page_versions set state = 'published', published_at = now()
     where state = 'draft' and not pending_delete returning 1
  ) select count(*) into n_pages from promoted;
  delete from site_pages
   where id in (select page_id from site_page_versions where state = 'draft' and pending_delete);

  with updated as (
    update site_content set value = draft_value, updated_at = now()
     where draft_value is not null and draft_value is distinct from value returning 1
  ) select count(*) into n_content from updated;

  return jsonb_build_object(
    'products', n_products, 'categories', n_categories, 'journal', n_journal,
    'content', n_content, 'pages', n_pages,
    'total', n_products + n_categories + n_journal + n_content + n_pages
  );
end;
$$;

revoke execute on function public.publish_all() from public, anon;
grant execute on function public.publish_all() to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*)::int from pg_indexes
     where indexname = 'stock_movements_one_per_request') as request_index,
  (select 'stock_quantity' = any(public.version_noise())) as draft_stock_is_noise,
  (select count(*)::int from pg_trigger
     where tgrelid = 'product_versions'::regclass and tgname = 'guard_live_stock') as live_stock_guard,
  (select has_table_privilege('authenticated', 'product_sizes', 'UPDATE')) as sizes_direct_write_must_be_false,
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'save_product_sizes') as save_sizes_overloads_must_be_1,
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'reserve_stock') as reserve_overloads_must_be_1,
  (select has_function_privilege('authenticated', 'public.reserve_stock(jsonb, uuid)', 'EXECUTE')) as reserve_authenticated_must_be_false,
  (select has_function_privilege('anon', 'public.set_product_stock(uuid, integer, integer, uuid, text, text)', 'EXECUTE')) as set_stock_anon_must_be_false,
  (select has_function_privilege('anon', 'public.publish_one(text, uuid, text)', 'EXECUTE')
       or has_function_privilege('anon', 'public.publish_all()', 'EXECUTE')) as publish_anon_must_be_false,
  (select has_function_privilege('authenticated', 'public.claim_stock_request(uuid, uuid, text, text)', 'EXECUTE')) as claim_api_must_be_false,
  (select has_table_privilege('authenticated', 'stock_movements', 'INSERT')
       or has_table_privilege('anon', 'stock_movements', 'INSERT')) as movements_api_insert_must_be_false,
  (select has_schema_privilege('authenticated', 'public', 'CREATE')
       or has_schema_privilege('anon', 'public', 'CREATE')) as api_create_on_public_must_be_false,
  -- Every function on a stock, publish, cancel or draft path resolves names
  -- with pg_temp last (section 0).
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('product_size_total', 'derive_version_stock', 'resync_versions_from_sizes',
                        'is_admin', 'log_admin_action', 'record_product_path', 'product_path',
                        'require_images_to_publish', 'sync_published_product_extras',
                        'orders_cancel_needs_credit_note', 'issue_credit_note', 'validate_publish',
                        'ensure_product_draft', 'create_product_draft', 'draft_is_noop', 'settle_draft',
                        'gallery_matches', 'pending_queue', 'pending_changes', 'discard_one',
                        'discard_drafts', 'checkout_prices', 'reserve_stock', 'release_stock',
                        'cancel_order', 'claim_stock_request', 'set_product_stock',
                        'save_product_sizes', 'publish_one', 'publish_all', 'guard_live_stock')
      and not (coalesce(p.proconfig, '{}') @> array['search_path=public, pg_temp'])) as stock_path_fns_without_pg_temp_last_must_be_0,
  -- Informational, not an error: drafts of live unsized products whose copied
  -- stock has drifted from the shelf. Before 0060 publishing them would have
  -- overwritten the shelf; now publishing ignores the figure.
  (select count(*)::int from product_versions d
     join product_versions pub on pub.product_id = d.product_id and pub.state = 'published'
    where d.state = 'draft' and d.stock_quantity is distinct from pub.stock_quantity
      and public.product_size_total(d.product_id) is null) as drafts_with_stale_stock_now_ignored;
