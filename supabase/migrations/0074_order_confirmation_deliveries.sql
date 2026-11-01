-- 0074 — A durable record of each order-confirmation email (WP-EMAIL-R1a)
--
-- Until now orders.confirmation_sent_at was claimed BEFORE the email provider
-- was called, and the send ran unwatched. A provider error, a timeout or a
-- process stopped mid-send left the column set and nothing to show the email
-- never went: no record, no retry, no way to tell.
--
-- This adds one table and four functions:
--
--   order_email_deliveries         one row per confirmation, holding the frozen
--                                  payload, a stable Resend idempotency key,
--                                  the attempt state and the provider's answer.
--   enqueue_order_confirmation     claims confirmation_sent_at AND creates the
--                                  row in one transaction (no crash window
--                                  between them). Safe to call from the
--                                  browser callback and the webhook at once.
--   claim_order_email_delivery     takes a time-limited lease on a row that is
--                                  due an attempt. At most one active attempt.
--   begin_order_email_request      freezes the payload (first time only) and
--                                  stamps the request time, BEFORE the call.
--   record_order_email_outcome     records what the provider said.
--   expire_stale_order_email_deliveries
--                                  retention backstop: closes rows left
--                                  unfinished for 48 h and drops their
--                                  payload. Run by the recovery worker.
--
-- And, for the recovery worker (WP R1c-min, /api/cron/order-confirmations):
--
--   order_email_recovery_settings  one row: orphan_recovery_since, the moment
--                                  this migration was applied. Paid orders
--                                  older than that are NEVER enqueued by the
--                                  worker, so applying 0074 does not email
--                                  historical customers.
--   list_due_order_email_deliveries  ids due an attempt, oldest first, ≤ 50.
--   list_unqueued_paid_orders        paid Razorpay orders since the cutoff
--                                    with lines, no claim and no row, ≤ 50.
--   order_email_delivery_summary     counts only, for the worker's report.
--
-- WHAT A STATUS MEANS, AND DOES NOT:
--   accepted   Resend returned an email id. Resend has the email. It does NOT
--              mean the customer received it; nothing here knows that.
--   uncertain  the request may or may not have been accepted (timeout, network
--              failure, 5xx, or an attempt abandoned mid-request).
--   retryable  Resend definitely did not accept it (429, a concurrent request
--              with the same key, not configured, order could not be loaded).
--   failed     will not succeed by retrying (400/401/403/422, payload mismatch
--              under the key, render failure, no recipient, attempts used up).
--   expired    the request may have been accepted and Resend's 24-hour
--              idempotency window (anchored here at 23 hours, from the FIRST
--              request) has passed: an automatic retry could send a duplicate,
--              so none is made. A person checks Resend first.
--
-- PERSONAL DATA. A row holds the recipient address and, while it may still be
-- sent, the rendered email (name, address, items: copies of what the order
-- already holds). The HTML and text are kept ONLY while a retry could need
-- them: every transition to accepted, failed or expired drops them in the same
-- statement, keeping the subject, hash, key, provider id and timestamps as the
-- record. Rows that never finish are closed by expire_stale_order_email_
-- deliveries (to be scheduled with the recovery sweep, R1c). When an order is
-- anonymised (account deletion, 0033), its rows lose the recipient and payload
-- too, and an unfinished row is closed: there is nobody left to send to.
--
-- RETRIES ARE SAFE ONLY WITH THE SAME KEY AND THE SAME PAYLOAD. Resend returns
-- the original result for a repeated key and identical payload within 24 hours,
-- and rejects a repeated key with a different payload (409
-- invalid_idempotent_request). So the payload is frozen before the first
-- request and can never change afterwards (trigger below), and the key is
-- fixed at creation.
--
-- ACCESS. Customers can SELECT their own orders, so none of this lives on
-- orders. The table is readable by service_role only; nothing is granted to
-- anon or authenticated, and there is no policy for them. Writes happen only
-- through the functions below (SECURITY DEFINER, EXECUTE for service_role
-- only), so the state machine and the immutability rules cannot be bypassed
-- through the Data API. No admin access yet; that arrives with R1b.
--
-- Changes nothing that exists: orders, settlement, stock, loyalty, coupons and
-- invoices are untouched. Orders confirmed before this migration keep
-- confirmation_sent_at and have no row ("sent before tracking").
--
-- DEPLOY ORDER: this migration first, then the application. The application
-- refuses to send when enqueue_order_confirmation is missing rather than fall
-- back to the untracked sender, and leaves confirmation_sent_at untouched so a
-- later settlement can enqueue once this exists. The old application keeps
-- working against this migration (it never touches the new objects).
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ──
do $$
begin
  if to_regclass('public.order_email_deliveries') is not null then
    raise exception '0074: public.order_email_deliveries already exists; refusing to replace it';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.orders'::regclass and attname = 'confirmation_sent_at' and not attisdropped) then
    raise exception '0074: orders.confirmation_sent_at does not exist (0058 missing?)';
  end if;
