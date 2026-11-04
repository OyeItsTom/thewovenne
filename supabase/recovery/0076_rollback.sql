-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK of 0076_style_rejection_notices.sql: guarded. Restores the database
-- as it was after 0075, ONLY when nothing 0076 recorded would be lost.
--
-- NOT A MIGRATION. Do not run it with scripts/run-migration.mjs (that would
-- record this file in the ledger). Use scripts/run-recovery-sql.mjs.
-- Order: 0076 is rolled back FIRST (then 0075, then 0074), never after them.
--
-- PRECONDITIONS (supabase/recovery/README.md):
--   1. Production code is already back on a deployment WITHOUT #223.
--   2. A style-moderation freeze is in force.
--   3. A fresh, verified backup exists.
--
-- REFUSES, changing nothing, if:
--   R1  any rejection notice was recorded after 0076 (pending, claimed,
--       sending, accepted, failed, uncertain, skipped or superseded): that is
--       notification history and delivery evidence;
--   R2  any backfilled notice can no longer be re-derived from its submission
--       (the accepted evidence would exist only in the table being dropped);
--   R3  any submission's rejection_round differs from what the backfill
--       produced: moderation happened after 0076, so the rounds are history.
-- On refusal, FIX FORWARD (supabase/recovery/README.md). Never edit these
-- guards to force a rollback.
--
-- What it restores (exactly 0075's state, verified by tests):
--   moderate_style (0052 text), admin_style_submissions (0073 text), the
--   0052 comment, and authenticated UPDATE on rejection_emailed_at (0052).
--   NOTE: that grant is the pre-0076 posture, which the pre-#223 reject route
--   needs in order to record that it emailed. It lets a customer write the
--   stamp on their own submission again (the 0076 header explains why that
--   was removed). Accepted as the cost of the old code working.
-- What it removes: style_rejection_notices (only backfilled rows, all
--   re-derivable), rejection_round and its check, the claim/begin/record
--   functions, reject_style_with_notice and style_moderate_internal (FU-6),
--   both triggers and their functions, and the 0076 ledger row.
--   It expects the FU-6 version of 0076: against a 0076 without those two
--   functions the DROP fails and the whole rollback changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';

do $guard$
begin
  if to_regclass('public.style_rejection_notices') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'style_submissions'
                       and column_name = 'rejection_round') then
    raise exception '0076 rollback refused: 0076 is not (fully) applied here. Nothing changed.';
  end if;
end $guard$;

-- No moderation, claim or send can interleave with the checks and the drop.
lock table public.style_submissions, public.style_rejection_notices in access exclusive mode;

do $guard$
declare
  late      integer;
  orphaned  integer;
  rounds    integer;
begin
  select count(*) into late from public.style_rejection_notices where not backfilled;
  if late > 0 then
    raise exception '0076 rollback refused (R1): % rejection notice(s) were recorded after 0076. That is notification history; fix forward instead. Nothing changed.', late;
  end if;

  select count(*) into orphaned
    from public.style_rejection_notices n
   where not exists (
     select 1 from public.style_submissions s
      where s.id = n.submission_id
        and s.status = 'rejected'
        and s.rejection_round = 1
        and n.round = 1
        and n.status = 'accepted'
        and s.reject_reason is not distinct from n.reason_snapshot
        and s.rejection_emailed_at is not distinct from n.accepted_at
        and n.recipient_email is null and n.provider_id is null and n.last_error is null);
  if orphaned > 0 then
    raise exception '0076 rollback refused (R2): % backfilled notice(s) no longer match their submission; their accepted evidence would be lost. Fix forward instead. Nothing changed.', orphaned;
  end if;

  select count(*) into rounds
    from public.style_submissions
   where rejection_round <> case when status = 'rejected' then 1 else 0 end;
  if rounds > 0 then
    raise exception '0076 rollback refused (R3): % submission(s) were moderated after 0076 (rejection_round is history). Fix forward instead. Nothing changed.', rounds;
  end if;
end $guard$;

