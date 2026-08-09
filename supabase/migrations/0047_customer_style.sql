-- 0047 — Customer style submissions
--
-- A photograph of a real person wearing something they bought, shown publicly
-- with their name on it. That is personal data, published, and the rules follow
-- from that rather than from what is convenient.
--
-- CONSENT IS A SEPARATE FACT, STORED SEPARATELY. Buying something is not
-- agreeing to appear on a website, and a checkbox bundled into a submission
-- form is not consent to publication either. consented_at records the moment
-- it was given; nothing without it can ever be approved, and that is enforced
-- here rather than in the form.
--
-- CONSENT CAN BE WITHDRAWN. Under the DPDP Act it must be as easy to take back
-- as to give, so withdrawn_at exists and an approved submission with it set
-- stops being public immediately — no admin action required for it to
-- disappear, because a customer should not have to wait on us to be removed.
--
-- VERIFIED PURCHASE, reusing has_purchased() from 0036 — the same rule reviews
-- use: a paid, delivered order containing that product. Enforced in the RLS
-- policy, not in the form, so there is no insert path that avoids it.
--
-- APPROVAL IS EXPLICIT AND NEVER IMPLICIT. Nothing is public until an admin
-- says so. A submission arrives pending and stays pending.

create table if not exists style_submissions (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,

  -- One or both. A photo we host, and/or a link to something already public.
  photo_url     text,
  -- Stored as a normalised platform + id, not a raw URL, for the same reason
  -- the product video is: the link arrives in several shapes.
  video_platform text check (video_platform is null or video_platform in ('instagram', 'youtube')),
  video_url     text,

  caption       text check (caption is null or length(caption) <= 300),

  -- ── Consent ──
  consented_at  timestamptz not null,
  withdrawn_at  timestamptz,
  -- First name only, and only if they agreed to be credited. Null means show
  -- it anonymously — a separate decision from consenting to publication.
  credit_name   text check (credit_name is null or length(credit_name) <= 40),

  -- ── Moderation ──
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  reviewed_at   timestamptz,
  reviewed_by   uuid references auth.users(id) on delete set null,
  -- Internal. The customer is not told why, by decision — see the brief.
  reject_reason text,

  created_at    timestamptz not null default now(),

  -- Something has to be submitted.
  constraint style_has_content check (photo_url is not null or video_url is not null),
  -- A video link needs to say where it points.
  constraint style_video_platform check (video_url is null or video_platform is not null)
);

comment on table style_submissions is
  'Customer photographs and video links, shown publicly only when consented_at
   is set, status is approved, and withdrawn_at is null. All three, always.';

create index if not exists style_product_idx on style_submissions (product_id, status);
create index if not exists style_status_idx on style_submissions (status, created_at desc);
create index if not exists style_user_idx on style_submissions (user_id);

-- One submission per customer per product. A second is an edit of the first,
-- not a second opinion — the same reasoning as one review per person (0036).
create unique index if not exists style_one_per_customer_product
  on style_submissions (user_id, product_id);

-- ══ What the public may see ═══════════════════
/**
 * The single definition of "publicly visible".
 *
 * A view rather than a condition repeated in the gallery, the product page and
 * the export. Three copies of this rule is three places for one of them to
 * forget withdrawn_at, and the failure mode is someone's photograph staying up
 * after they asked for it to come down.
 */
create or replace view public_style_submissions as
  select s.id, s.product_id, s.photo_url, s.video_platform, s.video_url,
         s.caption, s.credit_name, s.created_at,
         p.name as product_name, p.slug as product_slug
    from style_submissions s
    join products p on p.id = s.product_id
   where s.status = 'approved'
     and s.consented_at is not null
     and s.withdrawn_at is null;

grant select on public_style_submissions to anon, authenticated;

-- ══ RLS ═══════════════════════════════════════
alter table style_submissions enable row level security;

-- Submitting requires a VERIFIED PURCHASE, checked by the database. A form
-- that only appears to buyers is a convenience; this is the rule.
drop policy if exists "Purchasers submit their own style" on style_submissions;
create policy "Purchasers submit their own style"
  on style_submissions for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.has_purchased(product_id)
    and consented_at is not null
    -- Nobody self-approves.
    and status = 'pending'
  );

-- A customer can see their own, whatever its state, and withdraw it.
drop policy if exists "Customers read their own style" on style_submissions;
create policy "Customers read their own style"
  on style_submissions for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Customers withdraw their own style" on style_submissions;
create policy "Customers withdraw their own style"
  on style_submissions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Admins moderate style" on style_submissions;
create policy "Admins moderate style"
  on style_submissions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select, insert on style_submissions to authenticated;
-- Column-level, so a customer can withdraw consent and nothing else. Without
-- this they could set status = 'approved' on their own row.
grant update (withdrawn_at) on style_submissions to authenticated;

-- ══ Moderation ════════════════════════════════
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

  -- Approving something never consented to would publish a photograph on an
  -- authority nobody gave. The insert policy already requires it; this is the
  -- second lock, because approval is the moment it becomes public.
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
         reject_reason = case when p_status = 'rejected' then p_reason else null end
   where id = p_id;

  return true;
end;
$fn$;

revoke execute on function public.moderate_style(uuid, text, text) from public, anon;
grant execute on function public.moderate_style(uuid, text, text) to authenticated, service_role;

-- ══ Audit ═════════════════════════════════════
drop trigger if exists audit_style_submissions on style_submissions;
create trigger audit_style_submissions
  after insert or update or delete on style_submissions
  for each row execute function public.log_admin_action();

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='style_submissions') as table_present,
  (select count(*) from information_schema.views
    where table_schema='public' and table_name='public_style_submissions') as view_present,
  (select count(*) from pg_policies where tablename='style_submissions') as policies,
  (select count(*) from pg_proc where pronamespace='public'::regnamespace
    and proname='moderate_style') as moderate_fn,
  (select count(*) from pg_trigger where tgname='audit_style_submissions') as audit_trigger,
  -- A customer must be able to withdraw and nothing else.
  (select count(*) from information_schema.column_privileges
    where table_name='style_submissions' and grantee='authenticated'
      and privilege_type='UPDATE') as updatable_columns;
