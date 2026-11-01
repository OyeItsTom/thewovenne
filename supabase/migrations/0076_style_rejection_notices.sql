-- 0076 — Style-photo rejection notices: one durable intent per rejection,
-- an atomic claim, and an honest record of what the email provider said
-- (WP-EMAIL-E5 Stage B).
--
-- WHY. Until now a turned-down photograph was emailed by /api/admin/style/reject
-- every time the route ran, and the only record was rejection_emailed_at, which:
--   * moderate_style() wiped on EVERY call, so a repeated rejection (double
--     press, two tabs, a retry) emailed the customer again;
--   * customers could write themselves (0052 granted UPDATE on it to
--     authenticated, and the "withdraw" policy lets them update their own row);
--   * could only say "accepted": a failure or a lost answer left no trace.
--
-- WHAT THIS ADDS
--   1. style_submissions.rejection_round: bumped by moderate_style() only on a
--      transition INTO rejected, so each rejection event has an immutable
--      identity (submission, round).
--   2. style_rejection_notices: one row per (submission, round) when the
--      rejection carries a customer-visible reason. Created by moderate_style()
--      in the same transaction as the rejection: the intent is durable before
--      any email is attempted. Silent rejections create none.
--   3. claim_style_rejection_notice(): locks the submission and atomically
--      moves the notice pending|failed → claimed. Exactly one caller wins;
--      accepted, claimed (in flight or interrupted) and uncertain are never
--      claimed again.
--   4. begin_style_rejection_send(): immediately before the provider call,
--      re-locks the submission and re-checks eligibility for the claimed
--      round. Still eligible → "sending"; withdrawn, moved out of rejected or
--      a different round → "skipped" (deliberately unsent, with the reason).
--      The claim's own lock ends with its transaction; this is the check that
--      matters for the send.
--   5. record_style_rejection_notice(): sending → accepted | failed | uncertain,
--      whatever the submission has done since: the provider's real answer.
--      Only "accepted" sets rejection_emailed_at, which therefore still means
--      "the provider accepted it", never "claimed" or "queued".
--   6. moderate_style(): row lock; rejected → rejected with the same reason is
--      a no-op; with a different reason it is refused (ALREADY_REJECTED).
--   7. Leaving "rejected" (approval, back to pending, resubmission) marks any
--      unsent intent of that round superseded. History is never deleted or
--      reset by moderation.
--   8. Customers lose UPDATE on rejection_emailed_at; withdrawal is unchanged.
--
-- BACKFILL. A historical rejection that was emailed (stamp set) becomes round 1
-- with an "accepted" notice dated from the stamp. One that was never emailed
-- becomes round 1 with NO notice, so nothing is emailed automatically.
--
-- Additive: no column dropped, no row deleted. approve_style, resubmit_style,
-- the media guard, gallery storage, account deletion: unchanged.

-- ══ 1. The rejection round ═════════════════════
alter table style_submissions
  add column if not exists rejection_round integer not null default 0;

do $$ begin
  alter table style_submissions add constraint style_rejection_round_nonnegative
    check (rejection_round >= 0);
exception when duplicate_object then null; end $$;

comment on column style_submissions.rejection_round is
  'How many times this submission has moved INTO rejected (0076). With the
   submission id it names one rejection event; style_rejection_notices keys on it.';

-- ══ 2. The notice history ══════════════════════
create table if not exists style_rejection_notices (
  id              uuid primary key default gen_random_uuid(),
  -- Cascade: deleting the submission (admin delete, or the customer's account
  -- via auth.users) removes the recipient address with it.
  submission_id   uuid not null references style_submissions(id) on delete cascade,
  round           integer not null check (round > 0),
  -- The reason the email carries, as recorded at rejection. Never edited.
  reason_snapshot text not null check (length(btrim(reason_snapshot)) > 0),
  status          text not null default 'pending'
                  check (status in ('pending', 'claimed', 'sending', 'skipped', 'accepted', 'failed', 'uncertain', 'superseded')),
  attempts        integer not null default 0 check (attempts >= 0),
  -- Read at claim time from the customer's profile; null until claimed, and
  -- for notices backfilled from before 0076 (the address used was not kept).
  recipient_email text,
  claimed_at      timestamptz,
  claimed_by      uuid references auth.users(id) on delete set null,
  accepted_at     timestamptz,
  provider_id     text,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  backfilled      boolean not null default false,
  unique (submission_id, round),
  check (status <> 'accepted' or accepted_at is not null),
  check (status <> 'claimed' or claimed_at is not null)
);