-- ── Remove what 0076 added ─────────────────────
drop trigger style_rejection_supersede on public.style_submissions;
drop function public.style_rejection_supersede();
drop function public.claim_style_rejection_notice(uuid);
drop function public.begin_style_rejection_send(uuid);
drop function public.record_style_rejection_notice(uuid, text, text, text);
-- FU-6: the explained-rejection door and the private body both functions used.
drop function public.reject_style_with_notice(uuid, text);
drop function public.style_moderate_internal(uuid, text, text);
drop table public.style_rejection_notices;          -- its trigger, policy and index go with it
drop function public.style_rejection_notice_guard();
alter table public.style_submissions
  drop constraint style_rejection_round_nonnegative,
  drop column rejection_round;

-- ── Restore 0075's definitions, verbatim ─────────
-- From 0052_style_media_and_feedback.sql:
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
  target style_submissions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can moderate submissions';
  end if;
  if p_status not in ('approved', 'rejected', 'pending') then
    raise exception 'Unknown status %', p_status;
  end if;

  select * into target from style_submissions where id = p_id;
  if not found then
    return false;
  end if;

  if p_status = 'approved' and target.consented_at is null then
    raise exception 'That submission has no consent recorded and cannot be published';
  end if;
  if p_status = 'approved' and target.withdrawn_at is not null then
    raise exception 'That customer has withdrawn their consent';
  end if;

  update style_submissions
     set status = p_status,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         reject_reason = case when p_status = 'rejected' then p_reason else null end,
         rejection_emailed_at = null
   where id = p_id;

  return true;
end;
$fn$;

revoke execute on function public.moderate_style(uuid, text, text) from public, anon;
grant execute on function public.moderate_style(uuid, text, text) to authenticated, service_role;

-- From 0073_style_photo_storage_security.sql (same signature and grants):
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
           s.admin_notified_at
      from style_submissions s
      left join profiles p on p.id = s.user_id
      left join product_versions pv
        on pv.product_id = s.product_id and pv.state = 'published'
  ) x;

  return result;
end;
$fn$;

-- From 0052: the pre-#223 reject route stamps this through the admin's session.
grant update (rejection_emailed_at) on public.style_submissions to authenticated;

-- From 0052:
comment on column style_submissions.rejection_emailed_at is
  'When the customer was told. Set by the application after Resend accepts the
   message, so a failed send can be retried and a successful one is never sent
   twice.';

-- The ledger must say 0076 is not applied, so the runner can apply it again.
delete from public.schema_migrations where filename = '0076_style_rejection_notices.sql';

-- ── Self-check: any failure undoes everything above ──
do $verify$
begin
  if to_regclass('public.style_rejection_notices') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'style_submissions' and column_name = 'rejection_round')
     or to_regprocedure('public.claim_style_rejection_notice(uuid)') is not null
     or to_regprocedure('public.begin_style_rejection_send(uuid)') is not null
     or to_regprocedure('public.record_style_rejection_notice(uuid, text, text, text)') is not null
     or to_regprocedure('public.style_rejection_supersede()') is not null
     or to_regprocedure('public.style_rejection_notice_guard()') is not null
     or exists (select 1 from pg_trigger where tgname in ('style_rejection_supersede', 'style_rejection_notice_guard'))
     or not has_column_privilege('authenticated', 'public.style_submissions', 'rejection_emailed_at', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.style_submissions', 'withdrawn_at', 'UPDATE')
     or has_function_privilege('anon', 'public.moderate_style(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_style_submissions()', 'EXECUTE')
     or (select prosrc from pg_proc where oid = 'public.moderate_style(uuid, text, text)'::regprocedure) like '%rejection_round%'
     or (select prosrc from pg_proc where oid = 'public.admin_style_submissions()'::regprocedure) like '%rejection_notice%'
     or exists (select 1 from public.schema_migrations where filename = '0076_style_rejection_notices.sql') then
    raise exception '0076 rollback self-check failed; everything was undone.';
  end if;
end $verify$;

commit;

select 'ROLLED BACK 0076' as result,
       (select count(*) from public.style_submissions where status = 'rejected') as rejected_submissions,
       (select count(*) from public.style_submissions where rejection_emailed_at is not null) as stamped_submissions;
