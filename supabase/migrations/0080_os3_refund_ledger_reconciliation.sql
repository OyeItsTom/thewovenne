-- 0080 — OS-3 (WP-ORDER-SAFETY-10): refund ledger and payment reconciliation,
-- the launch minimum.
--
-- WHAT WAS MISSING (WP-ORDER-SAFETY-01 D9; OS-1 residual risk).
--   * A refund owed was recorded (0077 payment_refund_obligations, 0043/0078
--     credit notes) but nothing could say whether money ever went back, and
--     refund.* webhooks were ignored.
--   * A credit note, or a cancellation, was the only trace of a refund — and a
--     credit note is a tax document, not proof that money moved.
--   * A payment Razorpay captured while Wovenne's database was unreachable,
--     with the webhook's 24-hour retries exhausted, was invisible.
--
-- WHAT THIS DOES.
--   1. refund_obligations — what Wovenne owes back, one row per source:
--        unfulfilled_payment  a 0077 payment_refund_obligations row (captured
--                             after cancellation, or a second payment): the
--                             whole payment.
--        credit_note          a credit note on a paid order: its amount.
--      Created by triggers on those two tables (and backfilled once, labelled
--      origin = 'backfill_0080'). Immutable except: the Razorpay payment id may
--      be filled once for an order settled before 0077, and an admin may CLOSE
--      an obligation WITHOUT a verified refund (a Test-mode payment, or money
--      returned outside Razorpay) with a reason — recorded as a write-off of
--      what was outstanding, never as "refunded".
--   2. payment_refunds — one row per Razorpay refund id: what RAZORPAY'S API
--      said about it (amount, currency, payment, status, mode) and when it was
--      last asked. Written only by record_refund_evidence (service_role, after
--      the server fetched the refund AND its payment from Razorpay) and, for
--      the bare refund id an admin types, by admin_claim_refund — a 'claimed'
--      row that counts for nothing until it is verified. Nobody can write a
--      status or an amount; "processed" exists only as Razorpay's word.
--   3. Guards on every path: no duplicate refund id (unique), no change of a
--      verified refund's identity (payment, amount, currency, mode), status
--      moves only forward (pending → processed | failed), a contradiction
--      becomes 'uncertain' rather than overwriting, and the refunds counted
--      against a payment (pending + processed) can never exceed what the
--      payment captured — enforced under a per-payment advisory lock by a
--      trigger, whoever writes.
--   4. payment_refund_events (append-only): every obligation created, refund
--      claimed, verified, changed, contradicted or written off — who, which
--      source (admin_verify | webhook | reconciliation), from → to, evidence.
--   5. refund_notes (append-only): the admin's reconciliation notes.
--   6. payment_reconciliation_runs / _discrepancies: a bounded, read-only
--      comparison of Razorpay's captured payments with Wovenne's records,
--      resumable by checkpoint; it can only RECORD discrepancies (and flag the
--      order for review). It never settles, fulfils, refunds or edits money.
--   7. refund_ledger (view, security_invoker): per payment — owed, verified
--      refunded, pending, written off, outstanding, over-refunded, last
--      verification, open discrepancies.
--
-- WHAT IT DOES NOT DO. Create or initiate a refund (no function here can);
-- reverse loyalty or coupons (OS-4 / LS-1); returns (OS-6); change any 0077,
-- 0078 or 0079 object. No personal data is copied: an order's anonymisation or
-- deletion leaves every row here, with the Razorpay ids, intact.
--
-- COMPATIBILITY. Requires 0077, 0078 and 0079 (checked below). Works with or
-- without 0074–0076. Additive: no existing column, constraint or row changes.
--
-- ROLLBACK. proposed/0080_rollback.sql in the WP-ORDER-SAFETY-10 report —
-- guarded, refuses while any payment_refunds or payment_refund_events row
-- exists beyond the backfill (those rows are the only record of money moving).
-- Fix-forward is preferred.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ───────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.payment_refund_obligations') is null
     or to_regprocedure('public.settle_razorpay_payment(text, text, bigint, text, bigint, bigint, text)') is null then
    raise exception '0080: 0077 (settle_razorpay_payment, payment_refund_obligations) is not applied';
  end if;
  if to_regclass('public.order_events') is null
     or to_regprocedure('public.cancel_order(uuid, text)') is null
     or to_regprocedure('public.credit_notes_integrity()') is null then
    raise exception '0080: 0078 (order transitions, credit-note limits) is not applied';
  end if;
  if to_regclass('public.order_delivery_reviews') is null
     or to_regclass('public.invoice_issuer_profiles') is null
     or to_regprocedure('public.append_only_guard()') is null then
    raise exception '0080: 0079 (invoice snapshots, delivery review) is not applied';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception '0080: is_admin() does not exist';
  end if;
  if to_regclass('public.refund_obligations') is not null
     or to_regclass('public.payment_refunds') is not null then
    raise exception '0080: already applied; refusing to replace it';
  end if;
end $$;

-- ══ 1. What is owed ═════════════════════════════════════════════════════════
create table public.refund_obligations (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null check (source in ('unfulfilled_payment', 'credit_note')),
  -- payment_refund_obligations.id or credit_notes.id. Both are permanent.
  source_id           uuid not null,
  -- Set null, never cascade: the money is owed whatever happens to the order.
  order_id            uuid references public.orders(id) on delete set null,
  -- 'razorpay': the money came through Razorpay and goes back through it, so a
  -- verified Razorpay refund can settle it. 'outside_razorpay': an in-person
  -- order, or one with no Razorpay order — nothing here can verify a refund,
  -- so it can only be closed by an admin's written statement.
  channel             text not null check (channel in ('razorpay', 'outside_razorpay')),
  razorpay_order_id   text,
  -- Null only for an order settled before 0077 (no payment id was kept); filled
  -- once, by record_refund_evidence, from the payment Razorpay names.
  razorpay_payment_id text,
  amount_paise        bigint not null check (amount_paise > 0),
  currency            text not null default 'INR' check (currency = 'INR'),
  -- What the payment captured, as Wovenne knew it when the obligation arose.
  captured_paise      bigint check (captured_paise is null or captured_paise > 0),
  origin              text not null check (origin in ('recorded', 'backfill_0080')),
  created_at          timestamptz not null default now(),
  -- Closing WITHOUT a verified refund. Never means "refunded".
  closed_at           timestamptz,
  closed_by           uuid references auth.users(id) on delete set null,
  close_kind          text check (close_kind in ('test_mode_payment', 'refunded_outside_razorpay')),
  close_reason        text,
  -- What was outstanding when it was closed: the amount written off.
  written_off_paise   bigint check (written_off_paise is null or written_off_paise >= 0),
  unique (source, source_id),
  check (channel <> 'razorpay' or razorpay_order_id is not null),
  check ((closed_at is null) = (close_kind is null)
         and (closed_at is null) = (close_reason is null)
         and (closed_at is null) = (written_off_paise is null))
);
comment on table public.refund_obligations is
  'Money Wovenne owes back (0080): one row per unfulfilled payment (0077) or
   credit note. Settled only by verified Razorpay refunds (payment_refunds), or
   closed by an admin''s written statement as a write-off — never "refunded".';

create index refund_obligations_payment_idx on public.refund_obligations (razorpay_payment_id);
create index refund_obligations_rzp_order_idx on public.refund_obligations (razorpay_order_id);
create index refund_obligations_order_idx on public.refund_obligations (order_id);

-- ══ 2. What Razorpay says was refunded ══════════════════════════════════════
create table public.payment_refunds (
  id                   uuid primary key default gen_random_uuid(),
  razorpay_refund_id   text not null unique check (razorpay_refund_id ~ '^rfnd_[A-Za-z0-9]{6,40}$'),
  -- The obligation an admin recorded this refund against (claims only).
  obligation_id        uuid references public.refund_obligations(id),
  order_id             uuid references public.orders(id) on delete set null,
  razorpay_payment_id  text,
  razorpay_order_id    text,
  -- claimed    an admin typed the id; not yet confirmed by Razorpay. Counts 0.
  -- pending    Razorpay: still being processed. In flight, not refunded.
  -- processed  Razorpay: final. Counts as refunded.
  -- failed     Razorpay: did not go through. Counts 0; a new refund is needed.
  -- uncertain  Razorpay's answers contradict each other or Wovenne's records.
  --            Counts 0 and must be investigated BEFORE anyone refunds again.
  status               text not null check (status in ('claimed', 'pending', 'processed', 'failed', 'uncertain')),
  amount_paise         bigint check (amount_paise is null or amount_paise > 0),
  currency             text check (currency is null or currency = 'INR'),
  -- The payment's captured amount according to Razorpay at verification.
  payment_amount_paise bigint check (payment_amount_paise is null or payment_amount_paise > 0),
  provider_mode        text check (provider_mode is null or provider_mode in ('test', 'live')),
  -- Razorpay's own status at the last verification.
  provider_status      text check (provider_status is null or provider_status in ('pending', 'processed', 'failed')),
  provider_created_at  timestamptz,
  speed_processed      text,
  uncertain_reason     text,
  claimed_by           uuid references auth.users(id) on delete set null,
  claimed_at           timestamptz,
  first_verified_at    timestamptz,
  last_verified_at     timestamptz,
  last_verified_source text check (last_verified_source is null
                                   or last_verified_source in ('admin_verify', 'webhook', 'reconciliation')),
  processed_seen_at    timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (status <> 'claimed' or (last_verified_at is null and amount_paise is null and provider_status is null)),
  check (status not in ('pending', 'processed', 'failed')
         or (amount_paise is not null and currency is not null and razorpay_payment_id is not null
             and payment_amount_paise is not null and provider_mode is not null
             and last_verified_at is not null and provider_status = status)),
  check (status <> 'uncertain' or uncertain_reason is not null),
  check (amount_paise is null or payment_amount_paise is null or amount_paise <= payment_amount_paise)
);
comment on table public.payment_refunds is
  'One row per Razorpay refund id (0080). Amount, payment and status are what
   Razorpay''s API returned to the server (record_refund_evidence); an admin can
   only record the bare id (status claimed, counts for nothing).';

