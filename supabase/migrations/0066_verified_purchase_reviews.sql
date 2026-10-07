-- 0066 — "Verified purchase" is derived from the order, never from who wrote the row
--
-- THE DEFECT. 0036 makes the purchase rule the INSERT policy "Verified
-- purchasers may review": user_id = auth.uid() and has_purchased(product_id).
-- But 0036 also creates "Admins moderate reviews" FOR ALL, and permissive
-- policies are OR-ed. For an admin, every INSERT therefore passes on
-- is_admin() alone. With the column grant on (product_id, user_id, rating,
-- body), an admin could write a review for ANY product under ANY customer's
-- user_id, with no order behind it. The same policy let an admin rewrite the
-- rating and body of a real customer's review. The storefront printed
-- "Verified purchase" on every row unconditionally, because it assumed the
-- database admitted no other kind.
--
-- WHAT ADMINS ACTUALLY DO (components/admin/ReviewsManager.tsx, the export):
--   read     — admin_reviews() (SECURITY DEFINER) and "Admins read every review"
--   hide     — set_review_hidden() (SECURITY DEFINER, checks is_admin itself)
--   delete   — a plain DELETE on product_reviews
-- Nothing in the app inserts or updates a review as an admin. So the FOR ALL
-- policy is narrowed to the one table operation moderation uses: DELETE.
-- Admins keep read, hide, unhide and delete. They lose INSERT and UPDATE,
-- which were never moderation. An admin who has really bought a piece still
-- reviews it the way every customer does, through "Verified purchasers may
-- review".
--
-- THE BADGE IS COMPUTED, NOT STORED. product_reviews_for() now returns
-- `verified`, worked out per row at read time from authoritative evidence:
-- a paid AND delivered order, under the review author's own sign-in email
-- (auth.users, NOT profiles.email, which the customer can edit), containing
-- this product. These are the same conditions has_purchased() applies at
-- insert time. Computing the badge instead of trusting the insert also covers:
--   * a row written by a trusted path that bypasses RLS (service role, SQL);
--   * an order that stops qualifying later (for example, it is cancelled);
--   * any future policy mistake of the same kind as this one.
-- There is no stored flag, so nothing can set or toggle it.
--
-- PRIVACY. The function returns one boolean per review that is already
-- public: the fact the badge itself states. No order id, total, date, email
-- or status leaves the function. The evidence is read inside SECURITY
-- DEFINER, so anon gains no access to orders or auth.users.
--
-- HISTORICAL ROWS. There is no stored verification to repair. Every existing
-- row, production has none, is judged by the same evidence on its next read.
-- Without evidence there is no badge. Nothing is assumed or backfilled.
--
-- No rows are read or written. Applied with scripts/run-migration.mjs, in one
-- transaction.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ─────────────────────────────
do $$
declare
  problems text[] := array[]::text[];
  p record;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.product_reviews'::regclass) then
    problems := problems || 'RLS is not enabled on product_reviews'::text;
  end if;
  if to_regprocedure('public.is_admin()') is null then
    problems := problems || 'public.is_admin() does not exist'::text;
  end if;
  if to_regprocedure('public.product_reviews_for(uuid)') is null then
    problems := problems || 'public.product_reviews_for(uuid) does not exist'::text;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_reviews'
                  and policyname = 'Verified purchasers may review' and cmd = 'INSERT'
                  and roles = '{authenticated}' and permissive = 'PERMISSIVE'
                  and with_check = '((user_id = auth.uid()) AND has_purchased(product_id))') then
    problems := problems || 'INSERT policy "Verified purchasers may review" is missing or differs from 0036'::text;
  end if;

  -- Every policy that can write must be one 0036 created, or this one's own
  -- result on a re-run. Anything else is a schema nobody has described.
  for p in
    select policyname, cmd, roles::text as roles, permissive, qual, with_check
      from pg_policies
     where schemaname = 'public' and tablename = 'product_reviews' and cmd <> 'SELECT'
  loop
    if not (p.roles = '{authenticated}' and p.permissive = 'PERMISSIVE' and (
         (p.policyname = 'Verified purchasers may review' and p.cmd = 'INSERT')
      or (p.policyname = 'Customers edit their own review' and p.cmd = 'UPDATE'
            and p.qual = '((user_id = auth.uid()) AND (hidden_at IS NULL))' and p.with_check = '(user_id = auth.uid())')
      or (p.policyname = 'Customers delete their own review' and p.cmd = 'DELETE'
            and p.qual = '(user_id = auth.uid())')
      or (p.policyname = 'Admins moderate reviews' and p.cmd = 'ALL'
            and p.qual = 'is_admin()' and p.with_check = 'is_admin()')
      or (p.policyname = 'Admins delete reviews' and p.cmd = 'DELETE'
            and p.qual = 'is_admin()')
    )) then
      problems := problems || format('unexpected %s policy on product_reviews: %s', p.cmd, p.policyname)::text;
    end if;
  end loop;

  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0066_PRECONDITION_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Moderation is not authorship ──────────────
