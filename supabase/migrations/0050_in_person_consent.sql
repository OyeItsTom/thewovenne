-- 0050 — Marketing consent asked at a stall
--
-- Consent has existed since 0026 and lives on `profiles`, because that is where
-- a person with an account is. An in-person sale has no account behind it: the
-- customer is standing in front of you, and the moment to ask is now.
--
-- WHAT THIS DOES AND DOES NOT PROMISE, said here rather than left to be worked
-- out from the code:
--
--   * IT RECORDS THAT THEY SAID YES, on the order, with the moment they said it.
--     That is the fact worth keeping — under the DPDP Act consent is something
--     given, and a record of it is the only thing that makes a later send
--     defensible.
--
--   * IT MAKES THEM MARKETABLE ONLY IF THEY HAVE AN ACCOUNT. marketing_targets()
--     starts from `profiles`, deliberately, so a person with no account cannot
--     be emailed however many times they have bought something. Where an account
--     exists for that address this sets the consent on it and they join the list
--     properly; where one does not, the record sits on the order and reaches
--     nobody. The form says exactly that, because a tick that quietly does
--     nothing is worse than no tick.
--
--   * IT DOES NOT LEAK INTO A LATER SIGNUP. If they open an account next month
--     they are asked again, unticked, by handle_new_user. Inheriting a stall
--     answer into an account created later would be consent nobody could point
--     at a moment for.
--
-- NOT BACKFILLED, for the same reason 0026 was not: every existing order records
-- false, which is true — nobody was ever asked.

alter table orders
  add column if not exists marketing_consent    boolean not null default false,
  add column if not exists marketing_consent_at timestamptz;

comment on column orders.marketing_consent is
  'The customer said yes to marketing email while this sale was being taken.
   Evidence of consent, dated. It does NOT by itself make them reachable —
   marketing_targets() starts from profiles. See migration 0050.';

comment on column orders.marketing_consent_at is
  'When consent was given, which is the part that makes it consent rather than
   an assumption.';

-- ══ Recording it ══════════════════════════════
/**
 * Record consent given in person against an order, and carry it to the person's
 * account if they have one.
 *
 * ONE FUNCTION AND ONE TRANSACTION, so the order cannot end up saying they
 * consented while the account they actually get email through says otherwise.
 *
 * Returns what happened, honestly, so the screen can say whether this will
 * reach them rather than implying it.
 */
create or replace function public.record_in_person_consent(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target     orders%rowtype;
  matched    integer := 0;
  had_before boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Only admins can record consent taken in person';
  end if;

  select * into target from orders where id = p_order_id for update;
  if not found then
    raise exception 'No such order';
  end if;

  -- An address is the whole point: consent to email, with no email, is consent
  -- to nothing. Refused rather than recorded, so the row cannot claim more than
  -- it holds.
  if coalesce(trim(target.customer_email), '') = '' then
    raise exception 'That order has no email address, so there is nothing to consent to';
  end if;

  update orders
     set marketing_consent = true,
         marketing_consent_at = coalesce(marketing_consent_at, now())
   where id = p_order_id;

  -- The account, if there is one. Matched on lower-cased email, the same way
  -- 0027 keys customers, so Tom@ and tom@ are one person.
  select count(*) into matched
    from profiles
   where lower(email) = lower(trim(target.customer_email));

  if matched > 0 then
    select coalesce(bool_or(marketing_consent), false) into had_before
      from profiles
     where lower(email) = lower(trim(target.customer_email));

    -- marketing_consent_at is NOT overwritten when they had already consented.
    -- The date that matters is the first time they said yes, not the last time
    -- someone asked.
    update profiles
       set marketing_consent = true,
           marketing_consent_at = coalesce(marketing_consent_at, now())
     where lower(email) = lower(trim(target.customer_email));
  end if;

  return jsonb_build_object(
    'recorded', true,
    'account_found', matched > 0,
    'already_consented', had_before,
    -- The only field the screen should quote at the operator: whether this
    -- person can now actually be sent anything.
    'reachable', matched > 0
  );
end;
$fn$;

revoke execute on function public.record_in_person_consent(uuid) from public, anon;
grant execute on function public.record_in_person_consent(uuid) to authenticated, service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('marketing_consent', 'marketing_consent_at')) as order_columns,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'record_in_person_consent') as function_present,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'record_in_person_consent' and grantee = 'authenticated') as admin_can_record,
  (select count(*) from orders where marketing_consent) as consented_orders;
