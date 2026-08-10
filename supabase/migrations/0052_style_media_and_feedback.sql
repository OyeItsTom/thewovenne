-- 0052 — Somewhere to put customer photographs, and permission to say why
--
-- 0047 built the rules about whose photograph goes up. This builds the three
-- things the UI cannot exist without: a bucket customers may write to, the
-- dimensions needed to lay their photographs out, and a rejection the customer
-- is actually told about.
--
-- ── 1. A BUCKET CUSTOMERS MAY WRITE TO ────────
--
-- The only bucket until now is `product-images`, and 0005 gated its writes on
-- is_admin(). Customers therefore had nowhere to upload to at all — the schema
-- for submissions existed while the act of submitting was impossible.
--
-- EACH CUSTOMER WRITES INSIDE THEIR OWN FOLDER, enforced by the policy rather
-- than by the upload path choosing a sensible name. A single shared prefix would
-- let anyone who guessed a filename overwrite somebody else's photograph, and
-- "the client always uses a uuid" is not a rule the database can hold.
--
-- ── 2. DIMENSIONS ─────────────────────────────
--
-- A staggered gallery has to know the shape of each photograph before it loads,
-- or every image lands and shoves the page down as it goes. Captured at upload,
-- stored here. Null for a video-only submission, which is why they are nullable
-- and constrained together rather than made NOT NULL.
--
-- ── 3. THE REJECTION REVERSAL ─────────────────
--
-- 0047 recorded reject_reason with the comment "Internal. The customer is not
-- told why, by decision — see the brief." THAT DECISION IS REVERSED HERE, on the
-- owner's instruction: a customer who took the trouble to send a photograph is
-- told why it was not used and invited to send another.
--
-- The old decision is not deleted from 0047 — a migration is history and
-- rewriting it would hide that the decision was ever made. It is superseded
-- here, and the column comment now says so.
--
-- SILENT REJECTION SURVIVES, and matters: spam and worse must be removable
-- without writing a courteous note about it. A rejection with no reason sends
-- nothing, and that is the whole mechanism — the admin screen offers it as a
-- separate button rather than as an empty text box.

-- ══ 1. The bucket ═════════════════════════════
insert into storage.buckets (id, name, public)
values ('style-photos', 'style-photos', true)
on conflict (id) do nothing;

-- Public read: the gallery is a public page, and a signed URL per photograph
-- would be a per-render round trip for content whose whole purpose is to be
-- seen by anyone.
drop policy if exists "Style photos are publicly readable" on storage.objects;
create policy "Style photos are publicly readable"
  on storage.objects for select
  using (bucket_id = 'style-photos');

-- A customer writes ONLY inside a folder named for their own user id. The path
-- is therefore not a convention the client is trusted to follow: a request that
-- names anyone else's folder is refused by the database.
drop policy if exists "Customers upload their own style photos" on storage.objects;
create policy "Customers upload their own style photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'style-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Removal is an admin act, because the reason to remove a file is moderation.
-- A customer withdrawing consent sets withdrawn_at, which takes the photograph
-- off the site immediately (0047) — the file lingering is not what publishes it.
drop policy if exists "Admins remove style photos" on storage.objects;
create policy "Admins remove style photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'style-photos' and public.is_admin());

-- ══ 2. Dimensions ═════════════════════════════
alter table style_submissions
  add column if not exists photo_width  integer,
  add column if not exists photo_height integer;

comment on column style_submissions.photo_width is
  'Pixel width as uploaded, for laying the gallery out before the image loads.
   Null when the submission is a video link only.';