create index if not exists style_rejection_notices_submission_idx
  on style_rejection_notices (submission_id);

comment on table style_rejection_notices is
  'One customer notification intent per rejection event (submission, round),
   with what the email provider said. Written only by SECURITY DEFINER
   functions (0076); admins may read it. accepted = the provider took it, not
   that it was delivered. uncertain = no clear answer; never resent
   automatically.';

-- Transitions, enforced for every writer including service_role:
--   pending  → claimed | superseded
--   failed   → claimed | superseded
--   claimed  → sending | skipped
--   sending  → accepted | failed | uncertain
--   accepted, uncertain, superseded, skipped → nothing
-- and the identity columns never change.
create or replace function public.style_rejection_notice_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.submission_id is distinct from old.submission_id
     or new.round is distinct from old.round
     or new.reason_snapshot is distinct from old.reason_snapshot
     or new.created_at is distinct from old.created_at
     or new.backfilled is distinct from old.backfilled then
    raise exception 'NOTICE_IMMUTABLE: a notice''s identity and reason never change';
  end if;
  if new.status is distinct from old.status and not (
       (old.status in ('pending', 'failed') and new.status in ('claimed', 'superseded'))
    or (old.status = 'claimed' and new.status in ('sending', 'skipped'))
    or (old.status = 'sending' and new.status in ('accepted', 'failed', 'uncertain'))
  ) then
    raise exception 'NOTICE_TRANSITION: % → % is not allowed', old.status, new.status;
  end if;
  if old.status = new.status and old.status in ('accepted', 'uncertain', 'superseded', 'skipped') then
    raise exception 'NOTICE_FINAL: a % notice is final', old.status;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

revoke execute on function public.style_rejection_notice_guard() from public, anon, authenticated;

drop trigger if exists style_rejection_notice_guard on style_rejection_notices;
create trigger style_rejection_notice_guard
  before update on style_rejection_notices
  for each row execute function public.style_rejection_notice_guard();

alter table style_rejection_notices enable row level security;

drop policy if exists "Admins read rejection notices" on style_rejection_notices;
create policy "Admins read rejection notices"
  on style_rejection_notices for select to authenticated
  using (public.is_admin());

-- Read-only for everyone; the functions below are the only writers.
revoke all on table style_rejection_notices from public, anon, authenticated, service_role;
grant select on table style_rejection_notices to authenticated, service_role;

-- ══ 3. Customers no longer write the stamp ═════
-- 0052 granted (withdrawn_at, rejection_emailed_at). Withdrawal stays theirs;
-- the stamp is now written only by record_style_rejection_notice().
revoke update (rejection_emailed_at) on style_submissions from authenticated;
grant update (withdrawn_at) on style_submissions to authenticated;

comment on column style_submissions.rejection_emailed_at is
  'When the email provider ACCEPTED the rejection email for the current round.
   Set only by record_style_rejection_notice() (0076); cleared when the
   submission leaves rejected. Never means claimed or queued. History is in
   style_rejection_notices.';

