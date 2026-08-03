-- 0030 — Fix signup failing when consent is not mentioned
--
-- 0026 broke every signup whose metadata omits marketing_consent:
--
--   null value in column "marketing_consent" of relation "profiles"
--   violates not-null constraint
--
-- The cause is three-valued logic. When the key is absent, ->> returns NULL,
-- and `NULL = 'true'` is NULL — not false. That NULL went into a NOT NULL
-- column and took the whole auth.users insert down with it, because the trigger
-- runs inside that transaction.
--
-- The storefront signup form always sends the field, so it kept working, which
-- is exactly why this went unnoticed. What broke was every OTHER way an account
-- is created:
--
--   * scripts/add-admin.mjs — adding a partner as an admin failed outright,
--     with an unhelpful "Could not create user: {}"
--   * any account created from the Supabase dashboard or the Admin API
--
-- coalesce makes the absent case false, which is also the correct default:
-- silence is not consent.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  consented boolean;
begin
  -- Absent, malformed or hostile all become false. Only the exact string
  -- 'true' counts, and coalesce catches the NULL that = leaves behind.
  consented := coalesce(
    (new.raw_user_meta_data ->> 'marketing_consent') = 'true',
    false
  );

  insert into public.profiles (id, email, full_name, is_admin,
                               marketing_consent, marketing_consent_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    false,
    consented,
    case when consented then now() else null end
  )
  on conflict (id) do nothing;

  return new;
end;
$fn$;

-- ── Clean up anything the failure stranded ────
-- The trigger runs inside the auth.users insert, so a failure rolls the user
-- back too and there should be nothing orphaned. Checked rather than assumed.
delete from public.profiles p
 where not exists (select 1 from auth.users u where u.id = p.id);

-- ── Verify ────────────────────────────────────
select
  (select count(*) from auth.users)    as auth_users,
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.profiles where marketing_consent) as consented,
  (select count(*) from public.profiles p
    where not exists (select 1 from auth.users u where u.id = p.id)) as orphans;
