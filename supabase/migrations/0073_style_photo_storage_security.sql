-- 0073 — Customer style photographs: who may write, what, and when it goes
--
-- 0052 opened the `style-photos` bucket with three policies. Checked against
-- production on 18 Oct 2026 (0 submissions, 0 objects), they had four holes:
--
--   1. UPLOAD WAS NOT TIED TO A PURCHASE. The insert policy asked only that the
--      path start with the caller's own id. The form appears on delivered
--      orders, but the form is not the boundary: any signed-in account — and
--      signup is open — could call Storage directly and put any file, of any
--      size and any type (the bucket had no limits), into a PUBLIC bucket.
--      Free hosting on our bill, with our domain's trust.
--
--   2. ANYONE COULD LIST THE BUCKET. "Style photos are publicly readable" was a
--      SELECT policy for every role. A public bucket serves files by URL without
--      one; what that policy added was LISTING — so every pending, rejected and
--      withdrawn photograph was discoverable by a stranger.
--
--   3. photo_url WAS WHATEVER THE BROWSER SENT. Neither the insert policy nor
--      resubmit_style looked at it, so a submission could point at any address,
--      and next.config trusts every *.supabase.co project for images.
--
--   4. NOTHING EVER REMOVED A FILE. Deleting an account cascades the submission
--      row away; the photograph stayed at its public URL. So did a photograph
--      whose submission failed to save, one an admin deleted, and one whose
--      owner withdrew consent.
--
-- WHAT THIS DOES
--
--   * The bucket refuses anything but image/jpeg, and anything over 8 MiB —
--     PHOTO_GUIDANCE.maxBytes, the size the form already re-encodes to. The
--     browser always draws to a canvas and exports JPEG, so nothing honest is
--     lost. Storage enforces these on every upload, signed or not.
--   * Upload requires style_photo_upload_allowed(name): the exact shape
--     <your id>/<product id>/<uuid>.jpg, a verified purchase of THAT product
--     (has_purchased — the rule reviews and submissions already use), and
--     fewer than five files already in that folder. No traversal, no second
--     extension, no other folder, no free-form names.
--   * Listing is limited to the owner's own folder and to admins. Files are
--     still served by URL — the approved gallery needs that — but a URL now
--     has to be known: two random uuids nobody but the owner and the shop sees
--     until an admin publishes it.
--   * photo_url must be exactly this bucket's public address for an object
--     that exists, in the submitter's own folder, for the same product.
--   * An owner may remove their OWN file that no submission uses — so the form
--     can clean up after a failed save — and nothing else.
--   * style_photo_garbage() names what should go: files whose owner no longer
--     exists, files of withdrawn submissions, and files nothing has used for a
--     day. Only the service role may call it. Files can only be deleted through
--     the Storage API (storage.protect_delete refuses SQL), so the application
--     does the removing: straight after an account is deleted, after consent
--     is withdrawn, when an admin deletes a submission, and as a backstop
--     whenever an admin opens the style queue. (No cron: the project keeps none.)
--
-- THE BUCKET STAYS PUBLIC. Approved photographs are public by design, on the
-- gallery and product pages, through next/image. A private bucket would mean
-- signing every URL at render time, on ISR pages that cache the HTML longer
-- than a signature lives, and an image optimizer that caches by URL. With
-- listing gone and names unguessable, public-by-URL exposes only what the
-- owner or an admin already holds; withdrawn files are removed by the sweep.
--
-- delete_my_account() is unchanged.

-- ══ 1. The bucket's own limits ═════════════════
update storage.buckets
   set file_size_limit    = 8388608,          -- 8 MiB, PHOTO_GUIDANCE.maxBytes
       allowed_mime_types = array['image/jpeg']
 where id = 'style-photos';

-- ══ 2. Names ══════════════════════════════════
-- The one address photo_url may hold. The project is fixed for the life of the
-- database, so it is written down here rather than trusted from a request.
create or replace function public.style_photo_base()
returns text
language sql
immutable
set search_path = public
as $fn$
  select 'https://wxumlixnmwgeqswknhpw.supabase.co/storage/v1/object/public/style-photos/'::text
$fn$;

-- <owner uuid>/<product uuid>/<uuid>.jpg, lowercase, nothing else. Anchored at
-- both ends, so no "..", no "//", no ".jpg.html", no leading slash.
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

-- Harmless (a constant and a pattern), but nothing outside 0073's own functions
-- needs to call them.
revoke execute on function public.style_photo_base() from public, anon;
revoke execute on function public.style_photo_name_ok(text, uuid, uuid) from public, anon;