create index payment_refunds_payment_idx on public.payment_refunds (razorpay_payment_id);
create index payment_refunds_obligation_idx on public.payment_refunds (obligation_id);
create index payment_refunds_open_idx on public.payment_refunds (updated_at)
  where status in ('claimed', 'pending', 'uncertain');

-- ══ 3. Audit trail and notes ════════════════════════════════════════════════
create table public.payment_refund_events (
  id                  bigserial primary key,
  occurred_at         timestamptz not null default now(),
  action              text not null check (action in (
                        'obligation_created', 'obligation_linked', 'obligation_closed',
                        'refund_claimed', 'refund_verified', 'refund_unchanged',
                        'refund_stale_ignored', 'refund_uncertain', 'claim_linked')),
  source              text not null check (source in (
                        'trigger', 'backfill', 'admin', 'admin_verify', 'webhook', 'reconciliation')),
  -- Raw uuid, no foreign key: the trail outlives a deleted staff account.
  actor               uuid,
  obligation_id       uuid,
  payment_refund_id   uuid,
  razorpay_refund_id  text,
  razorpay_payment_id text,
  from_status         text,
  to_status           text,
  evidence            jsonb
);
create index payment_refund_events_refund_idx on public.payment_refund_events (payment_refund_id, id);
create index payment_refund_events_obligation_idx on public.payment_refund_events (obligation_id, id);

create table public.payment_reconciliation_runs (
  id               bigserial primary key,
  provider_mode    text not null check (provider_mode in ('test', 'live')),
  window_from      timestamptz not null,
  window_to        timestamptz not null,
  resumed_from     bigint references public.payment_reconciliation_runs(id),
  status           text not null default 'running' check (status in ('running', 'complete', 'incomplete', 'failed')),
  start_skip       integer not null default 0 check (start_skip >= 0),
  next_skip        integer not null default 0 check (next_skip >= 0),
  pages            integer not null default 0,
  payments_seen    integer not null default 0,
  captured_seen    integer not null default 0,
  exhausted        boolean not null default false,
  data_incomplete  boolean not null default false,
  discrepancies    integer not null default 0,
  started_by       uuid,
  started_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,
  last_error       text,
  check (window_from < window_to),
  check ((status = 'running') = (finished_at is null)),
  check (status <> 'complete' or (exhausted and not data_incomplete))
);
create unique index payment_reconciliation_one_running
  on public.payment_reconciliation_runs (provider_mode) where status = 'running';

create table public.payment_reconciliation_discrepancies (
  id                  bigserial primary key,
  kind                text not null check (kind in (
                        'captured_not_recorded',     -- captured, order known, no settlement or obligation
                        'captured_unknown_order',    -- captured, Razorpay order unknown to Wovenne
                        'amount_mismatch',           -- captured amount ≠ what Wovenne recorded
                        'refund_not_in_ledger',      -- Razorpay refunded more than the ledger knows
                        'ledger_exceeds_provider',   -- ledger counts more than Razorpay refunded
                        'refund_without_obligation', -- money went back on a payment nothing owed on
                        'refund_exceeds_obligation', -- verified refunds exceed what was owed
                        'refund_exceeds_capture',    -- would exceed the payment: not counted
                        'refund_contradiction',      -- Razorpay's answers disagree with each other
                        'refund_claim_mismatch',     -- typed id belongs to another payment
                        'refund_not_found',          -- signed event / typed id Razorpay cannot find
                        'webhook_payload_mismatch',  -- signed payload disagrees with the API
                        'refund_pending_stale',      -- pending for more than 7 days
                        'refund_claim_unverified',   -- typed id still unverified after 2 days
                        'provider_data_incomplete')),-- an item Razorpay returned without key fields
  provider_mode       text check (provider_mode is null or provider_mode in ('test', 'live')),
  razorpay_payment_id text,
  razorpay_order_id   text,
  razorpay_refund_id  text,
  order_id            uuid references public.orders(id) on delete set null,
  obligation_id       uuid references public.refund_obligations(id),
  dedupe_key          text not null,
  details             jsonb,
  latest_details      jsonb,
  -- open: needs a human. resolved: fixed (seen again → a NEW open row).
  -- accepted: understood and benign (seen again → counted on this row).
  status              text not null default 'open' check (status in ('open', 'resolved', 'accepted')),
  first_run_id        bigint references public.payment_reconciliation_runs(id),
  last_run_id         bigint references public.payment_reconciliation_runs(id),
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  times_seen          integer not null default 1 check (times_seen >= 1),
  resolved_at         timestamptz,
  resolved_by         uuid,
  resolution_note     text,
  check ((status = 'open') = (resolved_at is null)),
  check ((status = 'open') = (resolution_note is null))
);
create unique index payment_reconciliation_discrepancies_live_key
  on public.payment_reconciliation_discrepancies (dedupe_key) where status in ('open', 'accepted');
create index payment_reconciliation_discrepancies_open_idx
  on public.payment_reconciliation_discrepancies (first_seen_at) where status = 'open';
create index payment_reconciliation_discrepancies_payment_idx
  on public.payment_reconciliation_discrepancies (razorpay_payment_id);

create table public.refund_notes (
  id                bigserial primary key,
  obligation_id     uuid references public.refund_obligations(id),
  payment_refund_id uuid references public.payment_refunds(id),
  discrepancy_id    bigint references public.payment_reconciliation_discrepancies(id),
  note              text not null check (char_length(btrim(note)) between 10 and 2000),
  author            uuid,
  created_at        timestamptz not null default now(),
  check (num_nonnulls(obligation_id, payment_refund_id, discrepancy_id) >= 1)
);
create index refund_notes_obligation_idx on public.refund_notes (obligation_id, id);
create index refund_notes_discrepancy_idx on public.refund_notes (discrepancy_id, id);

-- ══ 4. Privileges: read for admins (RLS) and the server; no direct writes ══
alter table public.refund_obligations enable row level security;
alter table public.payment_refunds enable row level security;
alter table public.payment_refund_events enable row level security;
alter table public.payment_reconciliation_runs enable row level security;
alter table public.payment_reconciliation_discrepancies enable row level security;
alter table public.refund_notes enable row level security;

create policy "Admins read refund obligations ledger" on public.refund_obligations
  for select to authenticated using (public.is_admin());
create policy "Admins read payment refunds" on public.payment_refunds
  for select to authenticated using (public.is_admin());
create policy "Admins read payment refund events" on public.payment_refund_events
  for select to authenticated using (public.is_admin());
create policy "Admins read reconciliation runs" on public.payment_reconciliation_runs
  for select to authenticated using (public.is_admin());
create policy "Admins read reconciliation discrepancies" on public.payment_reconciliation_discrepancies
  for select to authenticated using (public.is_admin());
create policy "Admins read refund notes" on public.refund_notes
  for select to authenticated using (public.is_admin());

revoke all on table public.refund_obligations, public.payment_refunds, public.payment_refund_events,
  public.payment_reconciliation_runs, public.payment_reconciliation_discrepancies, public.refund_notes
  from public, anon, authenticated, service_role;
grant select on table public.refund_obligations, public.payment_refunds, public.payment_refund_events,
  public.payment_reconciliation_runs, public.payment_reconciliation_discrepancies, public.refund_notes
  to authenticated, service_role;
revoke all on sequence public.payment_refund_events_id_seq, public.payment_reconciliation_runs_id_seq,
  public.payment_reconciliation_discrepancies_id_seq, public.refund_notes_id_seq
  from public, anon, authenticated, service_role;

-- ══ 5. Guards (every path, every role) ══════════════════════════════════════
create trigger payment_refund_events_append_only
  before update or delete on public.payment_refund_events
  for each row execute function public.append_only_guard();