drop policy if exists "Admins moderate reviews" on product_reviews;
drop policy if exists "Admins delete reviews" on product_reviews;
create policy "Admins delete reviews"
  on product_reviews for delete to authenticated
  using (public.is_admin());

-- ── The public list, with the badge decided by evidence ──
-- DROP and CREATE, because the return type changes. Inside the migration's
-- one transaction, so no caller ever sees the function missing.
drop function public.product_reviews_for(uuid);

create function public.product_reviews_for(p_product_id uuid)
returns table (
  id uuid,
  rating smallint,
  body text,
  author text,
  created_at timestamptz,
  verified boolean
)
language sql
stable
security definer
set search_path = public
as $fn$
  select r.id,
         r.rating,
         r.body,
         coalesce(nullif(btrim(p.full_name), ''), 'A customer') as author,
         r.created_at,
         -- has_purchased()'s conditions, for the AUTHOR rather than the caller.
         -- Their sign-in email comes from auth.users, never from profiles.email,
         -- which customers can edit. Product ids are compared as text, as there.
         -- An items value that is not an array counts as no evidence and does
         -- not raise an error, so one malformed order cannot take a product's
         -- reviews off the page.
         exists (
           select 1
             from auth.users u
             join orders o on lower(o.customer_email) = lower(u.email)
             cross join lateral jsonb_array_elements(
               case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
             ) item
            where u.id = r.user_id
              and o.payment_status = 'paid'
              and o.status = 'delivered'
              and item ->> 'id' = r.product_id::text
         ) as verified
    from product_reviews r
    left join profiles p on p.id = r.user_id
   where r.product_id = p_product_id
     and r.hidden_at is null
   order by r.created_at desc;
$fn$;

revoke execute on function public.product_reviews_for(uuid) from public;
grant execute on function public.product_reviews_for(uuid) to anon, authenticated, service_role;

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_reviews'
              and cmd in ('INSERT', 'UPDATE', 'ALL') and coalesce(with_check, qual, '') like '%is_admin()%') then
    problems := problems || 'an admin policy still allows INSERT or UPDATE on product_reviews'::text;
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'product_reviews'
        and cmd = 'INSERT') <> 1 then
    problems := problems || 'product_reviews does not have exactly one INSERT policy'::text;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_reviews'
                  and policyname = 'Admins delete reviews' and cmd = 'DELETE' and qual = 'is_admin()') then
    problems := problems || '"Admins delete reviews" is missing'::text;
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'product_reviews') <> 6 then
    problems := problems || 'product_reviews does not have exactly six policies'::text;
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.product_reviews_for(uuid)'::regprocedure
                  and prosecdef and 'verified' = any(proargnames)) then
    problems := problems || 'product_reviews_for(uuid) does not return verified as SECURITY DEFINER'::text;
  end if;
  if not has_function_privilege('anon', 'public.product_reviews_for(uuid)', 'execute') then
    problems := problems || 'anon cannot execute product_reviews_for(uuid)'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0066_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select policyname, cmd, roles::text as roles, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename = 'product_reviews'
 order by cmd, policyname;