end $$;

-- ── Table ──
create table public.order_email_deliveries (
  id                          uuid primary key default gen_random_uuid(),
  order_id                    uuid not null references public.orders (id) on delete restrict,
  kind                        text not null default 'order_confirmation'
                                check (kind = 'order_confirmation'),
  generation                  integer not null default 1 check (generation >= 1),
  -- Resend: 1–256 characters, unique per request payload.
  idempotency_key             text not null unique
                                check (length(idempotency_key) between 1 and 256),
  -- The order's email at the moment of payment. NULL only when the order had
  -- none, in which case the row is created already failed.
  recipient                   text,
  status                      text not null default 'pending'
                                check (status in ('pending', 'sending', 'accepted', 'uncertain',
                                                  'retryable', 'failed', 'expired')),
  attempts                    integer not null default 0 check (attempts >= 0),
  next_attempt_at             timestamptz not null default now(),
  lease_token                 uuid,
  lease_expires_at            timestamptz,
  -- True once any request may have reached Resend without a recorded answer.
  -- Only such rows are bound by the idempotency window.
  possibly_accepted           boolean not null default false,
  -- The frozen payload. Set once, before the first request; never changed.
  subject                     text,
  html_body                   text,
  text_body                   text,
  payload_sha256              text check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_purged_at           timestamptz,
  first_provider_request_at   timestamptz,
  last_provider_request_at    timestamptz,
  provider_message_id         text,
  accepted_at                 timestamptz,
  last_http_status            integer,
  last_error_code             text,
  last_error                  text check (last_error is null or length(last_error) <= 300),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (order_id, kind, generation),
  check ((status = 'sending') = (lease_token is not null)),
  check (status <> 'accepted' or accepted_at is not null)
);

comment on table public.order_email_deliveries is
  'One row per order-confirmation email (WP-EMAIL-R1a). status accepted means
   Resend accepted the request, NOT that the customer received it. Readable by
   service_role only; written only through the 0074 functions.';

create index order_email_deliveries_due_idx
  on public.order_email_deliveries (next_attempt_at)
  where status in ('pending', 'uncertain', 'retryable', 'sending');

-- ── Access ──
alter table public.order_email_deliveries enable row level security;
revoke all on public.order_email_deliveries from public, anon, authenticated, service_role;
grant select on public.order_email_deliveries to service_role;