create trigger refund_notes_append_only
  before update or delete on public.refund_notes
  for each row execute function public.append_only_guard();

create function public.refund_obligations_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  free constant text[] := array['order_id', 'closed_by', 'razorpay_payment_id',
                                'closed_at', 'close_kind', 'close_reason', 'written_off_paise'];
begin
  if tg_op = 'DELETE' then
    raise exception 'A refund obligation is permanent. Close it with a reason instead.' using errcode = '55000';
  end if;
  if (to_jsonb(new) - free) <> (to_jsonb(old) - free) then
    raise exception 'A refund obligation''s amount, source and payment cannot be changed.' using errcode = '55000';
  end if;
  -- What a foreign key does when an order or staff account is removed.
  if new.order_id is distinct from old.order_id and new.order_id is not null then
    raise exception 'A refund obligation stays with its order.' using errcode = '55000';
  end if;
  if new.closed_by is distinct from old.closed_by
     and not (new.closed_by is null or old.closed_at is null) then
    raise exception 'Who closed a refund obligation cannot be changed.' using errcode = '55000';
  end if;
  -- A pre-0077 order's payment id may be filled once, never changed.
  if new.razorpay_payment_id is distinct from old.razorpay_payment_id
     and (old.razorpay_payment_id is not null or new.channel <> 'razorpay') then
    raise exception 'A refund obligation''s payment cannot be changed once known.' using errcode = '55000';
  end if;
  -- Closed once; a closed obligation stays closed.
  if old.closed_at is not null
     and (new.closed_at is distinct from old.closed_at or new.close_kind is distinct from old.close_kind
          or new.close_reason is distinct from old.close_reason
          or new.written_off_paise is distinct from old.written_off_paise) then
    raise exception 'A closed refund obligation cannot be reopened or edited.' using errcode = '55000';
  end if;
  return new;
end
$fn$;
revoke execute on function public.refund_obligations_guard() from public, anon, authenticated, service_role;
create trigger refund_obligations_guard
  before update or delete on public.refund_obligations
  for each row execute function public.refund_obligations_guard();

create function public.payment_refunds_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_counted bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'A recorded refund is permanent evidence.' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    if new.razorpay_refund_id is distinct from old.razorpay_refund_id
       or new.created_at is distinct from old.created_at
       or new.claimed_at is distinct from old.claimed_at
       or new.first_verified_at is distinct from old.first_verified_at and old.first_verified_at is not null
       or (new.claimed_by is distinct from old.claimed_by and new.claimed_by is not null) then
      raise exception 'A recorded refund''s identity cannot be changed.' using errcode = '55000';
    end if;
    -- Once Razorpay has said it, it stays said.
    if (old.razorpay_payment_id is not null and new.razorpay_payment_id is distinct from old.razorpay_payment_id)
       or (old.razorpay_order_id is not null and new.razorpay_order_id is distinct from old.razorpay_order_id)
       or (old.amount_paise is not null and new.amount_paise is distinct from old.amount_paise)
       or (old.currency is not null and new.currency is distinct from old.currency)
       or (old.payment_amount_paise is not null and new.payment_amount_paise is distinct from old.payment_amount_paise)
       or (old.provider_mode is not null and new.provider_mode is distinct from old.provider_mode)
       or (old.obligation_id is not null and new.obligation_id is distinct from old.obligation_id)
       or (old.processed_seen_at is not null and new.processed_seen_at is distinct from old.processed_seen_at) then
      raise exception 'Verified refund evidence cannot be changed. A contradiction is recorded as uncertain.' using errcode = '55000';
    end if;
    if new.order_id is distinct from old.order_id and new.order_id is not null and old.order_id is not null then
      raise exception 'A recorded refund stays with its order.' using errcode = '55000';
    end if;
    -- Forward only.
    if new.status is distinct from old.status and not (
         (old.status = 'claimed')
      or (old.status = 'pending'   and new.status in ('processed', 'failed', 'uncertain'))
      or (old.status = 'processed' and new.status = 'uncertain')
      or (old.status = 'failed'    and new.status = 'uncertain')
      or (old.status = 'uncertain' and new.status in ('pending', 'processed', 'failed'))) then
      raise exception 'A refund cannot move from % to %.', old.status, new.status using errcode = '55000';
    end if;
    if new.status = 'claimed' and old.status <> 'claimed' then
      raise exception 'A verified refund cannot go back to claimed.' using errcode = '55000';
    end if;
  end if;

  -- Never more counted against a payment than it captured. Serialised per
  -- payment by the same advisory lock record_refund_evidence takes.
  if new.status in ('pending', 'processed') then
    perform pg_advisory_xact_lock(hashtextextended('wovenne.refund:' || new.razorpay_payment_id, 0));
    select coalesce(sum(amount_paise), 0) into v_counted
      from payment_refunds
     where razorpay_payment_id = new.razorpay_payment_id
       and status in ('pending', 'processed')
       and id <> new.id;
    if v_counted + new.amount_paise > new.payment_amount_paise then
      raise exception 'Refunds on payment % would exceed what it captured (% + % > %).',
        new.razorpay_payment_id, v_counted, new.amount_paise, new.payment_amount_paise using errcode = '55000';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
revoke execute on function public.payment_refunds_guard() from public, anon, authenticated, service_role;
create trigger payment_refunds_guard
  before insert or update or delete on public.payment_refunds
  for each row execute function public.payment_refunds_guard();

create function public.payment_reconciliation_runs_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'A reconciliation run is permanent.' using errcode = '55000';
  end if;
  if old.status <> 'running' then
    raise exception 'A finished reconciliation run cannot be changed.' using errcode = '55000';
  end if;
  if new.provider_mode <> old.provider_mode or new.window_from <> old.window_from or new.window_to <> old.window_to
     or new.start_skip <> old.start_skip or new.started_at <> old.started_at
     or new.resumed_from is distinct from old.resumed_from or new.started_by is distinct from old.started_by then
    raise exception 'A reconciliation run''s window cannot be changed.' using errcode = '55000';
  end if;
  if new.next_skip < old.next_skip or new.pages < old.pages or new.payments_seen < old.payments_seen then
    raise exception 'A reconciliation checkpoint only moves forward.' using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
revoke execute on function public.payment_reconciliation_runs_guard() from public, anon, authenticated, service_role;
create trigger payment_reconciliation_runs_guard
  before update or delete on public.payment_reconciliation_runs
  for each row execute function public.payment_reconciliation_runs_guard();

create function public.payment_reconciliation_discrepancies_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  free constant text[] := array['latest_details', 'last_run_id', 'last_seen_at', 'times_seen', 'order_id',
                                'status', 'resolved_at', 'resolved_by', 'resolution_note'];
begin
  if tg_op = 'DELETE' then
    raise exception 'A discrepancy is permanent. Resolve it with a note.' using errcode = '55000';
  end if;
  if (to_jsonb(new) - free) <> (to_jsonb(old) - free) then
    raise exception 'A discrepancy''s evidence cannot be changed.' using errcode = '55000';
  end if;
  if new.order_id is distinct from old.order_id and new.order_id is not null then
    raise exception 'A discrepancy stays with its order.' using errcode = '55000';
  end if;
  if old.status <> 'open' and (new.status is distinct from old.status or new.resolved_at is distinct from old.resolved_at
       or new.resolved_by is distinct from old.resolved_by or new.resolution_note is distinct from old.resolution_note) then
    raise exception 'A resolved discrepancy cannot be reopened or edited; a new one is recorded if it recurs.' using errcode = '55000';
  end if;
  if old.status = 'resolved' and (new.times_seen <> old.times_seen or new.last_seen_at <> old.last_seen_at) then
    raise exception 'A resolved discrepancy is closed history.' using errcode = '55000';
  end if;
  return new;
end
$fn$;
revoke execute on function public.payment_reconciliation_discrepancies_guard() from public, anon, authenticated, service_role;
create trigger payment_reconciliation_discrepancies_guard
  before update or delete on public.payment_reconciliation_discrepancies
  for each row execute function public.payment_reconciliation_discrepancies_guard();

-- ══ 6. Obligations arise by themselves ══════════════════════════════════════
create function public.refund_obligation_from_unfulfilled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  insert into refund_obligations
    (source, source_id, order_id, channel, razorpay_order_id, razorpay_payment_id,
     amount_paise, currency, captured_paise, origin)
  values
    ('unfulfilled_payment', new.id, new.order_id, 'razorpay', new.razorpay_order_id, new.razorpay_payment_id,
     new.amount_paise, new.currency, new.amount_paise, 'recorded')
  on conflict (source, source_id) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into payment_refund_events (action, source, obligation_id, razorpay_payment_id, evidence)
    values ('obligation_created', 'trigger', v_id, new.razorpay_payment_id,
            jsonb_build_object('source', 'unfulfilled_payment', 'reason', new.reason, 'amount_paise', new.amount_paise));
  end if;
  return null;
