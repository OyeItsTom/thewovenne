-- 0049 — A paid order cannot be cancelled without a credit note
--
-- 0045 built the right way to cancel: one function that issues the credit note,
-- puts the stock back, marks the order and records the moment, all or none.
--
-- IT DID NOT REMOVE THE WRONG WAY. The admin Orders screen kept an older
-- "Cancel this order" control that simply set status = 'cancelled' — a plain
-- UPDATE, which admins are allowed to run because they are allowed to move an
-- order along. Pressed on a paid order it produced exactly the state credit
-- notes exist to prevent:
--
--   * no credit note, so the P&L still counted the revenue in full;
--   * no stock returned, so the piece stayed sold on the count;
--   * no cancelled_at, so nothing could say when it happened;
--   * an invoice still standing for money that was being given back.
--
-- The button is gone in the same change as this migration. THAT IS NOT THE FIX,
-- it is half of it: the UPDATE is still available to anything holding an admin
-- session, and "we removed the button" is the kind of guarantee that lasts
-- until the next screen is written. So the rule is enforced here, where it
-- cannot be got round by a different caller.
--
-- WHAT IS STILL ALLOWED, deliberately:
--
--   * cancelling an UNPAID order. There is no invoice and no money, so there is
--     nothing to credit — issue_credit_note refuses these outright.
--   * cancel_order() itself. It issues the credit note BEFORE it marks the
--     order, so by the time this trigger looks, the document exists.
--
-- One thing this does NOT check is that the credit note is for the full amount.
-- A partial return credits some lines and leaves the order live; if such an
-- order is later cancelled by hand, that earlier note is enough to satisfy this
-- guard. Partial returns do not exist yet, and when they do the honest check is
-- "the credited total covers the order", which cannot be written until there is
-- something to write it against. Named here rather than left as a surprise.

create or replace function public.orders_cancel_needs_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Only the transition into cancelled is interesting. An already-cancelled
  -- order being edited for some other reason must not be re-judged.
  if new.status = 'cancelled' and coalesce(old.status, '') <> 'cancelled' then
    if new.payment_status = 'paid'
       and not exists (
         select 1 from credit_notes where order_id = new.id
       )
    then
      raise exception
        'A paid order cannot be cancelled directly. Use cancel_order(), which issues a credit note, returns the stock and records when it happened — an issued invoice is never edited or deleted.';
    end if;

    -- Stamped here rather than trusted to the caller, so the column means what
    -- 0043 says it means whichever path did the cancelling. The P&L reads it to
    -- put a cancellation in the period it happened.
    new.cancelled_at := coalesce(new.cancelled_at, now());
  end if;

  return new;
end;
$fn$;

drop trigger if exists orders_cancel_guard on orders;
create trigger orders_cancel_guard
  before update on orders
  for each row execute function public.orders_cancel_needs_credit_note();

comment on function public.orders_cancel_needs_credit_note is
  'Refuses to cancel a paid order that has no credit note against it, and
   stamps cancelled_at. See migration 0049.';

-- ── Verify ────────────────────────────────────
select
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'orders_cancel_needs_credit_note') as guard_function,
  (select count(*) from pg_trigger where tgname = 'orders_cancel_guard'
    and not tgisinternal) as guard_trigger;