-- ── Immutability ──
-- Identity never changes. The payload is written once (all four columns
-- together) and never rewritten; the HTML and text are dropped when the row
-- finishes, and only then.
create function public.order_email_deliveries_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.order_id is distinct from old.order_id
     or new.kind is distinct from old.kind
     or new.generation is distinct from old.generation
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'order_email_deliveries: identity columns are immutable';
  end if;
  -- The recipient never changes, except to be erased when its order is
  -- anonymised (order_email_deliveries_scrub, below).
  if new.recipient is distinct from old.recipient
     and not (new.recipient is null
              and coalesce(current_setting('wovenne.order_email_scrub', true), '') = 'on') then
    raise exception 'order_email_deliveries: identity columns are immutable';
  end if;

  if old.payload_sha256 is not null then
    if new.payload_sha256 is distinct from old.payload_sha256
       or new.subject is distinct from old.subject then
      raise exception 'order_email_deliveries: the payload is frozen';
    end if;
    if (new.html_body is distinct from old.html_body or new.text_body is distinct from old.text_body) then
      if new.html_body is not null or new.text_body is not null
         or new.status not in ('accepted', 'failed', 'expired') then
        raise exception 'order_email_deliveries: the payload is frozen (only a finished row may be purged)';
      end if;
    end if;
  elsif new.payload_sha256 is not null then
    if new.subject is null or new.html_body is null or new.text_body is null then
      raise exception 'order_email_deliveries: the payload must be written whole';
    end if;
  elsif new.subject is not null or new.html_body is not null or new.text_body is not null then
    raise exception 'order_email_deliveries: payload without a hash';
  end if;

  if old.status = 'accepted' and new.status <> 'accepted' then
    raise exception 'order_email_deliveries: an accepted row stays accepted';
  end if;
  if old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'order_email_deliveries: provider_message_id is immutable once set';
  end if;
  if old.first_provider_request_at is not null
     and new.first_provider_request_at is distinct from old.first_provider_request_at then
    raise exception 'order_email_deliveries: first_provider_request_at is immutable once set';
  end if;
  if old.possibly_accepted and not new.possibly_accepted then
    raise exception 'order_email_deliveries: possibly_accepted cannot be cleared';
  end if;

  new.updated_at := now();
  return new;
end
$fn$;

revoke execute on function public.order_email_deliveries_guard() from public, anon, authenticated;

create trigger order_email_deliveries_guard
  before update on public.order_email_deliveries
  for each row execute function public.order_email_deliveries_guard();

