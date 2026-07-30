-- 0004 — Table privileges for the API roles
-- RLS decides WHICH rows a role sees; roles still need base privileges or
-- PostgREST returns 42501 before RLS is even consulted.

-- ── Table privileges for the API roles ──────
-- RLS decides WHICH rows each role may see; the roles still need base table
-- privileges or PostgREST returns "permission denied" (42501) before RLS even
-- runs. Supabase usually grants these via default privileges — add them
-- explicitly so this schema is self-contained and reproducible. Safe to re-run.
grant usage on schema public to anon, authenticated;
grant select on categories, products, site_content, journal_posts to anon, authenticated;
grant insert, update, delete on categories, products, site_content, journal_posts to authenticated;
grant select on orders to authenticated;

-- service_role is the trusted server-side key. It bypasses RLS, but privileges
-- are still checked — and on this project the usual Supabase defaults were not
-- in place, so every service_role query failed with 42501 "permission denied".
-- That silently broke order recording: app/api/checkout/razorpay writes the
-- order with this role after verifying the Razorpay signature, and
-- lib/chat.ts looks orders up with it for the concierge.
-- The default-privileges lines cover tables added later.
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

-- Profiles: readable/updatable per the policies above, BUT is_admin is granted
-- at column level only. RLS cannot restrict individual columns, so without this
-- a signed-in customer could run `update profiles set is_admin = true` against
-- their own row — the "Users update own profile" policy would happily allow it.
-- Promotion therefore requires the SQL editor or the service role key.
grant select on profiles to authenticated;
revoke update on profiles from authenticated;
grant update (email, full_name) on profiles to authenticated;
