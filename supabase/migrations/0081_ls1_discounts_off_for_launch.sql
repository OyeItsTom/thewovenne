-- 0081 — LS-1: loyalty and coupons OFF for the December 2026 launch.
--
-- OWNER DECISIONS (8 Nov 2026, A–D): loyalty points, redemption and coupon
-- discounts are deferred until after launch; every existing balance, coupon,
-- redemption and order record is kept; before Live a small, reversible switch
-- must stop NEW earning, NEW redemption and NEW coupon discounts at the UI, the
-- API and the database/payment boundary.
--
-- WHAT WAS THERE BEFORE THIS.
--   * Loyalty: award_loyalty_points / redeem_loyalty_points (0029, 0077) refuse
--     unless store_settings.loyalty_enabled is true. But the flag was parsed with
--     a bare ::boolean cast, so a malformed value raised instead of answering
--     "off", and any aal2 admin could switch it on from Store settings.
--   * Coupons: no store-wide switch at all. redeem_coupon (0037) honours any
--     coupon row that is active, unexpired and not exhausted, and the checkout
--     API accepted a couponCode from any caller (the storefront never sends one,
--     but the endpoint is public).
--
-- WHAT THIS DOES.
--   1. discount_switch_on(key) — the single strict reading of the two switches:
--      true ONLY when store_settings.value holds JSON true for that key. Missing
--      row, missing key, null, "true" as text, 1, a malformed document: false.
--      It cannot raise, so an unreadable setting fails CLOSED.
--   2. loyalty_settings() reads `enabled` through it, and no longer raises on a
--      malformed number (it answers "off" with the defaults instead). The 0077
--      award and redeem functions call loyalty_settings(), so both inherit the
--      strict reading unchanged.
--   3. redeem_coupon() refuses a NEW claim while coupons are off: no counter
--      moves and no redemption row is written. A claim already recorded for the
--      order still answers true, so a replayed settlement of an old order is
--      not mistaken for a problem.
--   4. orders_discount_switch_guard: an order cannot take on a NEW coupon or
--      loyalty discount (insert, or a change to a non-zero value) while that
--      switch is off — whoever writes, service_role included. Existing values,
--      and changes back to zero/null, are untouched. The error text names none
--      of the columns the old checkout's deploy-window fallbacks look for, so
--      old code meeting this guard refuses the checkout (no money moves)
--      instead of retrying without the coupon columns.
--   5. store_settings_discount_lock: neither switch can be set to anything but
--      false (or absent) in value or draft_value. Re-enabling is therefore a
--      separately approved migration that drops this trigger — not a checkbox.
--   6. Sets loyalty_enabled = false and coupons_enabled = false in the
--      store_settings row (value and draft_value), keeping every other key. The
--      prior values are printed (NOTICE) and must also be captured read-only at
--      the release gate BEFORE this runs.
--
-- WHAT IT DOES NOT DO. Touch any loyalty_ledger, coupons, coupon_redemptions,
-- orders, invoices, credit_notes, refund_* or payment row. Reverse or expire any
-- balance. Change award/redeem_loyalty_points (0077) or settle_razorpay_payment.
-- Add GST, refunds, returns or any loyalty/coupon feature.
--
-- PENDING CHECKOUTS STARTED BEFORE THIS. A pending order whose stored total
-- already includes a discount keeps it: Razorpay holds that amount and the
-- customer was shown it. If it is paid, settlement records it at that amount
-- (settle_razorpay_payment still requires captured == stored total); the points
-- are NOT spent (redeem refuses) and the coupon use is NOT counted (redeem_coupon
-- refuses), and the application flags the order needs_review. The release gate
-- counts such rows read-only beforehand (expected 0: the storefront has never
-- sent a coupon or points).
--
-- COMPATIBILITY. Requires 0077 and 0080 (checked). Works with or without
-- 0074–0076. With OLD application code (before LS-1) the database alone keeps
-- coupon claims and order discounts refused; see the LS-1 release notes for the
-- deploy order.
--
-- ROLLBACK. proposed/0081_rollback.sql in the LS-1 report: restores the 0029
-- loyalty_settings() and 0037 redeem_coupon() bodies and drops the two triggers
-- and the helper. It never switches either flag back on. Fix-forward preferred.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ───────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.redeem_loyalty_points(uuid, integer, uuid)') is null
     or to_regprocedure('public.award_loyalty_points(uuid)') is null
     or to_regprocedure('public.loyalty_settings()') is null then
    raise exception '0081: loyalty functions (0029/0077) are missing';
  end if;
  if to_regprocedure('public.redeem_coupon(text, uuid, text, numeric)') is null then
    raise exception '0081: redeem_coupon (0037) is missing';
  end if;
  if to_regprocedure('public.settle_razorpay_payment(text, text, bigint, text, bigint, bigint, text)') is null then
    raise exception '0081: 0077 (settle_razorpay_payment) is not applied';
  end if;
  if to_regclass('public.refund_obligations') is null then
    raise exception '0081: 0080 (refund ledger) is not applied';
  end if;
  if to_regprocedure('public.discount_switch_on(text)') is not null then
    raise exception '0081: already applied; refusing to replace it';
  end if;