-- WRITTEN SO IT CANNOT EVALUATE TO NULL, and the first version did.
--
--   (both null) or (width between … and height between …)
--
-- reads correctly and does not work: with a width and no height, the first
-- branch is false and the second is `true and null` = null, so the whole
-- expression is null — and a CHECK passes on null, because it only refuses
-- FALSE. Half a pair of dimensions went straight in. Caught by exercising the
-- constraint rather than reading it, which is the only way this ever shows up.
--
-- Same three-valued trap that took down every non-form signup in 0026 and was
-- fixed with coalesce in 0030. Comparing the two IS NULL tests can only be true
-- or false, and the bounds are coalesced so they cannot contribute a null.
do $$ begin
  alter table style_submissions add constraint style_dimensions_together check (
    (photo_width is null) = (photo_height is null)
    and coalesce(photo_width, 1) between 1 and 20000
    and coalesce(photo_height, 1) between 1 and 20000
  );
exception when duplicate_object then null; end $$;

-- ══ 3. Rejection the customer hears about ═════
alter table style_submissions
  add column if not exists rejection_emailed_at timestamptz;

comment on column style_submissions.reject_reason is
  'Why it was not used, IN WORDS THE CUSTOMER READS. Supersedes 0047, which kept
   this internal — see the header of migration 0052. Null means a silent
   rejection: nothing is sent, which is what spam gets.';

comment on column style_submissions.rejection_emailed_at is
  'When the customer was told. Set by the application after Resend accepts the
   message, so a failed send can be retried and a successful one is never sent
   twice.';

do $$ begin
  alter table style_submissions add constraint style_emailed_only_when_rejected check (
    rejection_emailed_at is null
    or (status = 'rejected' and reject_reason is not null)
  );
exception when duplicate_object then null; end $$;

-- ══ The public view, with shapes ═══════════════
-- Re-declared to carry the dimensions. Still the single definition of "publicly
-- visible", and the three conditions are unchanged.
--
-- THE NEW COLUMNS GO ON THE END, not beside photo_url where they read better.
-- `create or replace view` may only append: inserting a column mid-list is
-- rejected as "cannot change name of view column", and the alternative — drop
-- and recreate — would drop the grants with it and leave the gallery unreadable
-- if anything failed in between. Callers select by name, so the order costs
-- nothing.
create or replace view public_style_submissions as
  select s.id, s.product_id, s.photo_url, s.video_platform, s.video_url,
         s.caption, s.credit_name, s.created_at,
         p.name as product_name, p.slug as product_slug,
         s.photo_width, s.photo_height
    from style_submissions s
    join products p on p.id = s.product_id
   where s.status = 'approved'
     and s.consented_at is not null
     and s.withdrawn_at is null;

grant select on public_style_submissions to anon, authenticated;

-- ══ Moderation, with the notification reset ════
-- Unchanged from 0047 except the last line: moving a submission to rejected
-- clears rejection_emailed_at, so a second rejection with a new reason is a new
-- thing to tell the customer rather than one silently suppressed by the first.
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

-- The application stamps rejection_emailed_at after Resend accepts, so that one
-- column joins withdrawn_at as something a non-admin session may write. Scoped
-- by the existing admin policy for admins; the send itself runs server-side.
grant update (withdrawn_at, rejection_emailed_at) on style_submissions to authenticated;

-- Dimensions are written by the customer as part of their own submission.
grant insert on style_submissions to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from storage.buckets where id = 'style-photos') as bucket,
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('Style photos are publicly readable',
                         'Customers upload their own style photos',
                         'Admins remove style photos')) as storage_policies,
  (select count(*) from information_schema.columns
    where table_name = 'style_submissions'
      and column_name in ('photo_width', 'photo_height', 'rejection_emailed_at')) as new_columns,
  (select count(*) from pg_constraint
    where conname in ('style_dimensions_together', 'style_emailed_only_when_rejected')) as new_checks,
  (select count(*) from information_schema.columns
    where table_name = 'public_style_submissions'
      and column_name in ('photo_width', 'photo_height')) as view_carries_dimensions,
  (select count(*) from pg_proc where proname = 'moderate_style'
    and prosrc like '%rejection_emailed_at%') as moderate_resets_notification,
  (select count(*) from information_schema.column_privileges
    where table_name = 'style_submissions' and grantee = 'authenticated'
      and privilege_type = 'UPDATE') as customer_updatable_columns;
