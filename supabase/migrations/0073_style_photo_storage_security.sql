-- 0073 — Customer style photographs: private until approved
--
-- 0052 opened one PUBLIC `style-photos` bucket with three policies. Checked
-- against production on 18 Oct 2026 (0 submissions, 0 objects), it had these
-- holes:
--
--   1. UPLOAD WAS NOT TIED TO A PURCHASE. The insert policy asked only that the
--      path start with the caller's own id. Any signed-in account — and signup
--      is open — could call Storage directly and put any file, of any size and
--      any type, into a public bucket. Free hosting on our bill.
--
--   2. EVERY PHOTOGRAPH WAS PUBLIC FROM THE MOMENT IT WAS UPLOADED. Pending,
--      rejected and withdrawn photographs sat in a public bucket, and a SELECT
--      policy for every role let anybody list them.
--
--   3. NOTHING CHECKED THE BYTES. Storage trusts the declared Content-Type, so a
--      "JPEG" could be anything.
--
--   4. photo_url WAS WHATEVER THE BROWSER SENT, and nothing ever removed a file.
--
-- THE DESIGN
--
--   * TWO BUCKETS. `style-photos` becomes PRIVATE and holds what customers send:
--     <owner>/<product>/<uuid>.jpg. Only an admin may read it (to review, by
--     signed URL). `style-gallery` is PUBLIC and holds only copies of APPROVED
--     photographs: <submission id>/<uuid>.jpg. Nothing pending, rejected or
--     withdrawn is ever in it.
--
--   * NO CUSTOMER WRITES TO STORAGE. There is no INSERT, UPDATE or DELETE policy
--     on either bucket for anyone. Photographs arrive through the application
--     (/api/style/submit), which checks the session, asks
--     style_photo_upload_allowed() (verified purchase, at most five files per
--     piece), decodes the bytes and re-encodes them as a fresh JPEG with sharp,
--     and only then stores the result with the service key. A browser holding a
--     customer session cannot reach either bucket directly.
--
--   * THE DATABASE STILL HAS THE LAST WORD. style_submissions.photo_path names
--     the private original; a trigger refuses any path that is not the
--     submitter's own folder, for that piece, for a file that exists. photo_url
--     is now ONLY the public copy's address: the trigger clears it whenever a
--     submission is not approved-and-not-withdrawn, accepts nothing but this
--     submission's own file in style-gallery, and refuses to approve a
--     photograph without one. approve_style() is how a copy becomes published.
--
--   * BOTH BUCKETS refuse anything but image/jpeg over 4 MiB — a serverless
--     request body tops out near 4.5 MB, and the server's re-encoded output is
--     what is stored.
--
--   * style_photo_garbage() names what should go, in both buckets. Storage
--     deletes only through its API (storage.protect_delete), so the application
--     removes the files at the moment each thing happens — a failed save, a
--     resubmission, withdrawal, rejection or taking it off the site, an admin
--     delete, account deletion — and as a backstop whenever an admin opens the
--     style queue. (No cron: the project keeps none.)
--
-- delete_my_account() and the insert policy of 0047 are unchanged.

-- ══ 1. The buckets ═════════════════════════════
update storage.buckets
   set public             = false,
       file_size_limit    = 4194304,           -- 4 MiB
       allowed_mime_types = array['image/jpeg']
 where id = 'style-photos';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('style-gallery', 'style-gallery', true, 4194304, array['image/jpeg'])
on conflict (id) do update
   set public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- ══ 2. Names ══════════════════════════════════