-- ══ 4. Moderation, locked, with the intent ═════
create or replace function public.moderate_style(
  p_id uuid,
  p_status text,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target    style_submissions%rowtype;
  reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  new_round integer;
begin
  if not public.is_admin() then
    raise exception 'Only admins can moderate submissions';
  end if;
  if p_status not in ('approved', 'rejected', 'pending') then
    raise exception 'Unknown status %', p_status;
  end if;

  -- Serialises with concurrent moderation, approval, claims and resubmission.
  select * into target from style_submissions where id = p_id for update;
  if not found then
    return false;
  end if;

  if p_status = 'approved' and target.consented_at is null then
    raise exception 'That submission has no consent recorded and cannot be published';
  end if;
  if p_status = 'approved' and target.withdrawn_at is not null then
    raise exception 'That customer has withdrawn their consent';
  end if;

  if p_status = 'rejected' and target.status = 'rejected' then
    -- The same rejection again (a double press, a second tab, a retry): nothing
    -- changes, no new round, no new intent.
    if reason is not distinct from target.reject_reason then
      return true;
    end if;
    raise exception 'ALREADY_REJECTED: this submission is already turned down with a different reason. Move it back to pending first if the reason must change.';
  end if;

  new_round := case when p_status = 'rejected' then target.rejection_round + 1 else target.rejection_round end;

  update style_submissions
     set status = p_status,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         reject_reason = case when p_status = 'rejected' then reason else null end,
         rejection_emailed_at = null,
         rejection_round = new_round
   where id = p_id;

  -- A reason is owed to the customer: record the intent now, atomically with
  -- the rejection. A silent rejection records none.
  if p_status = 'rejected' and reason is not null then
    insert into style_rejection_notices (submission_id, round, reason_snapshot)
    values (p_id, new_round, reason)
    on conflict (submission_id, round) do nothing;
  end if;

  return true;
end;
$fn$;

revoke execute on function public.moderate_style(uuid, text, text) from public, anon;
grant execute on function public.moderate_style(uuid, text, text) to authenticated, service_role;

-- ══ 5. Leaving rejected supersedes unsent intents ══
-- approve_style, moderate_style(pending|approved) and resubmit_style all move a
-- submission out of rejected; this one trigger covers them without editing the
-- two functions it does not need to touch. In-flight (claimed, sending) and
-- finished notices are left as they are: a claimed one is turned into
-- "skipped" by begin_style_rejection_send() when it re-checks, and a sending
-- one gets the provider's real answer from record_…().
create or replace function public.style_rejection_supersede()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old.status = 'rejected' and new.status <> 'rejected' then
    update style_rejection_notices
       set status = 'superseded'
     where submission_id = new.id
       and round = old.rejection_round
       and status in ('pending', 'failed');
  end if;
  return null;
end;
$fn$;

revoke execute on function public.style_rejection_supersede() from public, anon, authenticated;

drop trigger if exists style_rejection_supersede on style_submissions;
create trigger style_rejection_supersede
  after update of status on style_submissions
  for each row execute function public.style_rejection_supersede();

-- ══ 6. The claim ═══════════════════════════════
-- Returns jsonb { outcome, ... }. outcome:
--   claimed           this call won; send the email, then record the result
--   already_accepted  the provider already accepted it (accepted_at given)
--   in_progress       claimed or sending and not yet recorded: running now, or
--                     interrupted. Never resent automatically.
--   skipped           a previous claim found it no longer eligible at send time
--   uncertain         an earlier attempt had no clear answer. Never resent.
--   no_recipient      no email address on the customer's profile
--   withdrawn         the customer withdrew the submission
--   not_rejected      it is not (or no longer) rejected
--   silent            rejected without a reason: nothing is owed
--   no_intent         rejected before 0076 and never emailed: not sent
--                     automatically
--   not_found
create or replace function public.claim_style_rejection_notice(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target  style_submissions%rowtype;
  notice  style_rejection_notices%rowtype;
  won     style_rejection_notices%rowtype;
  addr    text;
  person  text;
  piece   text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can notify customers about moderation';
  end if;

  select * into target from style_submissions where id = p_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if target.status <> 'rejected' then
    return jsonb_build_object('outcome', 'not_rejected');
  end if;
  if target.reject_reason is null then
    return jsonb_build_object('outcome', 'silent');
  end if;
  if target.withdrawn_at is not null then
    return jsonb_build_object('outcome', 'withdrawn');
  end if;

  select * into notice from style_rejection_notices
   where submission_id = p_id and round = target.rejection_round;
  if not found then
    return jsonb_build_object('outcome', 'no_intent');
  end if;
  if notice.status = 'accepted' then
    return jsonb_build_object('outcome', 'already_accepted', 'notice_id', notice.id, 'accepted_at', notice.accepted_at);
  end if;
  if notice.status in ('claimed', 'sending') then
    return jsonb_build_object('outcome', 'in_progress', 'notice_id', notice.id, 'claimed_at', notice.claimed_at, 'sending', notice.status = 'sending');
  end if;
  if notice.status = 'skipped' then
    return jsonb_build_object('outcome', 'skipped', 'notice_id', notice.id);
  end if;
  if notice.status = 'uncertain' then
    return jsonb_build_object('outcome', 'uncertain', 'notice_id', notice.id);
  end if;
  if notice.status = 'superseded' then
    return jsonb_build_object('outcome', 'not_rejected');
  end if;

  select nullif(btrim(p.email), ''), nullif(btrim(p.full_name), '')
    into addr, person
    from profiles p where p.id = target.user_id;
  if addr is null then
    return jsonb_build_object('outcome', 'no_recipient', 'notice_id', notice.id);
  end if;

  update style_rejection_notices
     set status = 'claimed',
         attempts = attempts + 1,
         claimed_at = now(),
         claimed_by = auth.uid(),
         recipient_email = addr,
         last_error = null
   where id = notice.id
     and status in ('pending', 'failed')
  returning * into won;
  if not found then
    -- Lost to a concurrent claim (cannot happen under the row lock above, but
    -- the condition is what guarantees it).
    return jsonb_build_object('outcome', 'in_progress', 'notice_id', notice.id);
  end if;

  select coalesce(pv.name, pr.name) into piece
    from products pr
    left join product_versions pv on pv.product_id = pr.id and pv.state = 'published'
   where pr.id = target.product_id;

  return jsonb_build_object(
    'outcome', 'claimed',
    'notice_id', won.id,
    'round', won.round,
    'attempt', won.attempts,
    'recipient', addr,
    'customer_name', person,
    'product_name', piece,
    'reason', won.reason_snapshot
  );
end;
$fn$;

revoke execute on function public.claim_style_rejection_notice(uuid) from public, anon;
grant execute on function public.claim_style_rejection_notice(uuid) to authenticated;

-- ══ 6b. The last check before the provider ══════
-- Called by the route immediately before it hands the email to the provider,
-- in its own short transaction. Locks the submission, then the notice, and
-- re-checks what the claim checked: still rejected with a reason, not
-- withdrawn, still the claimed round, still an address. Eligible → 'sending'
-- and the address to use; otherwise → 'skipped' with the reason, and nothing
-- is sent. A notice not in 'claimed' (already sending or finished) is
-- refused, so one claim can begin at most one send.
--
-- WHAT THIS CANNOT DO: once it commits, a withdrawal or resubmission in the
-- milliseconds before the provider accepts the request is not seen. The
-- provider's answer is still recorded truthfully by record_…() below.
create or replace function public.begin_style_rejection_send(p_notice uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  notice  style_rejection_notices%rowtype;
  target  style_submissions%rowtype;
  addr    text;
  why     text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can notify customers about moderation';
  end if;

  -- The submission first (the same order as moderation and the claim), then
  -- the notice; both locked until this transaction ends.
  select s.* into target
    from style_submissions s
    join style_rejection_notices n on n.submission_id = s.id
   where n.id = p_notice
   for update of s;
  if not found then
    return jsonb_build_object('send', false, 'reason', 'not_found');
  end if;
  select * into notice from style_rejection_notices where id = p_notice for update;
  if notice.status <> 'claimed' then
    raise exception 'NOTICE_NOT_CLAIMED: this notice is %', notice.status;
  end if;

  select nullif(btrim(p.email), '') into addr from profiles p where p.id = target.user_id;

  why := case
    when target.withdrawn_at is not null then 'withdrawn'
    when target.status <> 'rejected' then 'not_rejected'
    when target.rejection_round <> notice.round then 'round_changed'
    when target.reject_reason is null then 'not_rejected'
    when addr is null then 'no_recipient'
    else null
  end;

  if why is not null then
    update style_rejection_notices
       set status = 'skipped', last_error = 'skipped: ' || why
     where id = p_notice;
    return jsonb_build_object('send', false, 'reason', why);
  end if;

  update style_rejection_notices
     set status = 'sending', recipient_email = addr
   where id = p_notice;
  return jsonb_build_object('send', true, 'recipient', addr);
end;
$fn$;

revoke execute on function public.begin_style_rejection_send(uuid) from public, anon;
grant execute on function public.begin_style_rejection_send(uuid) to authenticated;

-- ══ 7. Recording the outcome ═══════════════════
create or replace function public.record_style_rejection_notice(
  p_notice uuid,
  p_outcome text,
  p_provider_id text default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  notice style_rejection_notices%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can notify customers about moderation';
  end if;
  if p_outcome not in ('accepted', 'failed', 'uncertain') then
    raise exception 'Unknown notice outcome %', p_outcome;
  end if;

  select * into notice from style_rejection_notices where id = p_notice for update;
  if not found then
    raise exception 'NOTICE_NOT_FOUND';
  end if;
  -- Only a send that began may be recorded: its outcome is the provider's,
  -- whatever the submission has done since.
  if notice.status <> 'sending' then
    raise exception 'NOTICE_NOT_SENDING: this notice is %', notice.status;
  end if;

  update style_rejection_notices
     set status = p_outcome,
         accepted_at = case when p_outcome = 'accepted' then now() else null end,
         provider_id = left(p_provider_id, 200),
         last_error = left(p_error, 300)
   where id = p_notice;

  -- The stamp keeps its meaning: provider acceptance for the CURRENT round of
  -- a submission that is still rejected with a reason.
  if p_outcome = 'accepted' then
    update style_submissions
       set rejection_emailed_at = now()
     where id = notice.submission_id
       and status = 'rejected'
       and reject_reason is not null
       and rejection_round = notice.round;
  end if;

  return true;
end;
$fn$;

revoke execute on function public.record_style_rejection_notice(uuid, text, text, text) from public, anon;
grant execute on function public.record_style_rejection_notice(uuid, text, text, text) to authenticated;

-- ══ 7b. The admin queue shows the notice ═══════
-- Re-declared from 0073 with three fields appended for the CURRENT round's
-- notice, so an interrupted or uncertain email is visible as needing
-- investigation instead of reading as "not told". Same signature and grants.
create or replace function public.admin_style_submissions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can read the style queue';
  end if;

  select coalesce(jsonb_agg(row_to_json(x) order by x.created_at desc), '[]'::jsonb)
    into result
  from (
    select s.id,
           s.product_id,
           pv.name as product_name,
           pv.slug as product_slug,
           s.photo_url,
           s.photo_path,
           s.photo_width,
           s.photo_height,
           s.video_platform,
           s.video_url,
           s.caption,
           s.credit_name,
           s.status,
           s.consented_at,
           s.withdrawn_at,
           s.reject_reason,
           s.rejection_emailed_at,
           s.reviewed_at,
           s.created_at,
           p.email as customer_email,
           coalesce(nullif(btrim(p.full_name), ''), 'A customer') as customer_name,
           s.admin_notified_at,
           n.status     as rejection_notice_status,
           n.claimed_at as rejection_notice_claimed_at,
           n.attempts   as rejection_notice_attempts
      from style_submissions s
      left join profiles p on p.id = s.user_id
      left join product_versions pv
        on pv.product_id = s.product_id and pv.state = 'published'
      left join style_rejection_notices n
        on n.submission_id = s.id and n.round = s.rejection_round
       and s.status = 'rejected'
  ) x;

  return result;
end;
$fn$;

-- ══ 8. Backfill ════════════════════════════════
-- Every current rejection is round 1. Emailed ones get an accepted notice dated
-- from their stamp; unemailed ones get no notice (never emailed automatically).
update style_submissions
   set rejection_round = 1
 where status = 'rejected'
   and rejection_round = 0;

insert into style_rejection_notices
  (submission_id, round, reason_snapshot, status, attempts, claimed_at, accepted_at, created_at, backfilled)
select s.id, 1, s.reject_reason, 'accepted', 1, s.rejection_emailed_at, s.rejection_emailed_at,
       s.rejection_emailed_at, true
  from style_submissions s
 where s.status = 'rejected'
   and s.reject_reason is not null
   and s.rejection_emailed_at is not null
on conflict (submission_id, round) do nothing;

-- ── Verify ────────────────────────────────────
select
  has_column_privilege('authenticated', 'public.style_submissions', 'rejection_emailed_at', 'UPDATE') as customer_stamp_update_must_be_false,
  has_column_privilege('authenticated', 'public.style_submissions', 'withdrawn_at', 'UPDATE') as customer_withdraw_update_must_be_true,
  has_table_privilege('authenticated', 'public.style_rejection_notices', 'INSERT') as notice_insert_must_be_false,
  has_function_privilege('anon', 'public.claim_style_rejection_notice(uuid)', 'EXECUTE') as anon_claim_must_be_false,
  (select count(*) from style_rejection_notices where backfilled) as backfilled_accepted_notices,
  (select count(*) from style_submissions s
     where s.status = 'rejected' and s.reject_reason is not null and s.rejection_emailed_at is null) as historical_unemailed_not_sent;
