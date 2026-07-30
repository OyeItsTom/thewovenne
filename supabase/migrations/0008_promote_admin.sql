-- 0008 — Promote your admin (MANUAL, and required)
--
-- Nothing in 0001–0007 makes anyone an admin. Until this runs you can sign in
-- at /admin and will get an empty dashboard, because every admin policy
-- returns false and lib/auth.ts fails closed.
--
-- Replace the address with your Supabase Auth admin user, then run:

update profiles set is_admin = true where email = 'admin@thewovenne.com';

-- Expect exactly one row, is_admin = t:
select email, is_admin from profiles;