-- <owner uuid>/<product uuid>/<uuid>.jpg, lowercase, nothing else. Anchored at
-- both ends: no "..", no "//", no ".jpg.html", no leading slash.
create or replace function public.style_photo_name_ok(p_name text, p_owner uuid, p_product uuid)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select coalesce(
    p_name ~ ('^' || p_owner::text || '/' || p_product::text
              || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
    false)
$fn$;

-- <submission uuid>/<uuid>.jpg — the public copy of one approved submission.
create or replace function public.style_gallery_name_ok(p_name text, p_submission uuid)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select coalesce(
    p_name ~ ('^' || p_submission::text
              || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
    false)
$fn$;

-- The one address photo_url may hold. The project is fixed for the life of the
-- database, so it is written down here rather than trusted from a request.
create or replace function public.style_gallery_base()
returns text
language sql
immutable
set search_path = public
as $fn$
  select 'https://wxumlixnmwgeqswknhpw.supabase.co/storage/v1/object/public/style-gallery/'::text
$fn$;

create or replace function public.style_gallery_url_ok(p_url text, p_submission uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((
    left(p_url, length(public.style_gallery_base())) = public.style_gallery_base()
    and public.style_gallery_name_ok(substr(p_url, length(public.style_gallery_base()) + 1), p_submission)
    and exists (
      select 1 from storage.objects o
       where o.bucket_id = 'style-gallery'
         and o.name = substr(p_url, length(public.style_gallery_base()) + 1))
  ), false)
$fn$;

revoke execute on function public.style_photo_name_ok(text, uuid, uuid) from public, anon;
revoke execute on function public.style_gallery_name_ok(text, uuid) from public, anon;
revoke execute on function public.style_gallery_base() from public, anon;
revoke execute on function public.style_gallery_url_ok(text, uuid) from public, anon;

-- ══ 3. May this customer send a photograph of this piece? ══
-- Asked by /api/style/submit with the customer's own session, BEFORE it spends
-- any effort on the bytes. The same verified-purchase rule as the submission
-- itself (0047); a handful of files per piece is room for a retry and a
-- resubmission, not room to host anything.
create or replace function public.style_photo_upload_allowed(p_product uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  me   uuid := auth.uid();
  held integer;
begin
  if me is null or p_product is null then
    return false;
  end if;
  if not public.has_purchased(p_product) then
    return false;
  end if;
  select count(*) into held
    from storage.objects
   where bucket_id = 'style-photos'
     and name like me::text || '/' || p_product::text || '/%';
  return held < 5;
end;
$fn$;

revoke execute on function public.style_photo_upload_allowed(uuid) from public, anon;
grant execute on function public.style_photo_upload_allowed(uuid) to authenticated;

-- ══ 4. Storage policies ════════════════════════
-- 0052's three go. Nobody but the service role writes to either bucket;
-- nobody lists style-gallery (a public bucket serves files by URL without a
-- policy); only an admin reads the private originals, to sign review URLs.
drop policy if exists "Style photos are publicly readable" on storage.objects;
drop policy if exists "Customers upload their own style photos" on storage.objects;
drop policy if exists "Admins remove style photos" on storage.objects;

drop policy if exists "Admins read style submissions" on storage.objects;
create policy "Admins read style submissions"
  on storage.objects for select to authenticated
  using (bucket_id = 'style-photos' and public.is_admin());

-- ══ 5. The submission's two photograph columns ══
alter table style_submissions add column if not exists photo_path text;

comment on column style_submissions.photo_path is
  'The original in the PRIVATE style-photos bucket: <owner>/<product>/<uuid>.jpg,
   stored by /api/style/submit after it re-encoded the bytes. Never public.';
comment on column style_submissions.photo_url is
  'The PUBLIC copy in style-gallery, and only while the submission is approved
   and not withdrawn (0073 trigger). Null otherwise. Set by approve_style().';

alter table style_submissions drop constraint if exists style_has_content;
alter table style_submissions add constraint style_has_content
  check (photo_path is not null or video_url is not null);

create or replace function public.style_submission_media_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- The original: the submitter's own folder, this piece, a file that exists.
  if new.photo_path is not null
     and (tg_op = 'INSERT'
          or new.photo_path is distinct from old.photo_path
          or new.user_id    is distinct from old.user_id
          or new.product_id is distinct from old.product_id) then
    if not public.style_photo_name_ok(new.photo_path, new.user_id, new.product_id)
       or not exists (select 1 from storage.objects o
                       where o.bucket_id = 'style-photos' and o.name = new.photo_path) then
      raise exception 'That photograph did not upload properly. Please choose it again.';
    end if;
  end if;

  -- Not published, no public address. Withdrawal, rejection, "take it off"
  -- and resubmission all land here.
  if new.status <> 'approved' or new.withdrawn_at is not null then
    new.photo_url := null;
  end if;

  -- A public address is only ever this submission's own copy in style-gallery.
  if new.photo_url is not null
     and (tg_op = 'INSERT' or new.photo_url is distinct from old.photo_url) then
    if not public.style_gallery_url_ok(new.photo_url, new.id) then
      raise exception 'That published photograph is not one of ours.';
    end if;
  end if;

  -- A photograph cannot be approved without its public copy.
  if new.status = 'approved' and new.withdrawn_at is null
     and new.photo_path is not null and new.photo_url is null then
    raise exception 'Approve photographs with approve_style, which publishes the copy.';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.style_submission_media_guard() from public, anon, authenticated;

drop trigger if exists style_submission_media_guard on style_submissions;
create trigger style_submission_media_guard
  before insert or update on style_submissions
  for each row execute function public.style_submission_media_guard();

-- ══ 6. Approval publishes a copy ═══════════════
-- Called by /api/admin/style/moderate with the ADMIN'S session, after it has
-- copied the original into style-gallery. is_admin() and reviewed_by come from
-- that session, as in moderate_style.
create or replace function public.approve_style(p_id uuid, p_public_name text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target style_submissions%rowtype;
  url    text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can moderate submissions';
  end if;

  select * into target from style_submissions where id = p_id for update;
  if not found then
    return false;
  end if;
  if target.consented_at is null then
    raise exception 'That submission has no consent recorded and cannot be published';
  end if;
  if target.withdrawn_at is not null then
    raise exception 'That customer has withdrawn their consent';
  end if;

  if target.photo_path is null then
    if p_public_name is not null then
      raise exception 'That submission has no photograph';
    end if;
  else
    if p_public_name is null or not public.style_gallery_name_ok(p_public_name, p_id) then
      raise exception 'The public copy was not made. Try again.';
    end if;
    url := public.style_gallery_base() || p_public_name;   -- the trigger checks it exists
  end if;

  update style_submissions
     set status = 'approved',
         photo_url = url,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         reject_reason = null,
         rejection_emailed_at = null
   where id = p_id;
  return true;
end;
$fn$;

revoke execute on function public.approve_style(uuid, text) from public, anon;
grant execute on function public.approve_style(uuid, text) to authenticated;

-- ══ 7. Resubmission names the new original ═════
-- Re-declared from 0055 with p_photo_path in place of p_photo_url; the trigger
-- checks the path. The parameter is renamed, so the old function is dropped.
drop function if exists public.resubmit_style(uuid, text, integer, integer, text, text, text, text);

create function public.resubmit_style(
  p_id            uuid,
  p_photo_path    text default null,
  p_photo_width   integer default null,
  p_photo_height  integer default null,
  p_video_platform text default null,
  p_video_url     text default null,
  p_caption       text default null,
  p_credit_name   text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target style_submissions%rowtype;
begin
  select * into target from style_submissions where id = p_id;
  if not found then
    return false;
  end if;

  if target.user_id is distinct from auth.uid() then
    raise exception 'That is not your submission';
  end if;

  if target.status = 'approved' then
    raise exception 'That photograph is already published. Withdraw it first if you would like to change it.';
  end if;

  if target.withdrawn_at is not null then
    raise exception 'You have withdrawn that submission. Send a new one instead.';
  end if;

  if not public.has_purchased(target.product_id) then
    raise exception 'Only a verified purchase can be featured';
  end if;

  if coalesce(p_photo_path, p_video_url) is null then
    raise exception 'Add a photograph or a link before sending it again';
  end if;

  update style_submissions
     set photo_path     = p_photo_path,
         photo_width    = p_photo_width,
         photo_height   = p_photo_height,
         video_platform = p_video_platform,
         video_url      = p_video_url,
         caption        = p_caption,
         credit_name    = p_credit_name,
         consented_at   = now(),
         status         = 'pending',
         reject_reason  = null,
         reviewed_at    = null,
         reviewed_by    = null,
         rejection_emailed_at = null,
         admin_notified_at = null
   where id = p_id;

  return true;
end;
$fn$;

revoke execute on function public.resubmit_style(uuid, text, integer, integer, text, text, text, text)
  from public, anon;
grant execute on function public.resubmit_style(uuid, text, integer, integer, text, text, text, text)
  to authenticated;

-- ══ 8. The admin queue carries photo_path ══════
-- Re-declared from 0055; the only addition is s.photo_path, which the queue
-- signs to show the private original.
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

-- ══ 8b. The shop's notice still knows there is a photograph ══
-- Re-declared from 0055; the only change: a pending photograph has no photo_url
-- any more (it is not public), so has_photo reads photo_path.
create or replace function public.claim_style_notification(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  claimed style_submissions%rowtype;
  product_name text;
begin
  update style_submissions
     set admin_notified_at = now()
   where id = p_id
     and user_id = auth.uid()          -- from the session, never an argument
     and status = 'pending'
     and admin_notified_at is null
  returning * into claimed;

  if not found then
    return null;
  end if;

  select pv.name into product_name
    from product_versions pv
   where pv.product_id = claimed.product_id and pv.state = 'published';

  return jsonb_build_object(
    'id', claimed.id,
    'product_name', coalesce(product_name, 'a piece'),
    'caption', claimed.caption,
    'credit_name', claimed.credit_name,
    'has_photo', claimed.photo_path is not null,
    'video_platform', claimed.video_platform
  );
end;
$fn$;

-- ══ 9. What should be removed ══════════════════
-- Names only; the Storage API does the deleting. Service role alone — the list
-- spans every customer.
--
--   style-photos (private originals)
--     owner gone         the account no longer exists                at once
--     consent withdrawn  its submission was withdrawn                at once
--     unused             no submission names it, older than p_grace  (a save
--                        may be in flight; the submit route removes its own
--                        failures at once, so this is for a crashed request)
--   style-gallery (public copies)
--     submission gone    the submission was deleted                  at once
--     not published      not the address of an approved, unwithdrawn
--                        submission                                  at once
create or replace function public.style_photo_garbage(p_grace interval default interval '1 hour')
returns table (bucket text, name text, reason text)
language sql
stable
security definer
set search_path = public
as $fn$
  select o.bucket_id::text, o.name,
         case
           when not exists (select 1 from auth.users u where u.id::text = split_part(o.name, '/', 1))
             then 'owner gone'
           when exists (select 1 from style_submissions s
                         where s.photo_path = o.name and s.withdrawn_at is not null)
             then 'consent withdrawn'
           else 'unused'
         end
    from storage.objects o
   where o.bucket_id = 'style-photos'
     and (
       not exists (select 1 from auth.users u where u.id::text = split_part(o.name, '/', 1))
       or exists (select 1 from style_submissions s
                   where s.photo_path = o.name and s.withdrawn_at is not null)
       or (o.created_at < now() - p_grace
           and not exists (select 1 from style_submissions s where s.photo_path = o.name))
     )
  union all
  select o.bucket_id::text, o.name,
         case
           when not exists (select 1 from style_submissions s where s.id::text = split_part(o.name, '/', 1))
             then 'submission gone'
           else 'not published'
         end
    from storage.objects o
   where o.bucket_id = 'style-gallery'
     and not exists (select 1 from style_submissions s
                      where s.photo_url = public.style_gallery_base() || o.name
                        and s.status = 'approved'
                        and s.withdrawn_at is null)
   order by 1, 2
$fn$;

revoke execute on function public.style_photo_garbage(interval) from public, anon, authenticated;
grant execute on function public.style_photo_garbage(interval) to service_role;

-- ── Verify ────────────────────────────────────
select
  (select public from storage.buckets where id = 'style-photos') as originals_public_must_be_false,
  (select public from storage.buckets where id = 'style-gallery') as gallery_public_true,
  (select array[file_size_limit::text, array_to_string(allowed_mime_types, ',')]
     from storage.buckets where id = 'style-photos') as originals_4mib_jpeg,
  (select array[file_size_limit::text, array_to_string(allowed_mime_types, ',')]
     from storage.buckets where id = 'style-gallery') as gallery_4mib_jpeg,
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and (qual like '%style-%' or with_check like '%style-%')) as style_policies_must_be_1,
  (select count(*) from pg_trigger where tgname = 'style_submission_media_guard') as guard_trigger,
  has_function_privilege('authenticated', 'public.style_photo_garbage(interval)', 'EXECUTE') as garbage_customer_must_be_false;
