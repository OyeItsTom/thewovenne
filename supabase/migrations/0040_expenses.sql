-- 0040 — Business expenses
--
-- The other half of a P&L. Revenue and cost of goods come from orders; nothing
-- until now recorded what the business spends to exist — courier retainers,
-- packaging, software, rent, salaries. Without these, "profit" means gross
-- margin wearing a more confident name.
--
-- ── THE DOUBLE-COUNTING TRAP ──────────────────
--
-- Shipping cost can now be recorded in TWO places, and counting both would
-- overstate costs on exactly the line most likely to be checked:
--
--   orders.courier_actual_cost_inr — what one parcel cost, per order (0038)
--   expenses, category 'shipping'  — a courier bill, in bulk
--
-- THE RULE, and the P&L in the next PR follows it: per-order courier cost is
-- authoritative for orders that have it. The shipping EXPENSE category is for
-- courier spend that cannot be attributed to a single order — a monthly
-- retainer, a pickup charge, a bulk credit top-up. If a courier invoice is
-- entered here AND its per-order costs are imported onto the orders, the
-- shipping line is counted twice.
--
-- Stated in the table comment and shown in the admin form, because a rule that
-- lives only in a migration is a rule nobody sees.
--
-- ── GST ───────────────────────────────────────
--
-- tax_inr is nullable and stays empty until registration. An expense's GST is
-- input credit, which is the whole reason it must be recorded SEPARATELY from
-- the amount rather than folded into it — netted together it cannot be
-- recovered, and by then the bills are months old.

create table if not exists expenses (
  id           uuid primary key default gen_random_uuid(),
  category     text not null check (category in (
                 'shipping', 'marketing', 'software', 'packaging',
                 'rent', 'salaries', 'misc'
               )),
  -- Whole rupees are not assumed: a software subscription is rarely round.
  amount_inr   numeric(12,2) not null check (amount_inr > 0),
  -- A DATE, not a timestamp. An expense belongs to a day and therefore to a
  -- month, a quarter and a financial year; the minute it was typed in is not
  -- an accounting fact and would only confuse a period boundary.
  incurred_on  date not null,
  description  text,
  vendor       text,
  -- Their invoice or bill number, so a row can be traced back to paper.
  reference    text,
  -- GST paid on this expense. Null until registration — see the header.
  tax_inr      numeric(12,2) check (tax_inr is null or tax_inr >= 0),
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null
);

comment on table expenses is
  'Business costs that are not cost of goods. SHIPPING: use this only for
   courier spend that cannot be attributed to one order — per-order courier
   cost belongs on orders.courier_actual_cost_inr, and entering both counts
   shipping twice.';

comment on column expenses.tax_inr is
  'GST on this expense — input credit. Kept apart from amount_inr because
   netted together it cannot be recovered at filing time.';

-- The P&L filters by date range, always.
create index if not exists expenses_incurred_idx on expenses (incurred_on desc);
create index if not exists expenses_category_idx on expenses (category, incurred_on desc);

-- ══ RLS ═══════════════════════════════════════
-- Admins only, every operation. Expenses are not customer data and there is no
-- reading role below admin that has any business seeing what the shop spends.
alter table expenses enable row level security;

drop policy if exists "Admins manage expenses" on expenses;
create policy "Admins manage expenses"
  on expenses for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on expenses to authenticated;

-- ══ Audit ═════════════════════════════════════
-- A financial record that can be edited without leaving a trace is a problem in
-- an audit, and an expense is the easiest row in the system to quietly change.
drop trigger if exists audit_expenses on expenses;
create trigger audit_expenses
  after insert or update or delete on expenses
  for each row execute function public.log_admin_action();

-- log_admin_action labels a row by name/title/key/slug. An expense has none of
-- those, so its audit entries would read as unlabelled — "something was
-- deleted" rather than "the March courier bill was deleted". Adding one more
-- fallback is additive and every existing trigger keeps behaving identically.
create or replace function public.log_admin_action()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor      uuid := auth.uid();
  actor_mail text;
  old_row    jsonb;
  new_row    jsonb;
  changed    jsonb;
  rec_id     uuid;
  label      text;
begin
  select p.email into actor_mail from public.profiles p where p.id = actor;

  if TG_OP = 'DELETE' then
    old_row := to_jsonb(OLD);
    changed := old_row;
  elsif TG_OP = 'INSERT' then
    new_row := to_jsonb(NEW);
    changed := new_row;
  else
    old_row := to_jsonb(OLD);
    new_row := to_jsonb(NEW);

    select jsonb_object_agg(k, jsonb_build_object('from', old_row -> k, 'to', new_row -> k))
      into changed
      from jsonb_object_keys(new_row) k
     where (new_row -> k) is distinct from (old_row -> k);

    if changed is null then
      return NEW;
    end if;
  end if;

  rec_id := nullif(coalesce(new_row ->> 'id', old_row ->> 'id'), '')::uuid;
  label  := coalesce(
    new_row ->> 'name',  old_row ->> 'name',
    new_row ->> 'title', old_row ->> 'title',
    new_row ->> 'key',   old_row ->> 'key',
    new_row ->> 'slug',  old_row ->> 'slug',
    -- Added in 0040 for expenses, which have no name of their own.
    new_row ->> 'description', old_row ->> 'description'
  );

  insert into public.admin_audit_log
    (actor_id, actor_email, action, table_name, record_id, record_label, changes)
  values
    (actor, actor_mail, lower(TG_OP), TG_TABLE_NAME, rec_id, label, changed);

  return coalesce(NEW, OLD);
end;
$$;

-- ══ Totals for the P&L ════════════════════════
/**
 * Expenses in a period, by category.
 *
 * A function rather than a client-side sum so the P&L, the export and any
 * future summary all agree — three places adding the same numbers up is three
 * places for them to disagree, and a P&L that disagrees with its own export is
 * worse than either.
 *
 * Inclusive of both bounds: a financial year runs 1 April to 31 March and both
 * of those days are in it.
 */
create or replace function public.expense_totals(p_from date, p_to date)
returns table (category text, total_inr numeric, tax_inr numeric, entries bigint)
language sql
security definer
stable
set search_path = public
as $$
  select e.category,
         sum(e.amount_inr)             as total_inr,
         coalesce(sum(e.tax_inr), 0)   as tax_inr,
         count(*)                      as entries
    from expenses e
   where public.is_admin()
     and e.incurred_on >= p_from
     and e.incurred_on <= p_to
   group by e.category
   order by sum(e.amount_inr) desc;
$$;

revoke execute on function public.expense_totals(date, date) from public, anon;
grant execute on function public.expense_totals(date, date) to authenticated, service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'expenses') as table_present,
  (select count(*) from pg_policies where tablename = 'expenses') as policies_present,
  (select count(*) from pg_trigger where tgname = 'audit_expenses') as audit_trigger,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'expense_totals') as totals_function,
  (select count(*) from pg_indexes
    where tablename = 'expenses') as indexes_present;