end
$fn$;
revoke execute on function public.refund_obligation_from_unfulfilled() from public, anon, authenticated, service_role;
create trigger payment_refund_obligations_ledger
  after insert on public.payment_refund_obligations
  for each row execute function public.refund_obligation_from_unfulfilled();

create function public.refund_obligation_from_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  o    record;
  v_id uuid;
  v_channel text;
begin
  select id, payment_provider, razorpay_order_id, razorpay_payment_id, total_inr
    into o from orders where id = new.order_id;
  v_channel := case when o.id is not null and o.payment_provider is distinct from 'offline'
                         and o.razorpay_order_id is not null
                    then 'razorpay' else 'outside_razorpay' end;
  insert into refund_obligations
    (source, source_id, order_id, channel, razorpay_order_id, razorpay_payment_id,
     amount_paise, currency, captured_paise, origin)
  values
    ('credit_note', new.id, new.order_id, v_channel,
     case when v_channel = 'razorpay' then o.razorpay_order_id end,
     case when v_channel = 'razorpay' then o.razorpay_payment_id end,
     round(new.amount_inr * 100)::bigint, 'INR',
     case when o.total_inr is not null and o.total_inr > 0 then round(o.total_inr * 100)::bigint end,
     'recorded')
  on conflict (source, source_id) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into payment_refund_events (action, source, actor, obligation_id, razorpay_payment_id, evidence)
    values ('obligation_created', 'trigger', new.issued_by, v_id, o.razorpay_payment_id,
            jsonb_build_object('source', 'credit_note', 'credit_note_number', new.credit_note_number,
                               'kind', new.kind, 'amount_paise', round(new.amount_inr * 100)::bigint,
                               'channel', v_channel));
  end if;
  return null;
end
$fn$;
revoke execute on function public.refund_obligation_from_credit_note() from public, anon, authenticated, service_role;
create trigger credit_notes_refund_ledger
  after insert on public.credit_notes
  for each row execute function public.refund_obligation_from_credit_note();

-- Backfill: everything already owed. Labelled, so a Test-mode history is
-- recognisable and can be closed deliberately before Razorpay Live.
insert into public.refund_obligations
  (source, source_id, order_id, channel, razorpay_order_id, razorpay_payment_id,
   amount_paise, currency, captured_paise, origin, created_at)
select 'unfulfilled_payment', p.id, p.order_id, 'razorpay', p.razorpay_order_id, p.razorpay_payment_id,
       p.amount_paise, p.currency, p.amount_paise, 'backfill_0080', p.first_seen_at
  from public.payment_refund_obligations p;

insert into public.refund_obligations
  (source, source_id, order_id, channel, razorpay_order_id, razorpay_payment_id,
   amount_paise, currency, captured_paise, origin, created_at)
select 'credit_note', cn.id, cn.order_id, ch.channel,
       case when ch.channel = 'razorpay' then o.razorpay_order_id end,
       case when ch.channel = 'razorpay' then o.razorpay_payment_id end,
       round(cn.amount_inr * 100)::bigint, 'INR',
       case when o.total_inr is not null and o.total_inr > 0 then round(o.total_inr * 100)::bigint end,
       'backfill_0080', cn.issued_at
  from public.credit_notes cn
  left join public.orders o on o.id = cn.order_id
  cross join lateral (select case when o.id is not null and o.payment_provider is distinct from 'offline'
                                       and o.razorpay_order_id is not null
                                  then 'razorpay' else 'outside_razorpay' end as channel) ch;

insert into public.payment_refund_events (action, source, obligation_id, razorpay_payment_id, evidence)
select 'obligation_created', 'backfill', r.id, r.razorpay_payment_id,
       jsonb_build_object('source', r.source, 'amount_paise', r.amount_paise, 'channel', r.channel)
  from public.refund_obligations r;