end $$;

-- ══ 1. The one strict reading of the switches ═══════════════════════════════
create function public.discount_switch_on(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  -- jsonb equality cannot raise, whatever the document holds.
  select p_key in ('loyalty_enabled', 'coupons_enabled')
     and coalesce(
           (select (sc.value -> p_key) = 'true'::jsonb
              from public.site_content sc
             where sc.key = 'store_settings'
               and jsonb_typeof(sc.value) = 'object'),
           false);
$fn$;

comment on function public.discount_switch_on(text) is
  'LS-1 (0081): true only when store_settings.value holds JSON true for
   loyalty_enabled / coupons_enabled. Anything else, including a missing row or
   a malformed value, is false: an unreadable switch is OFF.';
revoke execute on function public.discount_switch_on(text) from public, anon, authenticated;
grant execute on function public.discount_switch_on(text) to service_role;

-- ══ 2. loyalty_settings(): strict switch, never raises ═══════════════════════
create or replace function public.loyalty_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v   jsonb;
  num constant text := '^[0-9]+(\.[0-9]+)?$';
begin
  select sc.value into v from public.site_content sc where sc.key = 'store_settings';
  if v is null or jsonb_typeof(v) <> 'object' then
    v := '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'enabled',        public.discount_switch_on('loyalty_enabled'),
    'points_per_inr', case when (v ->> 'loyalty_points_per_inr') ~ num then (v ->> 'loyalty_points_per_inr')::numeric else 1 end,
    'inr_per_point',  case when (v ->> 'loyalty_inr_per_point')  ~ num then (v ->> 'loyalty_inr_per_point')::numeric  else 0.25 end,
    'min_redeem',     case when (v ->> 'loyalty_min_redeem') ~ '^[0-9]{1,9}$' then (v ->> 'loyalty_min_redeem')::integer else 200 end);
exception when others then
  -- Belt and braces: whatever goes wrong, the answer is "off".
  return '{"enabled": false, "points_per_inr": 1, "inr_per_point": 0.25, "min_redeem": 200}'::jsonb;
end;
$fn$;

-- ══ 3. redeem_coupon(): no new claim while coupons are off ═══════════════════
-- Same signature, so the 0037 grants (service_role only) carry over.
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
  -- Answered before the switch so a replay of an old order is not flagged.
  if exists (select 1 from coupon_redemptions where order_id = p_order_id) then
    return true;
  end if;

  -- 0081 (LS-1): no new coupon use while coupons are switched off.
  if not public.discount_switch_on('coupons_enabled') then
    return false;
  end if;

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

-- ══ 4. No order takes on a NEW discount while its switch is off ══════════════
create function public.orders_discount_switch_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  new_coupon  boolean;
  new_loyalty boolean;
