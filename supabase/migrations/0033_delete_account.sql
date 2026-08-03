-- 0033 — Customer account deletion
--
-- Deleting an account must not delete the shop's books. Orders are financial
-- records: they belong to the business as much as the customer, and India
-- requires them kept for years. So the account goes and the order is
-- ANONYMISED — totals, items, dates and status survive so accounting still
-- reconciles, while the name, email, phone and address are removed.
--
-- REFUSED WHILE AN ORDER IS IN FLIGHT. Stripping the address off something not
-- yet delivered would leave a parcel nobody can send and a customer nobody can
-- contact. The customer is told to wait, or to contact us — not silently
-- half-deleted.
--
-- Everything genuinely personal cascades from auth.users: profile, wishlist,
-- cart, loyalty ledger, marketing history. Points die with the account, which
-- is correct — they are not transferable and there is nobody left to spend
-- them.

create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me       uuid := auth.uid();
  my_email text;
  in_flight integer;
  anonymised integer;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'reason', 'You need to be logged in.');
  end if;

  select email into my_email from profiles where id = me;
  if my_email is null then
    return jsonb_build_object('ok', false, 'reason', 'No account found.');
  end if;

  -- An admin must not remove themselves this way. Losing an admin silently,
  -- through a customer-facing button, is how a shop ends up with nobody able to
  -- get in. Staff accounts are removed deliberately, with the script.
  if exists (select 1 from profiles where id = me and is_admin) then
    return jsonb_build_object('ok', false,
      'reason', 'Staff accounts are removed by an administrator, not from here.');
  end if;

  select count(*) into in_flight
    from orders
   where lower(customer_email) = lower(my_email)
     and payment_status = 'paid'
     and status not in ('delivered', 'cancelled');

  if in_flight > 0 then
    return jsonb_build_object(
      'ok', false,
      'in_flight', in_flight,
      'reason', format(
        'You have %s order%s still on its way. We need your address until it arrives — please try again once it has been delivered, or contact us.',
        in_flight, case when in_flight = 1 then '' else 's' end)
    );
  end if;

  -- Keep the money, lose the person.
  update orders
     set customer_email   = null,
         customer_name    = null,
         customer_phone   = null,
         shipping_address = null,
         admin_note       = coalesce(admin_note || ' · ', '')
                            || 'Customer account deleted ' || to_char(now(), 'YYYY-MM-DD')
   where lower(customer_email) = lower(my_email);
  get diagnostics anonymised = row_count;

  -- Everything personal hangs off this row and cascades with it.
  delete from auth.users where id = me;

  return jsonb_build_object('ok', true, 'orders_anonymised', anonymised);
end;
$fn$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
     and proname = 'delete_my_account') as fn_present,
  (select count(*) from profiles where not is_admin) as customer_accounts,
  (select count(*) from orders) as orders_total;
