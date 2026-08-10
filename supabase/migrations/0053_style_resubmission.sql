-- 0053 — Letting a customer send another photograph
--
-- 0052 decided a rejected customer is told why and invited to try again. The
-- schema does not let them: 0047 grants a customer UPDATE on withdrawn_at alone
-- (0052 added rejection_emailed_at), and a unique index allows one submission
-- per customer per product, so a second INSERT is refused as a duplicate. The
-- invitation in the email would have led to a form that could not save.
--
-- THE OBVIOUS FIX IS THE WRONG ONE. Granting update on photo_url, caption and
-- the rest would let a customer edit a submission that is already APPROVED and
-- public — swapping the photograph an admin agreed to for one nobody has seen.
-- That is the whole moderation model defeated by a column grant.
--
-- So resubmission is a function, and the rules live in it:
--
--   * only your own submission, checked against auth.uid() rather than passed in;
--   * only from 'rejected' or 'pending' — never from 'approved', because
--     replacing published content is a new submission, not an edit;
--   * it goes back to 'pending', so an admin sees it again. A customer cannot
--     set that status directly and still cannot: the column grant is unchanged;
--   * the previous rejection is cleared, so the queue does not show a reason
--     belonging to a photograph that is no longer there.
--
-- CONSENT IS RE-RECORDED, NOT CARRIED OVER. The old consent was given for a
-- different photograph. Under the DPDP Act consent attaches to what was
-- consented to, so the form asks again and this stamps the new moment.

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

  -- Ownership from the session, never from an argument. A caller who could name
  -- someone else's submission id would otherwise be editing their photograph.
  if target.user_id is distinct from auth.uid() then
    raise exception 'That is not your submission';
  end if;

  if target.status = 'approved' then
    raise exception 'That photograph is already published. Withdraw it first if you would like to change it.';
  end if;

  if target.withdrawn_at is not null then
    raise exception 'You have withdrawn that submission. Send a new one instead.';
  end if;

  -- The same rule the insert policy applies. It is restated because this
  -- function is SECURITY DEFINER and therefore steps around the policy that
  -- would otherwise enforce it — a purchase that has since been refunded or
  -- cancelled should not keep the right to publish.
  if not public.has_purchased(target.product_id) then
    raise exception 'Only a verified purchase can be featured';
  end if;

  -- Something has to be sent. The table's own CHECK says the same thing; caught
  -- here so the customer gets a sentence rather than a constraint name.
  if coalesce(p_photo_url, p_video_url) is null then
    raise exception 'Add a photograph or a link before sending it again';
  end if;

  update style_submissions
     set photo_url      = p_photo_url,
         photo_width    = p_photo_width,
         photo_height   = p_photo_height,
         video_platform = p_video_platform,
         video_url      = p_video_url,
         caption        = p_caption,
         credit_name    = p_credit_name,
         -- A new photograph is a new thing to consent to. See the header.
         consented_at   = now(),
         status         = 'pending',
         reject_reason  = null,
         reviewed_at    = null,
         reviewed_by    = null,
         rejection_emailed_at = null
   where id = p_id;

  return true;
end;
$fn$;

revoke execute on function public.resubmit_style(uuid, text, integer, integer, text, text, text, text)
  from public, anon;
grant execute on function public.resubmit_style(uuid, text, integer, integer, text, text, text, text)
  to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'resubmit_style') as function_present,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'resubmit_style' and grantee = 'authenticated') as customer_may_call,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'resubmit_style' and grantee = 'anon') as anon_may_call,
  -- Unchanged, and the reason the function exists: a customer still cannot write
  -- the content columns directly.
  (select count(*) from information_schema.column_privileges
    where table_name = 'style_submissions' and grantee = 'authenticated'
      and privilege_type = 'UPDATE') as customer_updatable_columns;
