-- 0057 — A record of which migrations have been applied
--
-- Until now the only way to answer "has 0053 been applied?" was to guess from
-- the git history and then go looking for the objects it creates. That worked
-- while one person applied every migration by hand, minutes after writing it.
-- It stops working the moment there is a second environment, a second person, or
-- a gap of a fortnight — and it very nearly bit already: 0056 was live in the
-- database while its file sat in an unmerged branch, and the only way to
-- establish that was to probe for the trigger by name.
--
-- WHAT THIS IS NOT. It is not a framework, and it does not run anything. Applying
-- a migration is still `node scripts/run-migration.mjs <file>` against
-- SUPABASE_DB_URL — nothing about deployment changes, because nothing about
-- deployment ever applied migrations. This is a ledger the runner writes to, so
-- the database can say what has been done to it.
--
-- THE BACKFILL IS AN HONEST GUESS, and is marked as one. Every file up to 0056 is
-- recorded with recorded_retrospectively = true and no applied_at, because
-- nobody knows WHEN they were applied — only that the schema they describe is
-- present. Writing a plausible timestamp would be inventing evidence. From 0057
-- onwards the runner stamps the real moment.

create table if not exists schema_migrations (
  filename                 text primary key,
  applied_at               timestamptz,
  -- True for anything recorded by this migration's backfill rather than by the
  -- runner at the time it ran. A null applied_at with this false would be a bug.
  recorded_retrospectively boolean not null default false
);

comment on table schema_migrations is
  'Which migration files have been applied to this database. Written by
   scripts/run-migration.mjs. Rows with recorded_retrospectively = true were
   backfilled by 0057 and have no applied_at — the schema was verified present,
   the moment it happened was not recorded.';

-- Nobody but the deployer needs this: it is applied over a direct connection,
-- not through PostgREST. No grants to anon or authenticated, and RLS on with no
-- policy so a leaked key cannot read the shape of the schema's history.
alter table schema_migrations enable row level security;

insert into schema_migrations (filename, recorded_retrospectively)
values
    ('0001_core_tables.sql', true),
    ('0002_admin_identity.sql', true),
    ('0003_row_level_security.sql', true),
    ('0004_grants.sql', true),
    ('0005_storage.sql', true),
    ('0006_product_images.sql', true),
    ('0007_seed.sql', true),
    ('0008_promote_admin.sql', true),
    ('0009_admin_audit_log.sql', true),
    ('0010_site_content_drafts.sql', true),
    ('0011_versioning_schema.sql', true),
    ('0012_draft_helpers.sql', true),
    ('0013_publish.sql', true),
    ('0014_audit_versions.sql', true),
    ('0015_site_pages.sql', true),
    ('0016_seasonal_campaigns.sql', true),
    ('0017_product_urls.sql', true),
    ('0018_publish_queue.sql', true),
    ('0019_chat_rate_limit.sql', true),
    ('0020_order_contact_details.sql', true),
    ('0021_product_sizes.sql', true),
    ('0022_fix_create_product_draft.sql', true),
    ('0023_customer_accounts.sql', true),
    ('0024_order_lifecycle.sql', true),
    ('0025_analytics.sql', true),
    ('0026_consent_and_settings.sql', true),
    ('0027_customer_segments.sql', true),
    ('0028_customers_testable.sql', true),
    ('0029_loyalty_points.sql', true),
    ('0030_fix_consent_null.sql', true),
    ('0031_marketing_sends.sql', true),
    ('0032_carts.sql', true),
    ('0033_delete_account.sql', true),
    ('0034_delivery_updates.sql', true),
    ('0035_customer_address.sql', true),
    ('0036_product_reviews.sql', true),
    ('0037_coupons_and_invoices.sql', true),
    ('0038_cost_and_capture.sql', true),
    ('0039_manual_stock_log.sql', true),
    ('0040_expenses.sql', true),
    ('0041_profit_and_loss.sql', true),
    ('0042_publish_needs_images.sql', true),
    ('0043_credit_notes.sql', true),
    ('0044_manual_orders.sql', true),
    ('0045_cancel_order.sql', true),
    ('0046_product_video.sql', true),
    ('0047_customer_style.sql', true),
    ('0048_style_admin_delete.sql', true),
    ('0049_cancel_needs_a_credit_note.sql', true),
    ('0050_in_person_consent.sql', true),
    ('0051_product_brand_knowledge.sql', true),
    ('0052_style_media_and_feedback.sql', true),
    ('0053_style_resubmission.sql', true),
    ('0054_style_moderation_queue.sql', true),
    ('0055_style_submission_notice.sql', true),
    ('0056_sized_stock_is_derived.sql', true)
on conflict (filename) do nothing;

-- ── Verify ────────────────────────────────────
select
  (select count(*)::int from schema_migrations) as recorded,
  (select count(*)::int from schema_migrations where recorded_retrospectively) as backfilled,
  (select count(*)::int from schema_migrations where applied_at is not null) as with_a_real_timestamp,
  (select count(*)::int from pg_policy where polrelid = 'schema_migrations'::regclass) as policies,
  (select relrowsecurity from pg_class where oid = 'schema_migrations'::regclass) as rls_on;