-- ══ 7. Discrepancies ════════════════════════════════════════════════════════
-- Internal: record (or count again) one discrepancy. Not callable by any API role.
create function public.refund_discrepancy_upsert(
  p_kind text, p_mode text, p_payment text, p_rzp_order text, p_refund text,
  p_order uuid, p_obligation uuid, p_details jsonb, p_run bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_key text := concat_ws('|', p_kind, coalesce(p_mode, ''), coalesce(p_payment, ''),
                          coalesce(p_refund, ''), coalesce(p_obligation::text, ''));
  v_id bigint;
begin
  insert into payment_reconciliation_discrepancies as d
    (kind, provider_mode, razorpay_payment_id, razorpay_order_id, razorpay_refund_id,
     order_id, obligation_id, dedupe_key, details, latest_details, first_run_id, last_run_id)
  values
    (p_kind, p_mode, p_payment, p_rzp_order, p_refund, p_order, p_obligation, v_key,
     p_details, p_details, p_run, p_run)
  on conflict (dedupe_key) where status in ('open', 'accepted') do update
    set last_seen_at   = now(),
        times_seen     = d.times_seen + 1,
        latest_details = excluded.latest_details,
        last_run_id    = coalesce(excluded.last_run_id, d.last_run_id)
  returning d.id into v_id;

  -- Money that arrived without a record, or left without a reason: a human
  -- must look at the order before anything else happens to it.
  if p_order is not null and p_kind in ('captured_not_recorded', 'refund_without_obligation', 'refund_exceeds_obligation') then
    update orders set needs_review = true where id = p_order and not needs_review;
  end if;
  return v_id;
end
$fn$;
revoke execute on function public.refund_discrepancy_upsert(text, text, text, text, text, uuid, uuid, jsonb, bigint)
  from public, anon, authenticated, service_role;

-- ══ 8. Recording a refund ═══════════════════════════════════════════════════
-- An admin records the refund id Razorpay's dashboard gave them. That is all
-- they can say: the row counts for nothing until record_refund_evidence has
-- Razorpay's own answer.
create function public.admin_claim_refund(p_obligation_id uuid, p_refund_id text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  ob  refund_obligations%rowtype;
  r   payment_refunds%rowtype;
  v_id uuid;
  v_ref text := btrim(coalesce(p_refund_id, ''));
begin
  if not public.is_admin() then
    raise exception 'Only admins can record a refund' using errcode = '42501';
  end if;
  if v_ref !~ '^rfnd_[A-Za-z0-9]{6,40}$' then
    raise exception 'That is not a Razorpay refund id. It starts with rfnd_ and is shown on the refund in Razorpay''s dashboard.'
      using errcode = '22023';
  end if;
  select * into ob from refund_obligations where id = p_obligation_id for update;
  if not found then
    raise exception 'No such refund obligation' using errcode = 'P0002';
  end if;
  if ob.channel <> 'razorpay' then
    raise exception 'This money was not taken through Razorpay, so a Razorpay refund cannot settle it.' using errcode = '55000';
  end if;
  if ob.closed_at is not null then
    raise exception 'This obligation is closed.' using errcode = '55000';
  end if;

  select * into r from payment_refunds where razorpay_refund_id = v_ref for update;
  if found then
    if r.obligation_id = ob.id then
      return jsonb_build_object('outcome', 'already_recorded', 'payment_refund_id', r.id, 'status', r.status);
    end if;
    if r.obligation_id is null and r.razorpay_payment_id is not null and r.razorpay_payment_id = ob.razorpay_payment_id then
      update payment_refunds set obligation_id = ob.id where id = r.id;
      insert into payment_refund_events (action, source, actor, obligation_id, payment_refund_id, razorpay_refund_id,
                                         razorpay_payment_id, from_status, to_status)
      values ('claim_linked', 'admin', auth.uid(), ob.id, r.id, v_ref, r.razorpay_payment_id, r.status, r.status);
      return jsonb_build_object('outcome', 'linked', 'payment_refund_id', r.id, 'status', r.status);
    end if;
    raise exception 'That refund id is already recorded against a different payment.' using errcode = '23505';
  end if;

  insert into payment_refunds (razorpay_refund_id, obligation_id, order_id, status, claimed_by, claimed_at)
  values (v_ref, ob.id, ob.order_id, 'claimed', auth.uid(), now())
  returning id into v_id;
  insert into payment_refund_events (action, source, actor, obligation_id, payment_refund_id, razorpay_refund_id,
                                     razorpay_payment_id, to_status)
  values ('refund_claimed', 'admin', auth.uid(), ob.id, v_id, v_ref, ob.razorpay_payment_id, 'claimed');
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    insert into refund_notes (obligation_id, payment_refund_id, note, author)
    values (ob.id, v_id, btrim(p_note), auth.uid());
  end if;
  return jsonb_build_object('outcome', 'claimed', 'payment_refund_id', v_id, 'status', 'claimed');
end
$fn$;
revoke execute on function public.admin_claim_refund(uuid, text, text) from public, anon, service_role;
grant execute on function public.admin_claim_refund(uuid, text, text) to authenticated;

-- What Razorpay's API said about a refund and its payment. service_role only:
-- the server calls this after fetching BOTH from Razorpay with its own keys
-- (lib/refundLedger). Every input is provider evidence; nothing an admin or a
-- webhook payload says reaches here unverified.
create function public.record_refund_evidence(
  p_refund_id                    text,
  p_payment_id                   text,
  p_payment_order_id             text,
  p_amount_paise                 bigint,
  p_currency                     text,
  p_status                       text,
  p_created_at                   timestamptz,
  p_speed_processed              text,
  p_payment_amount_paise         bigint,
  p_payment_currency             text,
  p_payment_captured             boolean,
  p_payment_amount_refunded_paise bigint,
  p_provider_mode                text,
  p_source                       text,
  p_actor                        uuid default null,
  p_payload_mismatch             jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r          payment_refunds%rowtype;
  v_exists   boolean;
  v_order    record;
  ob         refund_obligations%rowtype;
  v_from     text;
  v_new      text;
  v_reason   text;
  v_action   text;
  v_counted  bigint;
  v_owed     bigint;
  v_refunded bigint;
  v_obs      integer;
  v_disc     bigint[] := '{}';
  v_id       uuid;
  v_evidence jsonb;
begin
  -- ── Shape of the evidence ──
  if coalesce(p_refund_id, '') !~ '^rfnd_[A-Za-z0-9]{6,40}$' then
    raise exception 'record_refund_evidence: a Razorpay refund id is required' using errcode = '22023';
  end if;
  if coalesce(p_payment_id, '') !~ '^pay_[A-Za-z0-9]{6,40}$' then
    raise exception 'record_refund_evidence: the refund''s Razorpay payment id is required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('pending', 'processed', 'failed') then
    raise exception 'record_refund_evidence: unknown refund status %', coalesce(p_status, 'none') using errcode = '22023';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_payment_amount_paise is null or p_payment_amount_paise <= 0 then
    raise exception 'record_refund_evidence: refund and payment amounts must be positive' using errcode = '22023';
  end if;
  if p_provider_mode is null or p_provider_mode not in ('test', 'live') then
    raise exception 'record_refund_evidence: provider mode must be test or live' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('admin_verify', 'webhook', 'reconciliation') then
    raise exception 'record_refund_evidence: unknown source %', coalesce(p_source, 'none') using errcode = '22023';
  end if;

  v_evidence := jsonb_build_object(
    'amount_paise', p_amount_paise, 'currency', p_currency, 'status', p_status,
    'payment_id', p_payment_id, 'payment_order_id', p_payment_order_id,
    'payment_amount_paise', p_payment_amount_paise, 'payment_currency', p_payment_currency,
    'payment_captured', p_payment_captured, 'payment_amount_refunded_paise', p_payment_amount_refunded_paise,
    'provider_created_at', p_created_at, 'speed_processed', p_speed_processed, 'mode', p_provider_mode);

  -- An automatic refund of a payment that was never captured: Razorpay held
  -- the money and gave it back; none of it was Wovenne's. Nothing to record.
  if not coalesce(p_payment_captured, false) then
    return jsonb_build_object('outcome', 'ignored_uncaptured');
  end if;

  -- ONE PAYMENT AT A TIME. The guard trigger takes the same lock.
  perform pg_advisory_xact_lock(hashtextextended('wovenne.refund:' || p_payment_id, 0));

  if p_currency is distinct from 'INR' or p_payment_currency is distinct from 'INR' then
    v_disc := v_disc || public.refund_discrepancy_upsert('refund_contradiction', p_provider_mode, p_payment_id,
      p_payment_order_id, p_refund_id, null, null, v_evidence || jsonb_build_object('problem', 'not INR'), null);
    return jsonb_build_object('outcome', 'refused_currency', 'discrepancies', to_jsonb(v_disc));
  end if;

  select * into r from payment_refunds where razorpay_refund_id = p_refund_id for update;
  v_exists := found;
  v_from := case when v_exists then r.status end;

  select id, razorpay_payment_id, total_inr, payment_status into v_order
    from orders where razorpay_order_id = p_payment_order_id;

  -- A pre-0077 order kept no payment id: its credit-note obligation learns it
  -- here, once, from the payment Razorpay names — but only when that payment
  -- is not separately owed back as an unfulfilled payment.
  if v_order.id is not null and v_order.razorpay_payment_id is null
     and not exists (select 1 from refund_obligations where razorpay_payment_id = p_payment_id) then
    for ob in
      update refund_obligations set razorpay_payment_id = p_payment_id
       where razorpay_payment_id is null and channel = 'razorpay' and razorpay_order_id = p_payment_order_id
      returning *
    loop
      insert into payment_refund_events (action, source, actor, obligation_id, razorpay_refund_id, razorpay_payment_id, evidence)
      values ('obligation_linked', p_source, p_actor, ob.id, p_refund_id, p_payment_id,
              jsonb_build_object('razorpay_order_id', p_payment_order_id));
    end loop;
  end if;

  -- ── Decide the status ──
  v_new := p_status;
  v_action := 'refund_verified';

  if v_exists and r.obligation_id is not null then
    select * into ob from refund_obligations where id = r.obligation_id;
    if ob.razorpay_payment_id is distinct from p_payment_id then
      v_new := 'uncertain';
      v_reason := format('Recorded against payment %s, but Razorpay says this refund is on payment %s.',
                         coalesce(ob.razorpay_payment_id, '(unknown, order ' || coalesce(ob.razorpay_order_id, '?') || ')'), p_payment_id);
      v_disc := v_disc || public.refund_discrepancy_upsert('refund_claim_mismatch', p_provider_mode, p_payment_id,
        p_payment_order_id, p_refund_id, v_order.id, ob.id, v_evidence || jsonb_build_object('claimed_payment', ob.razorpay_payment_id), null);
    end if;
  end if;

  if v_new <> 'uncertain' and v_exists and v_from <> 'claimed' and (
       r.razorpay_payment_id is distinct from p_payment_id
       or r.amount_paise is distinct from p_amount_paise
       or r.currency is distinct from p_currency
       or r.provider_mode is distinct from p_provider_mode
       or r.payment_amount_paise is distinct from p_payment_amount_paise) then
    v_new := 'uncertain';
    v_reason := 'Razorpay''s answer for this refund changed (payment, amount, currency or mode).';
    v_disc := v_disc || public.refund_discrepancy_upsert('refund_contradiction', p_provider_mode, p_payment_id,
      p_payment_order_id, p_refund_id, v_order.id, null, v_evidence || jsonb_build_object(
        'recorded', jsonb_build_object('payment_id', r.razorpay_payment_id, 'amount_paise', r.amount_paise,
                                       'currency', r.currency, 'mode', r.provider_mode,
                                       'payment_amount_paise', r.payment_amount_paise)), null);
  end if;

  if v_new <> 'uncertain' and exists (
       select 1 from payment_refunds
        where razorpay_payment_id = p_payment_id and provider_mode is distinct from p_provider_mode
          and provider_mode is not null and razorpay_refund_id <> p_refund_id) then
    v_new := 'uncertain';
    v_reason := 'Test and Live refunds recorded against the same payment.';
    v_disc := v_disc || public.refund_discrepancy_upsert('refund_contradiction', p_provider_mode, p_payment_id,
      p_payment_order_id, p_refund_id, v_order.id, null, v_evidence || jsonb_build_object('problem', 'mixed modes'), null);
  end if;

  if v_new <> 'uncertain' and v_from is not null then
    if v_from = 'processed' and p_status = 'pending' then
      v_new := 'processed'; v_action := 'refund_stale_ignored';
    elsif v_from = 'failed' and p_status = 'pending' then
      v_new := 'failed'; v_action := 'refund_stale_ignored';
    elsif (v_from = 'processed' and p_status = 'failed') or (v_from = 'failed' and p_status = 'processed') then
      v_new := 'uncertain';
      v_reason := format('Razorpay said %s, and later %s. Both are final states.', v_from, p_status);
      v_disc := v_disc || public.refund_discrepancy_upsert('refund_contradiction', p_provider_mode, p_payment_id,
        p_payment_order_id, p_refund_id, v_order.id, null, v_evidence || jsonb_build_object('previous_status', v_from), null);
    elsif v_from = 'uncertain' and p_source <> 'admin_verify' then
      -- Uncertain is cleared only when a person asks Razorpay again.
      v_new := 'uncertain'; v_action := 'refund_unchanged';
    elsif v_from = p_status then
      v_action := 'refund_unchanged';
    end if;
  end if;

  -- Never more counted than the payment captured.
  if v_new in ('pending', 'processed') then
    select coalesce(sum(amount_paise), 0) into v_counted
      from payment_refunds
     where razorpay_payment_id = p_payment_id and status in ('pending', 'processed')
       and razorpay_refund_id <> p_refund_id;
    if v_counted + p_amount_paise > p_payment_amount_paise then
      v_new := 'uncertain';
      v_reason := format('Counting this refund would exceed what the payment captured (%s + %s > %s).',
                         v_counted, p_amount_paise, p_payment_amount_paise);
      v_disc := v_disc || public.refund_discrepancy_upsert('refund_exceeds_capture', p_provider_mode, p_payment_id,
        p_payment_order_id, p_refund_id, v_order.id, null, v_evidence || jsonb_build_object('already_counted_paise', v_counted), null);
    end if;
  end if;

  if v_new = 'uncertain' then
    v_action := case when v_from = 'uncertain' and v_action = 'refund_unchanged' then 'refund_unchanged' else 'refund_uncertain' end;
  end if;

  -- ── Write ──
  if not v_exists then
    insert into payment_refunds
      (razorpay_refund_id, order_id, razorpay_payment_id, razorpay_order_id, status, amount_paise, currency,
       payment_amount_paise, provider_mode, provider_status, provider_created_at, speed_processed,
       uncertain_reason, first_verified_at, last_verified_at, last_verified_source, processed_seen_at)
    values
      (p_refund_id, v_order.id, p_payment_id, p_payment_order_id, v_new, p_amount_paise, p_currency,
       p_payment_amount_paise, p_provider_mode, p_status, p_created_at, p_speed_processed,
       case when v_new = 'uncertain' then v_reason end, now(), now(), p_source,
       case when p_status = 'processed' then now() end)
    returning id into v_id;
  else
    v_id := r.id;
    update payment_refunds
       set status               = v_new,
           order_id             = coalesce(order_id, v_order.id),
           -- Identity: filled from Razorpay for a claim; otherwise unchanged
           -- (a contradiction never overwrites it — the guard refuses).
           razorpay_payment_id  = coalesce(razorpay_payment_id, p_payment_id),
           razorpay_order_id    = coalesce(razorpay_order_id, p_payment_order_id),
           amount_paise         = coalesce(amount_paise, p_amount_paise),
           currency             = coalesce(currency, p_currency),
           payment_amount_paise = coalesce(payment_amount_paise, p_payment_amount_paise),
           provider_mode        = coalesce(provider_mode, p_provider_mode),
           provider_status      = case when v_new in ('pending', 'processed', 'failed') then v_new else p_status end,
           provider_created_at  = coalesce(provider_created_at, p_created_at),
           speed_processed      = coalesce(p_speed_processed, speed_processed),
           uncertain_reason     = case when v_new = 'uncertain' then coalesce(v_reason, uncertain_reason) else null end,
           first_verified_at    = coalesce(first_verified_at, now()),
           last_verified_at     = now(),
           last_verified_source = p_source,
           processed_seen_at    = coalesce(processed_seen_at, case when p_status = 'processed' then now() end)
     where id = r.id;
  end if;

  insert into payment_refund_events (action, source, actor, obligation_id, payment_refund_id, razorpay_refund_id,
                                     razorpay_payment_id, from_status, to_status, evidence)
  values (v_action, p_source, p_actor, case when v_exists then r.obligation_id end, v_id, p_refund_id,
          p_payment_id, v_from, v_new, v_evidence || jsonb_build_object('reason', v_reason));

  -- ── Against what was owed ──
  if v_new in ('pending', 'processed') then
    select count(*), coalesce(sum(amount_paise), 0) into v_obs, v_owed
      from refund_obligations where razorpay_payment_id = p_payment_id;
    select coalesce(sum(amount_paise), 0) into v_refunded
      from payment_refunds where razorpay_payment_id = p_payment_id and status = 'processed';
    if v_obs = 0 then
      v_disc := v_disc || public.refund_discrepancy_upsert('refund_without_obligation', p_provider_mode, p_payment_id,
        p_payment_order_id, p_refund_id, v_order.id, null, v_evidence, null);
    elsif v_refunded > v_owed then
      v_disc := v_disc || public.refund_discrepancy_upsert('refund_exceeds_obligation', p_provider_mode, p_payment_id,
        p_payment_order_id, null, v_order.id, null,
        jsonb_build_object('owed_paise', v_owed, 'refunded_paise', v_refunded), null);
    end if;
    if exists (select 1 from refund_obligations where razorpay_payment_id = p_payment_id
                and captured_paise is not null and captured_paise <> p_payment_amount_paise
                and source = 'unfulfilled_payment') then
      v_disc := v_disc || public.refund_discrepancy_upsert('amount_mismatch', p_provider_mode, p_payment_id,
        p_payment_order_id, null, v_order.id, null, v_evidence, null);
    end if;
  end if;

  if p_payload_mismatch is not null then
    v_disc := v_disc || public.refund_discrepancy_upsert('webhook_payload_mismatch', p_provider_mode, p_payment_id,
      p_payment_order_id, p_refund_id, v_order.id, null, p_payload_mismatch, null);
  end if;

  return jsonb_build_object(
    'outcome', case v_action when 'refund_verified' then 'recorded'
                             when 'refund_unchanged' then 'unchanged'
                             when 'refund_stale_ignored' then 'stale_ignored'
                             else 'uncertain' end,
    'payment_refund_id', v_id,
    'from', v_from,
    'status', v_new,
    'reason', v_reason,
    'discrepancies', to_jsonb(v_disc));
end
$fn$;
revoke execute on function public.record_refund_evidence(text, text, text, bigint, text, text, timestamptz, text,
  bigint, text, boolean, bigint, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_refund_evidence(text, text, text, bigint, text, text, timestamptz, text,
  bigint, text, boolean, bigint, text, text, uuid, jsonb) to service_role;

-- A refund id Razorpay could not find, from a signed webhook or a typed id.
-- Recorded for a human; a claimed row stays claimed (counts nothing).
create function public.record_refund_not_found(p_refund_id text, p_payment_id text, p_mode text, p_source text, p_details jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ob uuid;
begin
  if p_source is null or p_source not in ('admin_verify', 'webhook', 'reconciliation') then
    raise exception 'record_refund_not_found: unknown source' using errcode = '22023';
  end if;
  select obligation_id into v_ob from payment_refunds where razorpay_refund_id = p_refund_id;
  return public.refund_discrepancy_upsert('refund_not_found', p_mode, nullif(p_payment_id, ''), null,
    nullif(p_refund_id, ''), null, v_ob, coalesce(p_details, '{}'::jsonb) || jsonb_build_object('source', p_source), null);
end
$fn$;
revoke execute on function public.record_refund_not_found(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_refund_not_found(text, text, text, text, jsonb) to service_role;

-- ══ 9. Admin housekeeping: close, note, resolve ═════════════════════════════
-- Close an obligation WITHOUT a verified refund: a Test-mode payment that was
-- never real money, or money returned outside Razorpay. A written reason; what
-- was outstanding is recorded as written off. Shown as closed, never refunded.
create function public.admin_close_refund_obligation(p_obligation_id uuid, p_kind text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  ob        refund_obligations%rowtype;
  v_key     text;
  v_owed    bigint;
  v_refund  bigint;
  v_wo      bigint;
  v_out     bigint;
begin
  if not public.is_admin() then
    raise exception 'Only admins can close a refund obligation' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('test_mode_payment', 'refunded_outside_razorpay') then
    raise exception 'Say why it is being closed: test_mode_payment or refunded_outside_razorpay.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 20 then
    raise exception 'Write at least 20 characters saying why, and where the evidence is.' using errcode = '22023';
  end if;
  select * into ob from refund_obligations where id = p_obligation_id for update;
  if not found then
    raise exception 'No such refund obligation' using errcode = 'P0002';
  end if;
  if ob.closed_at is not null then
    raise exception 'This obligation is already closed.' using errcode = '55000';
  end if;
  if ob.razorpay_payment_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('wovenne.refund:' || ob.razorpay_payment_id, 0));
  end if;
  if exists (select 1 from payment_refunds r
              where r.status in ('claimed', 'pending', 'uncertain')
                and (r.obligation_id = ob.id
                     or (ob.razorpay_payment_id is not null and r.razorpay_payment_id = ob.razorpay_payment_id))) then
    raise exception 'A refund for this payment is still unverified, pending or uncertain. Settle that first.' using errcode = '55000';
  end if;

  -- What is outstanding on the payment (all its obligations, less verified
  -- refunds and earlier write-offs), capped at this obligation's amount.
  if ob.razorpay_payment_id is null then
    v_out := ob.amount_paise;
  else
    select coalesce(sum(amount_paise), 0) into v_refund
      from payment_refunds where razorpay_payment_id = ob.razorpay_payment_id and status = 'processed';
    select coalesce(sum(amount_paise), 0), coalesce(sum(written_off_paise), 0) into v_owed, v_wo
      from refund_obligations where razorpay_payment_id = ob.razorpay_payment_id;
    v_out := least(ob.amount_paise, greatest(v_owed - v_refund - v_wo, 0));
  end if;
  if v_out <= 0 then
    raise exception 'Nothing is outstanding on this obligation.' using errcode = '55000';
  end if;

  update refund_obligations
     set closed_at = now(), closed_by = auth.uid(), close_kind = p_kind,
         close_reason = btrim(p_reason), written_off_paise = v_out
   where id = ob.id;
  insert into payment_refund_events (action, source, actor, obligation_id, razorpay_payment_id, evidence)
  values ('obligation_closed', 'admin', auth.uid(), ob.id, ob.razorpay_payment_id,
          jsonb_build_object('kind', p_kind, 'written_off_paise', v_out, 'reason', btrim(p_reason)));
  insert into refund_notes (obligation_id, note, author)
  values (ob.id, 'Closed (' || p_kind || '): ' || btrim(p_reason), auth.uid());
  return jsonb_build_object('outcome', 'closed', 'written_off_paise', v_out);
end
$fn$;
revoke execute on function public.admin_close_refund_obligation(uuid, text, text) from public, anon, service_role;
grant execute on function public.admin_close_refund_obligation(uuid, text, text) to authenticated;

create function public.admin_add_refund_note(p_obligation_id uuid, p_discrepancy_id bigint, p_note text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id bigint;
begin
  if not public.is_admin() then
    raise exception 'Only admins can add a reconciliation note' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'A note needs at least 10 characters.' using errcode = '22023';
  end if;
  if p_obligation_id is null and p_discrepancy_id is null then
    raise exception 'A note belongs to an obligation or a discrepancy.' using errcode = '22023';
  end if;
  insert into refund_notes (obligation_id, discrepancy_id, note, author)
  values (p_obligation_id, p_discrepancy_id, btrim(p_note), auth.uid())
  returning id into v_id;
  return v_id;
end
$fn$;
revoke execute on function public.admin_add_refund_note(uuid, bigint, text) from public, anon, service_role;
grant execute on function public.admin_add_refund_note(uuid, bigint, text) to authenticated;

create function public.admin_resolve_discrepancy(p_id bigint, p_resolution text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  d payment_reconciliation_discrepancies%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can resolve a discrepancy' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('resolved', 'accepted') then
    raise exception 'Resolution is resolved (fixed) or accepted (understood, benign).' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 20 then
    raise exception 'Write at least 20 characters: what was found and what was done.' using errcode = '22023';
  end if;
  select * into d from payment_reconciliation_discrepancies where id = p_id for update;
  if not found then
    raise exception 'No such discrepancy' using errcode = 'P0002';
  end if;
  if d.status <> 'open' then
    raise exception 'That discrepancy is already %.', d.status using errcode = '55000';
  end if;
  update payment_reconciliation_discrepancies
     set status = p_resolution, resolved_at = now(), resolved_by = auth.uid(), resolution_note = btrim(p_note)
   where id = p_id;
  insert into refund_notes (discrepancy_id, obligation_id, note, author)
  values (p_id, d.obligation_id, initcap(p_resolution) || ': ' || btrim(p_note), auth.uid());
  return jsonb_build_object('outcome', p_resolution);
end
$fn$;
revoke execute on function public.admin_resolve_discrepancy(bigint, text, text) from public, anon, service_role;
grant execute on function public.admin_resolve_discrepancy(bigint, text, text) to authenticated;

-- ══ 10. Reconciliation (service_role; records only) ═════════════════════════
create function public.recon_start(p_mode text, p_from timestamptz, p_to timestamptz, p_actor uuid,
                                   p_resume_from bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  prev payment_reconciliation_runs%rowtype;
  v_skip integer := 0;
  v_run payment_reconciliation_runs%rowtype;
begin
  if p_mode is null or p_mode not in ('test', 'live') then
    raise exception 'recon_start: mode must be test or live' using errcode = '22023';
  end if;
  if p_resume_from is not null then
    select * into prev from payment_reconciliation_runs where id = p_resume_from;
    if not found or prev.status not in ('incomplete', 'failed') or prev.provider_mode <> p_mode then
      raise exception 'recon_start: run % cannot be resumed', p_resume_from using errcode = '55000';
    end if;
    if prev.data_incomplete then
      -- Items already seen came back without key fields; start the window again.
      v_skip := 0;
    else
      v_skip := prev.next_skip;
    end if;
    p_from := prev.window_from;
    p_to := prev.window_to;
  end if;
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'recon_start: the window is empty' using errcode = '22023';
  end if;
  -- A fixed window in the past: payments still arriving cannot shift the pages.
  if p_to > now() - interval '15 minutes' then
    raise exception 'recon_start: the window must end at least 15 minutes ago' using errcode = '22023';
  end if;
  if p_to - p_from > interval '31 days' then
    raise exception 'recon_start: at most 31 days per run' using errcode = '22023';
  end if;
  -- A run abandoned mid-way (the server stopped) holds the slot for 10 minutes.
  update payment_reconciliation_runs
     set status = 'incomplete', finished_at = now(), last_error = 'abandoned (no checkpoint for 10 minutes)'
   where provider_mode = p_mode and status = 'running' and updated_at < now() - interval '10 minutes';
  begin
    insert into payment_reconciliation_runs (provider_mode, window_from, window_to, resumed_from, start_skip, next_skip, started_by)
    values (p_mode, p_from, p_to, p_resume_from, v_skip, v_skip, p_actor)
    returning * into v_run;
  exception when unique_violation then
    raise exception 'recon_start: a reconciliation is already running' using errcode = '55P03';
  end;
  return to_jsonb(v_run);
end
$fn$;
revoke execute on function public.recon_start(text, timestamptz, timestamptz, uuid, bigint) from public, anon, authenticated;
grant execute on function public.recon_start(text, timestamptz, timestamptz, uuid, bigint) to service_role;

create function public.recon_checkpoint(p_run bigint, p_next_skip integer, p_items integer, p_captured integer,
                                        p_exhausted boolean, p_data_incomplete boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  update payment_reconciliation_runs
     set next_skip = p_next_skip,
         pages = pages + 1,
         payments_seen = payments_seen + greatest(p_items, 0),
         captured_seen = captured_seen + greatest(p_captured, 0),
         exhausted = exhausted or coalesce(p_exhausted, false),
         data_incomplete = data_incomplete or coalesce(p_data_incomplete, false)
   where id = p_run and status = 'running';
  if not found then
    raise exception 'recon_checkpoint: run % is not running', p_run using errcode = '55000';
  end if;
end
$fn$;
revoke execute on function public.recon_checkpoint(bigint, integer, integer, integer, boolean, boolean) from public, anon, authenticated;
grant execute on function public.recon_checkpoint(bigint, integer, integer, integer, boolean, boolean) to service_role;

create function public.recon_record_discrepancy(p_run bigint, p_kind text, p_payment text, p_rzp_order text,
                                                p_refund text, p_details jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_run payment_reconciliation_runs%rowtype;
  v_order uuid;
  v_ob uuid;
  v_id bigint;
begin
  select * into v_run from payment_reconciliation_runs where id = p_run;
  if not found or v_run.status <> 'running' then
    raise exception 'recon_record_discrepancy: run % is not running', p_run using errcode = '55000';
  end if;
  if p_kind in ('refund_without_obligation', 'refund_exceeds_capture', 'refund_claim_mismatch',
                'webhook_payload_mismatch') then
    raise exception 'recon_record_discrepancy: % is recorded with the refund evidence, not by reconciliation', p_kind
      using errcode = '22023';
  end if;
  select id into v_order from orders where razorpay_order_id = p_rzp_order;
  select id into v_ob from refund_obligations where razorpay_payment_id = p_payment order by created_at limit 1;
  v_id := public.refund_discrepancy_upsert(p_kind, v_run.provider_mode, p_payment, p_rzp_order, p_refund,
                                           v_order, v_ob, p_details, p_run);
  update payment_reconciliation_runs set discrepancies = discrepancies + 1 where id = p_run;
  return v_id;
end
$fn$;
revoke execute on function public.recon_record_discrepancy(bigint, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.recon_record_discrepancy(bigint, text, text, text, text, jsonb) to service_role;

-- What Wovenne recorded about a page of Razorpay payments. Read-only.
create function public.recon_payment_facts(p_payment_ids text[], p_rzp_order_ids text[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'razorpay_order_id', o.razorpay_order_id, 'id', o.id, 'status', o.status,
               'payment_status', o.payment_status, 'razorpay_payment_id', o.razorpay_payment_id,
               'total_paise', case when o.total_inr is null then null else round(o.total_inr * 100)::bigint end))
        from orders o where o.razorpay_order_id = any (p_rzp_order_ids)), '[]'::jsonb),
    'unfulfilled', coalesce((
      select jsonb_agg(jsonb_build_object('razorpay_payment_id', p.razorpay_payment_id, 'amount_paise', p.amount_paise))
        from payment_refund_obligations p where p.razorpay_payment_id = any (p_payment_ids)), '[]'::jsonb),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'razorpay_payment_id', x.pid, 'counted_paise', x.counted, 'processed_paise', x.processed))
        from (select razorpay_payment_id pid,
                     coalesce(sum(amount_paise) filter (where status in ('pending', 'processed')), 0) counted,
                     coalesce(sum(amount_paise) filter (where status = 'processed'), 0) processed
                from payment_refunds where razorpay_payment_id = any (p_payment_ids)
               group by razorpay_payment_id) x), '[]'::jsonb))
$fn$;
revoke execute on function public.recon_payment_facts(text[], text[]) from public, anon, authenticated;
grant execute on function public.recon_payment_facts(text[], text[]) to service_role;

create function public.recon_finish(p_run bigint, p_status text, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_run payment_reconciliation_runs%rowtype;
  r record;
  v_stale integer := 0;
begin
  if p_status is null or p_status not in ('complete', 'incomplete', 'failed') then
    raise exception 'recon_finish: status must be complete, incomplete or failed' using errcode = '22023';
  end if;
  select * into v_run from payment_reconciliation_runs where id = p_run for update;
  if not found or v_run.status <> 'running' then
    raise exception 'recon_finish: run % is not running', p_run using errcode = '55000';
  end if;
  if p_status = 'complete' and (not v_run.exhausted or v_run.data_incomplete) then
    raise exception 'recon_finish: not every page was read cleanly; the run is incomplete, not complete'
      using errcode = '55000';
  end if;
  if p_status = 'complete' then
    -- Ledger-wide checks that need no provider call.
    for r in select * from payment_refunds
              where (status = 'pending' and coalesce(provider_created_at, first_verified_at) < now() - interval '7 days'
                     and coalesce(provider_mode, v_run.provider_mode) = v_run.provider_mode)
                 or (status = 'claimed' and claimed_at < now() - interval '2 days') loop
      perform public.refund_discrepancy_upsert(
        case when r.status = 'pending' then 'refund_pending_stale' else 'refund_claim_unverified' end,
        r.provider_mode, r.razorpay_payment_id, r.razorpay_order_id, r.razorpay_refund_id,
        r.order_id, r.obligation_id, jsonb_build_object('status', r.status, 'since', coalesce(r.provider_created_at, r.claimed_at)), p_run);
      v_stale := v_stale + 1;
    end loop;
  end if;
  update payment_reconciliation_runs
     set status = p_status, finished_at = now(), last_error = left(p_error, 500),
         discrepancies = discrepancies + v_stale
   where id = p_run
  returning * into v_run;
  return to_jsonb(v_run);
end
$fn$;
revoke execute on function public.recon_finish(bigint, text, text) from public, anon, authenticated;
grant execute on function public.recon_finish(bigint, text, text) to service_role;

-- ══ 11. The ledger, per payment ═════════════════════════════════════════════
create view public.refund_ledger with (security_invoker = true) as
with ob as (
  select o.*, coalesce(o.razorpay_payment_id, 'obligation:' || o.id::text) as ledger_key
    from refund_obligations o
), rf as (
  select r.*, coalesce(r.razorpay_payment_id,
                       (select ob.ledger_key from ob where ob.id = r.obligation_id),
                       'refund:' || r.id::text) as ledger_key
    from payment_refunds r
), keys as (
  select ledger_key from ob union select ledger_key from rf
)
select
  k.ledger_key,
  coalesce(o.order_id, f.order_id)                       as order_id,
  coalesce(o.razorpay_order_id, f.razorpay_order_id)     as razorpay_order_id,
  coalesce(o.razorpay_payment_id, f.razorpay_payment_id) as razorpay_payment_id,
  o.channel,
  o.obligation_ids,
  o.sources,
  coalesce(o.backfilled, false)                          as backfilled,
  coalesce(o.obligation_count, 0)                        as obligation_count,
  coalesce(o.open_obligations, 0)                        as open_obligations,
  o.first_owed_at,
  coalesce(o.captured_paise, f.payment_amount_paise)     as captured_paise,
  coalesce(o.owed_paise, 0)                              as owed_paise,
  coalesce(o.written_off_paise, 0)                       as written_off_paise,
  coalesce(f.refunded_paise, 0)                          as refunded_paise,
  coalesce(f.pending_paise, 0)                           as pending_paise,
  coalesce(f.claimed_count, 0)                           as claimed_count,
  coalesce(f.uncertain_count, 0)                         as uncertain_count,
  coalesce(f.failed_count, 0)                            as failed_count,
  greatest(coalesce(o.owed_paise, 0) - coalesce(f.refunded_paise, 0) - coalesce(o.written_off_paise, 0), 0)
                                                         as outstanding_paise,
  greatest(coalesce(f.refunded_paise, 0) - coalesce(o.owed_paise, 0), 0)
                                                         as over_refunded_paise,
  f.provider_modes,
  f.refunds,
  f.last_verified_at,
  coalesce(d.open_discrepancies, 0)                      as open_discrepancies
from keys k
left join lateral (
  select (array_agg(ob.order_id) filter (where ob.order_id is not null))[1]            as order_id,
         (array_agg(ob.razorpay_order_id) filter (where ob.razorpay_order_id is not null))[1] as razorpay_order_id,
         (array_agg(ob.razorpay_payment_id) filter (where ob.razorpay_payment_id is not null))[1] as razorpay_payment_id,
         (array_agg(ob.channel))[1]                                                    as channel,
         array_agg(ob.id order by ob.created_at, ob.id)                               as obligation_ids,
         array_agg(distinct ob.source)                                                 as sources,
         bool_or(ob.origin = 'backfill_0080')                                          as backfilled,
         count(*)                                                                      as obligation_count,
         count(*) filter (where ob.closed_at is null)                                  as open_obligations,
         min(ob.created_at)                                                            as first_owed_at,
         max(ob.captured_paise)                                                        as captured_paise,
         sum(ob.amount_paise)                                                          as owed_paise,
         sum(coalesce(ob.written_off_paise, 0))                                        as written_off_paise
    from ob where ob.ledger_key = k.ledger_key
  having count(*) > 0
) o on true
left join lateral (
  select (array_agg(rf.order_id) filter (where rf.order_id is not null))[1]             as order_id,
         (array_agg(rf.razorpay_order_id) filter (where rf.razorpay_order_id is not null))[1] as razorpay_order_id,
         (array_agg(rf.razorpay_payment_id) filter (where rf.razorpay_payment_id is not null))[1] as razorpay_payment_id,
         max(rf.payment_amount_paise)                                                  as payment_amount_paise,
         sum(rf.amount_paise) filter (where rf.status = 'processed')                   as refunded_paise,
         sum(rf.amount_paise) filter (where rf.status = 'pending')                     as pending_paise,
         count(*) filter (where rf.status = 'claimed')                                 as claimed_count,
         count(*) filter (where rf.status = 'uncertain')                               as uncertain_count,
         count(*) filter (where rf.status = 'failed')                                  as failed_count,
         array_agg(distinct rf.provider_mode) filter (where rf.provider_mode is not null) as provider_modes,
         jsonb_agg(jsonb_build_object('id', rf.id, 'razorpay_refund_id', rf.razorpay_refund_id,
                                      'status', rf.status, 'amount_paise', rf.amount_paise,
                                      'provider_status', rf.provider_status, 'mode', rf.provider_mode,
                                      'uncertain_reason', rf.uncertain_reason,
                                      'last_verified_at', rf.last_verified_at,
                                      'last_verified_source', rf.last_verified_source)
                   order by rf.created_at)                                             as refunds,
         max(rf.last_verified_at)                                                      as last_verified_at
    from rf where rf.ledger_key = k.ledger_key
  having count(*) > 0
) f on true
left join lateral (
  select count(*) as open_discrepancies
    from payment_reconciliation_discrepancies d
   where d.status = 'open'
     and (d.razorpay_payment_id = k.ledger_key or d.obligation_id = any (coalesce(o.obligation_ids, '{}'::uuid[])))
) d on true;

comment on view public.refund_ledger is
  'Per payment (0080): owed, verified refunded (Razorpay said processed), pending,
   written off, outstanding. security_invoker: admins only, through the tables'' RLS.';
revoke all on public.refund_ledger from public, anon, authenticated, service_role;
grant select on public.refund_ledger to authenticated, service_role;

-- ══ 12. Posture, for the record ═════════════════════════════════════════════
select
  (select count(*) from public.refund_obligations) as obligations_backfilled,
  (select relrowsecurity from pg_class where oid = 'public.payment_refunds'::regclass) as refunds_rls,
  has_table_privilege('authenticated', 'public.payment_refunds', 'INSERT') as admin_can_insert_refunds_must_be_false,
  has_table_privilege('service_role', 'public.payment_refunds', 'UPDATE') as service_can_update_refunds_must_be_false,
  has_function_privilege('authenticated', 'public.record_refund_evidence(text, text, text, bigint, text, text, timestamptz, text, bigint, text, boolean, bigint, text, text, uuid, jsonb)', 'EXECUTE')
    as admin_can_record_evidence_must_be_false;
