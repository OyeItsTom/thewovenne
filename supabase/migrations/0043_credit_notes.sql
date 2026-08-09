-- 0043 — Credit notes
--
-- An issued invoice is never edited and never deleted. That is the whole point
-- of a gapless series: a number that changes, or disappears, is a number nobody
-- can rely on — and under GST a missing invoice is a question you have to
-- answer. So a cancellation or a return does not touch the original. It issues
-- a SECOND document that references it and carries the opposite sign.
--
-- ITS OWN SEQUENCE, CN-YYYY-NNNN, separate from the invoice series. Sharing one
-- sequence would mean the invoice numbers had gaps wherever a credit note fell
-- between them, which is exactly the thing the invoice series exists to avoid.
--
-- NOT IDEMPOTENT PER ORDER, deliberately — unlike assign_invoice_number. An
-- order can be credited more than once: a partial return today and another next
-- month are two separate events and two separate documents. Idempotency here
-- would silently swallow the second one. What IS guarded is double-issuing for
-- the same cancellation, which the caller does by checking before it asks.
--
-- THE ORIGINAL INVOICE NUMBER IS COPIED ONTO THE ROW, not just referenced by
-- order_id. Orders can be anonymised when a customer exercises deletion (0033),
-- and a credit note that could no longer say which invoice it reversed would be
-- useless as a financial record.

create sequence if not exists credit_note_number_seq start with 1;

create table if not exists credit_notes (
  id                 uuid primary key default gen_random_uuid(),
  credit_note_number text not null unique,
  order_id           uuid references orders(id) on delete set null,
  -- Denormalised on purpose — see the header.
  invoice_number     text,
  kind               text not null check (kind in ('cancellation', 'return')),
  -- Positive. The sign lives in what a credit note IS, not in the number, so
  -- nothing downstream has to remember which way round it was stored.
  amount_inr         numeric(12,2) not null check (amount_inr > 0),
  reason             text,
  -- What was credited, snapshotted like an order's items. A partial return
  -- credits some lines and not others, and the document has to say which.
  items              jsonb,
  issued_at          timestamptz not null default now(),
  issued_by          uuid references auth.users(id) on delete set null
);

comment on table credit_notes is
  'Reverses part or all of an invoice. The invoice itself is never edited or
   deleted — a credit note is the only correct way to undo one.';

create index if not exists credit_notes_order_idx on credit_notes (order_id);
create index if not exists credit_notes_invoice_idx on credit_notes (invoice_number);
create index if not exists credit_notes_issued_idx on credit_notes (issued_at desc);

-- ══ Cancel and replace ════════════════════════
-- A cancelled order is not edited into the replacement. The replacement is a
-- genuinely new order with its own invoice number, and these two columns are
-- what let the admin see the pair as related without pretending they are one
-- record.
alter table orders
  add column if not exists replaces_order_id    uuid references orders(id) on delete set null,
  add column if not exists cancelled_at         timestamptz;

comment on column orders.replaces_order_id is
  'This order was created to replace a cancelled one. The two stay separate
   records with separate invoice numbers; this is only the link between them.';

comment on column orders.cancelled_at is
  'When the cancellation happened — NOT when the order was placed. The P&L
   reduces revenue in the period a cancellation occurred, so that a closed
   month cannot change retrospectively.';

create index if not exists orders_cancelled_at_idx
  on orders (cancelled_at) where cancelled_at is not null;

-- ══ Issuing ═══════════════════════════════════
/**
 * Issue a credit note against an order.
 *
 * The number is allocated inside the insert, so two admins cancelling at the
 * same moment cannot be handed the same one.
 */
create or replace function public.issue_credit_note(
  p_order_id uuid,
  p_kind text,
  p_amount numeric,
  p_reason text default null,
  p_items jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target orders%rowtype;
  number text;
  created credit_notes%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can issue a credit note';
  end if;

  select * into target from orders where id = p_order_id;
  if not found then
    raise exception 'No such order';
  end if;

  -- Crediting an order nobody paid for would put a refund document against
  -- money that never arrived.
  if target.payment_status <> 'paid' then
    raise exception 'That order was never paid, so there is nothing to credit';
  end if;

  if p_amount > target.total_inr then
    raise exception 'A credit note cannot exceed the % that was paid', target.total_inr;
  end if;

  number := 'CN-' || to_char(now(), 'YYYY') || '-' ||
            lpad(nextval('credit_note_number_seq')::text, 4, '0');

  insert into credit_notes
    (credit_note_number, order_id, invoice_number, kind, amount_inr, reason, items, issued_by)
  values
    (number, p_order_id, target.invoice_number, p_kind, p_amount, p_reason, p_items, auth.uid())
  returning * into created;

  return to_jsonb(created);
end;
$fn$;

revoke execute on function public.issue_credit_note(uuid, text, numeric, text, jsonb) from public, anon;
grant execute on function public.issue_credit_note(uuid, text, numeric, text, jsonb) to authenticated, service_role;

-- ══ RLS ═══════════════════════════════════════
alter table credit_notes enable row level security;

drop policy if exists "Admins read credit notes" on credit_notes;
create policy "Admins read credit notes"
  on credit_notes for select to authenticated using (public.is_admin());

-- A customer may read a credit note for their own order, so they can download
-- it — matched the same way 0023 matches their orders.
drop policy if exists "Customers read their own credit notes" on credit_notes;
create policy "Customers read their own credit notes"
  on credit_notes for select to authenticated
  using (exists (
    select 1 from orders o
     where o.id = credit_notes.order_id
       and lower(o.customer_email) = lower(auth.email())
  ));

grant select on credit_notes to authenticated;

-- No insert/update/delete grant to anyone: the only way a credit note comes
-- into existence is issue_credit_note(), which allocates the number. A row
-- inserted around it would break the series.

-- ══ Audit ═════════════════════════════════════
drop trigger if exists audit_credit_notes on credit_notes;
create trigger audit_credit_notes
  after insert or update or delete on credit_notes
  for each row execute function public.log_admin_action();

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'credit_notes') as table_present,
  (select count(*) from pg_sequences where sequencename = 'credit_note_number_seq') as sequence_present,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'issue_credit_note') as function_present,
  (select count(*) from pg_policies where tablename = 'credit_notes') as policies_present,
  (select count(*) from pg_trigger where tgname = 'audit_credit_notes') as audit_trigger,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('replaces_order_id', 'cancelled_at')) as order_columns;