-- ══ 3. May this caller upload this object? ═════
create or replace function public.style_photo_upload_allowed(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  me      uuid := auth.uid();
  product uuid;
  held    integer;
begin
  if me is null or p_name is null then
    return false;
  end if;
  -- The product segment is read only after the shape is proven, so the cast
  -- below can never throw on somebody's crafted path.
  if split_part(p_name, '/', 2) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  product := split_part(p_name, '/', 2)::uuid;
  if not public.style_photo_name_ok(p_name, me, product) then
    return false;
  end if;
  -- The same verified-purchase rule as the submission itself (0047). Without
  -- it the bucket was open to every account.
  if not public.has_purchased(product) then
    return false;
  end if;
  -- A handful per piece is room for a retry and a resubmission; it is not room
  -- to host anything. Unused files are swept after a day, which frees the slot.
  select count(*) into held
    from storage.objects
   where bucket_id = 'style-photos'
     and name like me::text || '/' || product::text || '/%';
  return held < 5;
end;
$fn$;

revoke execute on function public.style_photo_upload_allowed(text) from public, anon;
grant execute on function public.style_photo_upload_allowed(text) to authenticated;

-- ══ 4. Is photo_url one of ours, theirs, for this piece? ══
create or replace function public.style_photo_url_ok(p_url text, p_owner uuid, p_product uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select p_url is null or coalesce((
    left(p_url, length(public.style_photo_base())) = public.style_photo_base()
    and public.style_photo_name_ok(substr(p_url, length(public.style_photo_base()) + 1), p_owner, p_product)
    and exists (
      select 1 from storage.objects o
       where o.bucket_id = 'style-photos'
         and o.name = substr(p_url, length(public.style_photo_base()) + 1))
  ), false)
$fn$;

revoke execute on function public.style_photo_url_ok(text, uuid, uuid) from public, anon;
grant execute on function public.style_photo_url_ok(text, uuid, uuid) to authenticated;

-- Used by nothing: no submission's photo_url points at it.
create or replace function public.style_photo_unused(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select not exists (
    select 1 from style_submissions s
     where s.photo_url = public.style_photo_base() || p_name)
$fn$;

revoke execute on function public.style_photo_unused(text) from public, anon;
grant execute on function public.style_photo_unused(text) to authenticated;

-- ══ 5. Storage policies ════════════════════════
drop policy if exists "Style photos are publicly readable" on storage.objects;
drop policy if exists "Owners and admins see style photo records" on storage.objects;
create policy "Owners and admins see style photo records"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'style-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists "Customers upload their own style photos" on storage.objects;
create policy "Customers upload their own style photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'style-photos'
    and public.style_photo_upload_allowed(name)
  );

-- No UPDATE policy, as before: nobody overwrites a photograph in place.
-- "Admins remove style photos" (0052) is unchanged.

drop policy if exists "Owners remove their own unused style photos" on storage.objects;
create policy "Owners remove their own unused style photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'style-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.style_photo_unused(name)
  );

-- ══ 6. Submissions point only at real, own files ══
drop policy if exists "Purchasers submit their own style" on style_submissions;
create policy "Purchasers submit their own style"
  on style_submissions for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.has_purchased(product_id)
    and consented_at is not null
    and status = 'pending'
    and public.style_photo_url_ok(photo_url, user_id, product_id)
  );

-- Re-declared in full from 0055; the only addition is the photo_url check.
create or replace function public.resubmit_style(
  p_id            uuid,
  p_photo_url     text default null,
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

  if coalesce(p_photo_url, p_video_url) is null then
    raise exception 'Add a photograph or a link before sending it again';
  end if;

  -- New in 0073. SECURITY DEFINER steps around the insert policy, so the same
  -- rule is stated here.
  if not public.style_photo_url_ok(p_photo_url, target.user_id, target.product_id) then
    raise exception 'That photograph did not upload properly. Please choose it again.';
  end if;

  update style_submissions
     set photo_url      = p_photo_url,
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

-- ══ 7. What should be removed ══════════════════
-- Names only; the Storage API does the deleting. Service role alone — the list
-- spans every customer.
create or replace function public.style_photo_garbage(p_grace interval default interval '24 hours')
returns table (name text, reason text)
language sql
stable
security definer
set search_path = public
as $fn$
  select o.name,
         case
           when not exists (select 1 from auth.users u where u.id::text = split_part(o.name, '/', 1))
             then 'owner gone'
           when exists (select 1 from style_submissions s
                         where s.photo_url = public.style_photo_base() || o.name
                           and s.withdrawn_at is not null)
             then 'consent withdrawn'
           else 'unused'
         end
    from storage.objects o
   where o.bucket_id = 'style-photos'
     and (
       not exists (select 1 from auth.users u where u.id::text = split_part(o.name, '/', 1))
       or exists (select 1 from style_submissions s
                   where s.photo_url = public.style_photo_base() || o.name
                     and s.withdrawn_at is not null)
       or (o.created_at < now() - p_grace
           and not exists (select 1 from style_submissions s
                            where s.photo_url = public.style_photo_base() || o.name))
     )
   order by o.name
$fn$;

revoke execute on function public.style_photo_garbage(interval) from public, anon, authenticated;
grant execute on function public.style_photo_garbage(interval) to service_role;

-- ── Verify ────────────────────────────────────
select
  (select file_size_limit from storage.buckets where id = 'style-photos') as size_limit_8mib,
  (select allowed_mime_types from storage.buckets where id = 'style-photos') as mime_jpeg_only,
  (select public from storage.buckets where id = 'style-photos') as still_public,
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and policyname = 'Style photos are publicly readable') as anon_list_policy_must_be_0,
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('Owners and admins see style photo records',
                        'Customers upload their own style photos',
                        'Admins remove style photos',
                        'Owners remove their own unused style photos')) as style_policies_4,
  has_function_privilege('authenticated', 'public.style_photo_garbage(interval)', 'EXECUTE') as garbage_customer_must_be_false;
