-- 0026 — Marketing consent, and admin-editable store settings
--
-- MARKETING CONSENT did not exist. It was in the original brief, was not built
-- with customer signup, and the omission was not flagged — so every account
-- created so far was never asked.
--
-- That matters legally, not just as a gap. Under India's DPDP Act consent must
-- be given, not assumed, so these columns default to FALSE and there is no
-- backfill. Existing accounts are recorded as never having consented, which is
-- the truth. They can opt in from their account page; nobody is opted in on
-- their behalf.
--
-- The consent timestamp is stored because "did they agree, and when" is the
-- question that actually gets asked later.

alter table profiles
  add column if not exists marketing_consent    boolean not null default false,
  add column if not exists marketing_consent_at timestamptz;

comment on column profiles.marketing_consent is
  'Explicit opt-in to marketing email. Never set by default, never inferred from a purchase.';

create index if not exists profiles_marketing_consent_idx
  on profiles (marketing_consent) where marketing_consent;

-- ── Consent captured at signup ────────────────
-- handle_new_user reads the checkbox from the signup metadata. Coerced through
-- an explicit true test so a missing, malformed or hostile value becomes false
-- rather than anything truthy counting as agreement.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id, email, full_name, is_admin,
                               marketing_consent, marketing_consent_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    false,
    (new.raw_user_meta_data ->> 'marketing_consent') = 'true',
    case when (new.raw_user_meta_data ->> 'marketing_consent') = 'true'
         then now() else null end
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

-- ── A customer may change their own mind ──────
-- 0004 grants UPDATE on (email, full_name) only, which is what stops a customer
-- setting their own is_admin. Consent joins that list — it is theirs to give and
-- withdraw, and it must stay outside any column they cannot reach.
grant update (email, full_name, marketing_consent, marketing_consent_at)
  on profiles to authenticated;

-- ── Store settings ────────────────────────────
-- In site_content, like the shipping and campaign config: editable from the
-- admin with no deploy, and inheriting the draft/publish machinery for free.
insert into site_content (key, value, draft_value)
select 'store_settings', v, v
from (
  select '{
    "ask_wovenne_enabled": true,
    "vip_min_orders": 3,
    "vip_min_spend_inr": 15000,
    "loyalty_enabled": false,
    "loyalty_points_per_inr": 1,
    "loyalty_inr_per_point": 0.25,
    "loyalty_min_redeem": 200
  }'::jsonb as v
) seed
where not exists (select 1 from site_content where key = 'store_settings');

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_name = 'profiles'
      and column_name in ('marketing_consent', 'marketing_consent_at')) as consent_columns,
  (select count(*) from site_content where key = 'store_settings') as settings_row,
  (select count(*) from profiles) as profiles_total,
  (select count(*) from profiles where marketing_consent) as consented,
  (select value from site_content where key = 'store_settings') as settings;