-- ── Enqueue: the confirmation claim and the row, in one transaction ──
-- Returns (delivery_id, created).
--   created = true   this call claimed confirmation_sent_at and made the row;
--   created = false  already claimed: the existing row's id, or NULL for an
--                    order claimed before 0074 (no row, never retried here).
-- Refuses (returns no claim) unless the order is paid. A NULL or blank email
-- still claims and creates the row, already failed, so the gap is on record.
--
-- ORDERS FROM BEFORE THE CLAIM EXISTED ARE NEVER CLAIMED HERE. 0058 added
-- confirmation_sent_at on 19 Sep 2026 (15:33 UTC) without a backfill, and the
-- code that sends emails without recording a claim kept serving until the
-- claim code went live: Production deployment 6545021408 of 459324c, reported
-- successful at 19:51:09 and 20:01:58 UTC. So an order created before then may
-- have been emailed with NULL left behind, and a replayed callback or late
-- webhook for it must not email that customer again.
--
-- The boundary is 2026-09-19 21:00:00 UTC: the later success, rounded up by
-- almost an hour for overlapping deployments and requests still in flight.
-- From then on every confirmation the application sent was claimed first, so
-- confirmation_sent_at NULL means no email was sent and a claim now is a first
-- confirmation, not a repeat. It is a fixed point in the shop's history, NOT a
-- distance from this migration: a first payment can legitimately settle days
-- after its order was created (Razorpay orders do not expire, late
-- authorisation can be captured for up to 3 days, webhooks retry for 24 h).
--
-- An order created before the boundary that settles for the FIRST time now
-- (a six-week-old Razorpay order paid today) gets no automatic email. That is
-- deliberate — whether its customer was already emailed cannot be known — and
-- needs a person to look (WP-EMAIL R1b).
create function public.enqueue_order_confirmation(p_order_id uuid)
returns table (delivery_id uuid, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_email text;
  v_id uuid;
begin
  update orders
     set confirmation_sent_at = now()
   where id = p_order_id
     and confirmation_sent_at is null
     and payment_status = 'paid'
     and created_at >= timestamptz '2026-09-19 21:00:00+00'
  returning customer_email into v_email;

  if found then
    insert into order_email_deliveries (order_id, generation, idempotency_key, recipient, status,
                                        last_error_code)
    values (p_order_id, 1, 'order-confirmation/' || p_order_id::text || '/1',
            nullif(btrim(coalesce(v_email, '')), ''),
            case when nullif(btrim(coalesce(v_email, '')), '') is null then 'failed' else 'pending' end,
            case when nullif(btrim(coalesce(v_email, '')), '') is null then 'no_recipient' end)
    on conflict (order_id, kind, generation) do nothing
    returning id into v_id;
    if v_id is not null then
      return query select v_id, true;
      return;
    end if;
    -- confirmation_sent_at had been cleared (admins may update orders) but the
    -- row exists: re-claiming is harmless, a second row is not. The existing
    -- row decides, exactly as for any other repeat.
  end if;

  select d.id into v_id
    from order_email_deliveries d
   where d.order_id = p_order_id and d.kind = 'order_confirmation' and d.generation = 1;
  return query select v_id, false;
end
$fn$;

-- ── Claim: at most one active attempt ──
-- Returns the row with a fresh lease, or nothing when no attempt is due:
-- finished, already leased, waiting for its backoff, or out of attempts. A
-- lease that ran out is an abandoned attempt and is taken over; if it had
-- already started a request, the row becomes possibly_accepted.
--
-- THE WINDOW. A row that may have been accepted is retried only while less
-- than 23 hours have passed since its FIRST request (Resend keeps keys for 24;
-- the earliest request is the conservative anchor). After that it becomes
-- expired and is never retried automatically.
create function public.claim_order_email_delivery(p_delivery_id uuid, p_lease_seconds integer default 90)
returns setof public.order_email_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  d order_email_deliveries;
  v_possibly boolean;
begin
  if p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 600 then
    raise exception 'claim_order_email_delivery: lease must be 15–600 seconds';
  end if;

  select * into d from order_email_deliveries where id = p_delivery_id for update;
  if not found then
    return;
  end if;
  if d.status in ('accepted', 'failed', 'expired') then
    return;
  end if;
  if d.status = 'sending' and d.lease_expires_at > now() then
    return;  -- an attempt is in progress
  end if;
  if d.status <> 'sending' and d.next_attempt_at > now() then
    return;  -- backing off
  end if;

  -- An abandoned lease that had already sent a request may have been accepted.
  v_possibly := d.possibly_accepted
                or (d.status = 'sending' and d.last_provider_request_at is not null);

  if v_possibly and d.first_provider_request_at is not null
     and now() >= d.first_provider_request_at + interval '23 hours' then
    update order_email_deliveries
       set status = 'expired', possibly_accepted = true, lease_token = null, lease_expires_at = null,
           last_error_code = 'idempotency_window_passed',
           html_body = null, text_body = null,
           payload_purged_at = case when html_body is not null then now() else payload_purged_at end
     where id = d.id;
    return;
  end if;

  if d.attempts >= 5 then
    update order_email_deliveries
       set status = case when v_possibly then 'expired' else 'failed' end,
           possibly_accepted = v_possibly, lease_token = null, lease_expires_at = null,
           last_error_code = 'max_attempts',
           html_body = null, text_body = null,
           payload_purged_at = case when html_body is not null then now() else payload_purged_at end
     where id = d.id;
    return;
  end if;

  return query
    update order_email_deliveries
       set status = 'sending',
           possibly_accepted = v_possibly,
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           attempts = attempts + 1
     where id = d.id
    returning *;
end
$fn$;

-- ── Begin a request: freeze the payload, stamp the time ──
-- Only the current lease holder. The first call stores the payload; every later
-- call ignores what it is given and returns the stored one, so a retry sends
-- byte-for-byte what the first request sent. Returns nothing if the lease was
-- lost, in which case the caller must not send.
create function public.begin_order_email_request(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_subject text,
  p_html text,
  p_text text,
  p_sha256 text
)
returns table (recipient text, subject text, html_body text, text_body text, idempotency_key text)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  d order_email_deliveries;
begin
  select * into d from order_email_deliveries o
   where o.id = p_delivery_id and o.lease_token = p_lease_token
     and o.status = 'sending' and o.lease_expires_at > now()
   for update;
  if not found then
    return;
  end if;

  if d.payload_sha256 is null then
    if p_subject is null or p_html is null or p_text is null or p_sha256 is null then
      raise exception 'begin_order_email_request: a first request needs the whole payload';
    end if;
    update order_email_deliveries o
       set subject = p_subject, html_body = p_html, text_body = p_text, payload_sha256 = p_sha256
     where o.id = d.id;
  elsif d.html_body is null then
    raise exception 'begin_order_email_request: the payload of % was purged; it cannot be resent', d.id;
  end if;

  update order_email_deliveries o
     set first_provider_request_at = coalesce(o.first_provider_request_at, now()),
         last_provider_request_at = now()
   where o.id = d.id;

  return query
    select o.recipient, o.subject, o.html_body, o.text_body, o.idempotency_key
      from order_email_deliveries o where o.id = d.id;
end
$fn$;

-- ── Record the outcome ──
-- accepted is a fact about Resend and is recorded even from an attempt whose
-- lease has been taken over (the key makes both attempts the same email). Every
-- other outcome is recorded only by the current lease holder; a stale attempt
-- learns false and changes nothing.
create function public.record_order_email_outcome(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_http_status integer default null,
  p_error_code text default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  d order_email_deliveries;
  v_backoff interval;
begin
  if p_outcome not in ('accepted', 'uncertain', 'retryable', 'failed') then
    raise exception 'record_order_email_outcome: unknown outcome %', p_outcome;
  end if;

  select * into d from order_email_deliveries where id = p_delivery_id for update;
  if not found then
    return false;
  end if;

  if p_outcome = 'accepted' then
    if d.status = 'accepted' then
      return false;
    end if;
    if d.payload_sha256 is null or d.first_provider_request_at is null then
      raise exception 'record_order_email_outcome: accepted without a recorded request';
    end if;
    update order_email_deliveries
       set status = 'accepted', accepted_at = now(),
           provider_message_id = coalesce(provider_message_id, left(p_provider_message_id, 200)),
           last_http_status = p_http_status, last_error_code = null, last_error = null,
           lease_token = null, lease_expires_at = null,
           html_body = null, text_body = null,
           payload_purged_at = case when html_body is not null then now() else payload_purged_at end
     where id = d.id;
    return true;
  end if;

  if d.status <> 'sending' or d.lease_token is distinct from p_lease_token then
    return false;
  end if;

  v_backoff := case d.attempts
                 when 1 then interval '30 seconds'
                 when 2 then interval '2 minutes'
                 when 3 then interval '10 minutes'
                 else interval '1 hour'
               end;

  update order_email_deliveries
     set status = p_outcome,
         possibly_accepted = possibly_accepted or p_outcome = 'uncertain',
         next_attempt_at = case when p_outcome = 'failed' then next_attempt_at else now() + v_backoff end,
         last_http_status = p_http_status,
         last_error_code = left(p_error_code, 64),
         last_error = left(p_error, 300),
         lease_token = null, lease_expires_at = null,
         html_body = case when p_outcome = 'failed' then null else html_body end,
         text_body = case when p_outcome = 'failed' then null else text_body end,
         payload_purged_at = case when p_outcome = 'failed' and html_body is not null then now() else payload_purged_at end
   where id = d.id;
  return true;
end
$fn$;

-- ── Retention backstop: rows that never finish ──
-- An unfinished row older than p_older_than (default 48 h, never under 24 h)
-- that holds no live lease is closed: expired if a request may have been
-- accepted, failed (stale) if not. Its payload is dropped either way. Returns
-- the number closed. Called by the recovery sweep once it exists (R1c); not
-- scheduled by this migration.
create function public.expire_stale_order_email_deliveries(p_older_than interval default interval '48 hours')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  n integer;
begin
  if p_older_than is null or p_older_than < interval '24 hours' then
    raise exception 'expire_stale_order_email_deliveries: refusing to close rows younger than 24 hours';
  end if;
  update order_email_deliveries
     set status = case when possibly_accepted or first_provider_request_at is not null then 'expired' else 'failed' end,
         possibly_accepted = possibly_accepted or first_provider_request_at is not null,
         last_error_code = 'stale',
         lease_token = null, lease_expires_at = null,
         html_body = null, text_body = null,
         payload_purged_at = case when html_body is not null then now() else payload_purged_at end
   where status in ('pending', 'sending', 'uncertain', 'retryable')
     and created_at < now() - p_older_than
     and not (status = 'sending' and lease_expires_at > now());
  get diagnostics n = row_count;
  return n;
end
$fn$;

-- ── Recovery worker support (R1c-min) ──
create table public.order_email_recovery_settings (
  singleton             boolean primary key default true check (singleton),
  orphan_recovery_since timestamptz not null default now()
);
comment on table public.order_email_recovery_settings is
  'One row. orphan_recovery_since: when 0074 was applied. The recovery worker
   enqueues only paid orders created at or after it, never historical ones.';
insert into public.order_email_recovery_settings default values;
alter table public.order_email_recovery_settings enable row level security;
revoke all on public.order_email_recovery_settings from public, anon, authenticated, service_role;
grant select on public.order_email_recovery_settings to service_role;

-- Keeps the orphan scan to the few paid orders without a claim.
create index orders_unconfirmed_paid_idx
  on public.orders (created_at)
  where payment_status = 'paid' and confirmation_sent_at is null;
create index order_email_deliveries_lease_idx
  on public.order_email_deliveries (lease_expires_at)
  where status = 'sending';

-- Rows due an attempt now, by the database clock: waiting rows past their
-- backoff, and attempts whose lease ran out. The claim re-checks everything
-- (window, attempts, lease) under a row lock, so a stale list is harmless.
create function public.list_due_order_email_deliveries(p_limit integer default 10)
returns table (delivery_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select d.id
    from order_email_deliveries d
   where (d.status in ('pending', 'retryable', 'uncertain') and d.next_attempt_at <= now())
      or (d.status = 'sending' and d.lease_expires_at <= now())
   order by case when d.status = 'sending' then d.lease_expires_at else d.next_attempt_at end, d.created_at
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$fn$;

-- Paid orders that settlement should have enqueued and did not (the
-- enqueue failed, or the code ran before this migration). Same eligibility as
-- settleOrder (paid, has lines) plus: an online Razorpay order (in-person
-- orders never get this email), not cancelled, and created at or after the
-- cutoff. Ordered oldest first, at most 50.
create function public.list_unqueued_paid_orders(p_limit integer default 10)
returns table (order_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select o.id
    from orders o
   where o.payment_status = 'paid'
     and o.confirmation_sent_at is null
     and o.created_at >= (select s.orphan_recovery_since from order_email_recovery_settings s where s.singleton)
     and o.payment_provider = 'razorpay'
     and o.razorpay_order_id is not null
     and o.status <> 'cancelled'
     -- CASE, not AND: SQL does not promise to test the type first, and one
     -- order with a non-array items value must not break the whole scan.
     and case when jsonb_typeof(o.items) = 'array' then jsonb_array_length(o.items) > 0 else false end
     and not exists (select 1 from order_email_deliveries d where d.order_id = o.id)
   order by o.created_at
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$fn$;

-- Counts only — no ids, addresses or content — over the last 8 days.
create function public.order_email_delivery_summary()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'due', count(*) filter (where (status in ('pending', 'retryable', 'uncertain') and next_attempt_at <= now())
                                or (status = 'sending' and lease_expires_at <= now())),
    'in_progress', count(*) filter (where status = 'sending' and lease_expires_at > now()),
    'waiting', count(*) filter (where status in ('pending', 'retryable', 'uncertain') and next_attempt_at > now()),
    'accepted', count(*) filter (where status = 'accepted'),
    'failed', count(*) filter (where status = 'failed'),
    'expired', count(*) filter (where status = 'expired'),
    'oldest_due_seconds', coalesce(floor(extract(epoch from now() - min(
        case when status in ('pending', 'retryable', 'uncertain') and next_attempt_at <= now() then next_attempt_at
             when status = 'sending' and lease_expires_at <= now() then lease_expires_at end))), 0)
  )
  from order_email_deliveries
  where created_at >= now() - interval '8 days';
$fn$;

-- ── Anonymisation: when an order loses its email, so do its deliveries ──
-- delete_my_account (0033) nulls customer_email (with name, phone, address).
-- Without this, the delivery row would keep the address and the rendered
-- email. Fires on any update that empties customer_email, whoever makes it;
-- SECURITY DEFINER so it works whichever role updated the order.
create function public.order_email_deliveries_scrub()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform set_config('wovenne.order_email_scrub', 'on', true);
  update order_email_deliveries
     set recipient = null,
         html_body = null, text_body = null,
         payload_purged_at = case when html_body is not null then now() else payload_purged_at end,
         last_error = null,
         status = case when status in ('accepted', 'failed', 'expired') then status
                       when possibly_accepted or first_provider_request_at is not null then 'expired'
                       else 'failed' end,
         possibly_accepted = possibly_accepted or first_provider_request_at is not null,
         last_error_code = case when status in ('accepted', 'failed', 'expired') then last_error_code
                                else 'customer_anonymised' end,
         lease_token = null, lease_expires_at = null
   where order_id = new.id;
  perform set_config('wovenne.order_email_scrub', '', true);
  return null;
end
$fn$;

revoke execute on function public.order_email_deliveries_scrub() from public, anon, authenticated;

create trigger order_email_deliveries_scrub
  after update of customer_email on public.orders
  for each row
  when (old.customer_email is not null and new.customer_email is null)
  execute function public.order_email_deliveries_scrub();

revoke execute on function public.enqueue_order_confirmation(uuid) from public, anon, authenticated;
revoke execute on function public.claim_order_email_delivery(uuid, integer) from public, anon, authenticated;
revoke execute on function public.begin_order_email_request(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.record_order_email_outcome(uuid, uuid, text, text, integer, text, text) from public, anon, authenticated;
revoke execute on function public.expire_stale_order_email_deliveries(interval) from public, anon, authenticated;
revoke execute on function public.list_due_order_email_deliveries(integer) from public, anon, authenticated;
revoke execute on function public.list_unqueued_paid_orders(integer) from public, anon, authenticated;
revoke execute on function public.order_email_delivery_summary() from public, anon, authenticated;
grant execute on function public.enqueue_order_confirmation(uuid) to service_role;
grant execute on function public.claim_order_email_delivery(uuid, integer) to service_role;
grant execute on function public.begin_order_email_request(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.record_order_email_outcome(uuid, uuid, text, text, integer, text, text) to service_role;
grant execute on function public.expire_stale_order_email_deliveries(interval) to service_role;
grant execute on function public.list_due_order_email_deliveries(integer) to service_role;
grant execute on function public.list_unqueued_paid_orders(integer) to service_role;
grant execute on function public.order_email_delivery_summary() to service_role;

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
  r text;
  f regprocedure;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.order_email_deliveries'::regclass) then
    problems := problems || 'RLS is off on order_email_deliveries'::text;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_email_deliveries') then
    problems := problems || 'order_email_deliveries has a policy'::text;
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.order_email_deliveries', 'SELECT')
       or has_table_privilege(r, 'public.order_email_deliveries', 'INSERT')
       or has_table_privilege(r, 'public.order_email_deliveries', 'UPDATE')
       or has_table_privilege(r, 'public.order_email_deliveries', 'DELETE') then
      problems := problems || (r || ' has a privilege on order_email_deliveries');
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.order_email_deliveries', 'SELECT') then
    problems := problems || 'service_role cannot read order_email_deliveries'::text;
  end if;
  if has_table_privilege('service_role', 'public.order_email_deliveries', 'INSERT')
     or has_table_privilege('service_role', 'public.order_email_deliveries', 'UPDATE')
     or has_table_privilege('service_role', 'public.order_email_deliveries', 'DELETE') then
    problems := problems || 'service_role can write order_email_deliveries directly'::text;
  end if;
  foreach f in array array[
    'public.enqueue_order_confirmation(uuid)'::regprocedure,
    'public.claim_order_email_delivery(uuid, integer)'::regprocedure,
    'public.begin_order_email_request(uuid, uuid, text, text, text, text)'::regprocedure,
    'public.record_order_email_outcome(uuid, uuid, text, text, integer, text, text)'::regprocedure,
    'public.expire_stale_order_email_deliveries(interval)'::regprocedure,
    'public.list_due_order_email_deliveries(integer)'::regprocedure,
    'public.list_unqueued_paid_orders(integer)'::regprocedure,
    'public.order_email_delivery_summary()'::regprocedure
  ] loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE') then
      problems := problems || (f::text || ' is executable by anon or authenticated');
    end if;
    if not has_function_privilege('service_role', f, 'EXECUTE') then
      problems := problems || (f::text || ' is not executable by service_role');
    end if;
    if not (select prosecdef and coalesce(proconfig, '{}') @> array['search_path=public, pg_temp']
              from pg_proc where oid = f) then
      problems := problems || (f::text || ' is not SECURITY DEFINER with search_path=public, pg_temp');
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgname = 'order_email_deliveries_guard'
                   and tgrelid = 'public.order_email_deliveries'::regclass and tgenabled = 'O') then
    problems := problems || 'the immutability trigger is missing or disabled'::text;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'order_email_deliveries_scrub'
                   and tgrelid = 'public.orders'::regclass and tgenabled = 'O') then
    problems := problems || 'the anonymisation trigger on orders is missing or disabled'::text;
  end if;
  if not (select prosecdef and coalesce(proconfig, '{}') @> array['search_path=public, pg_temp']
            from pg_proc where oid = 'public.order_email_deliveries_scrub()'::regprocedure) then
    problems := problems || 'order_email_deliveries_scrub() is not SECURITY DEFINER with a pinned search_path'::text;
  end if;
  if (select count(*) from public.order_email_recovery_settings) <> 1 then
    problems := problems || 'order_email_recovery_settings must hold exactly one row'::text;
  end if;
  if has_table_privilege('anon', 'public.order_email_recovery_settings', 'SELECT')
     or has_table_privilege('authenticated', 'public.order_email_recovery_settings', 'SELECT')
     or has_table_privilege('service_role', 'public.order_email_recovery_settings', 'UPDATE') then
    problems := problems || 'order_email_recovery_settings is readable by the API or writable by service_role'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0074_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select
  (select relrowsecurity from pg_class where oid = 'public.order_email_deliveries'::regclass) as rls_on,
  has_table_privilege('anon', 'public.order_email_deliveries', 'SELECT') as anon_select_must_be_false,
  has_table_privilege('authenticated', 'public.order_email_deliveries', 'SELECT') as authenticated_select_must_be_false,
  has_table_privilege('service_role', 'public.order_email_deliveries', 'SELECT') as service_role_select,
  has_table_privilege('service_role', 'public.order_email_deliveries', 'UPDATE') as service_role_update_must_be_false,
  (select count(*) from public.order_email_deliveries) as rows_must_be_zero,
  (select orphan_recovery_since from public.order_email_recovery_settings) as orphan_recovery_since;