begin
  -- Wording matters: it must not contain the column names the pre-LS-1
  -- checkout's missing-column fallbacks match, or old code would retry the
  -- insert without the coupon record. See the header.
  if tg_op = 'INSERT' then
    new_coupon  := new.coupon_code is not null or coalesce(new.coupon_discount_inr, 0) <> 0;
    new_loyalty := coalesce(new.loyalty_points_spent, 0) <> 0 or coalesce(new.loyalty_discount_inr, 0) <> 0;
  else
    new_coupon  := (new.coupon_code is not null and new.coupon_code is distinct from old.coupon_code)
                or (coalesce(new.coupon_discount_inr, 0) <> 0 and new.coupon_discount_inr is distinct from old.coupon_discount_inr);
    new_loyalty := (coalesce(new.loyalty_points_spent, 0) <> 0 and new.loyalty_points_spent is distinct from old.loyalty_points_spent)
                or (coalesce(new.loyalty_discount_inr, 0) <> 0 and new.loyalty_discount_inr is distinct from old.loyalty_discount_inr);
  end if;

  if new_coupon and not public.discount_switch_on('coupons_enabled') then
    raise exception 'LS-1: discount codes are switched off; this order cannot take a new discount.'
      using errcode = '55000';
  end if;
  if new_loyalty and not public.discount_switch_on('loyalty_enabled') then
    raise exception 'LS-1: loyalty points are switched off; this order cannot take a new points discount.'
      using errcode = '55000';
  end if;
  return new;
end;
$fn$;
revoke execute on function public.orders_discount_switch_guard() from public, anon, authenticated, service_role;

create trigger orders_discount_switch_guard
  before insert or update of coupon_code, coupon_discount_inr, loyalty_points_spent, loyalty_discount_inr
  on public.orders
  for each row execute function public.orders_discount_switch_guard();

-- ══ 5. The switches stay off until an approved migration says otherwise ══════
create function public.store_settings_discount_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  k   text;
  doc jsonb;
begin
  if new.key is distinct from 'store_settings' then
    return new;
  end if;
  foreach k in array array['loyalty_enabled', 'coupons_enabled'] loop
    foreach doc in array array[new.value, new.draft_value] loop
      if doc is not null and jsonb_typeof(doc) = 'object' and doc ? k
         and (doc -> k) is distinct from 'false'::jsonb then
        raise exception 'LS-1: % stays off for launch. Switching it on needs a separately approved release.', k
          using errcode = '55000';
      end if;
    end loop;
  end loop;
  return new;
end;
$fn$;
revoke execute on function public.store_settings_discount_lock() from public, anon, authenticated, service_role;

-- ══ 6. Set both switches off, keeping every other setting ════════════════════
-- Done BEFORE the lock exists only so the order of statements reads plainly;
-- writing false is allowed by the lock either way.
do $$
declare
  prior jsonb;
begin
  select jsonb_build_object(
           'value_loyalty_enabled',  sc.value -> 'loyalty_enabled',
           'value_coupons_enabled',  sc.value -> 'coupons_enabled',
           'draft_loyalty_enabled',  sc.draft_value -> 'loyalty_enabled',
           'draft_coupons_enabled',  sc.draft_value -> 'coupons_enabled')
    into prior
    from public.site_content sc where sc.key = 'store_settings';
  raise notice '0081: store_settings switches before LS-1: %', coalesce(prior::text, '(no store_settings row — both switches read as off)');

  update public.site_content
     set value       = (case when jsonb_typeof(value) = 'object' then value else '{}'::jsonb end)
                       || '{"loyalty_enabled": false, "coupons_enabled": false}'::jsonb,
         draft_value = (case when jsonb_typeof(draft_value) = 'object' then draft_value
                             when jsonb_typeof(value) = 'object' then value
                             else '{}'::jsonb end)
                       || '{"loyalty_enabled": false, "coupons_enabled": false}'::jsonb
   where key = 'store_settings';
end $$;

create trigger store_settings_discount_lock
  before insert or update on public.site_content
  for each row execute function public.store_settings_discount_lock();

-- ══ 7. Posture, for the record ═══════════════════════════════════════════════
select
  public.discount_switch_on('loyalty_enabled') as loyalty_on_must_be_false,
  public.discount_switch_on('coupons_enabled') as coupons_on_must_be_false,
  (public.loyalty_settings() ->> 'enabled')::boolean as loyalty_settings_enabled_must_be_false,
  (select count(*) from pg_trigger where tgname in ('orders_discount_switch_guard', 'store_settings_discount_lock') and not tgisinternal) as guards_must_be_2,
  has_function_privilege('authenticated', 'public.redeem_coupon(text, uuid, text, numeric)', 'EXECUTE') as admin_can_redeem_coupon_must_be_false,
  has_function_privilege('authenticated', 'public.redeem_loyalty_points(uuid, integer, uuid)', 'EXECUTE') as admin_can_redeem_points_must_be_false;
