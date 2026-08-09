-- 0048 — Let an admin actually remove a submission
--
-- 0047 granted authenticated only SELECT, INSERT and UPDATE(withdrawn_at), so a
-- customer could withdraw and nothing else. Correct for customers, and it also
-- silently blocked ADMINS — who are authenticated too. The "Admins moderate"
-- RLS policy allows everything, but a policy cannot grant a privilege the role
-- does not have: the grant is checked first, so a delete failed with
-- "permission denied" before RLS was ever consulted.
--
-- Moderation itself was unaffected, because moderate_style() is SECURITY
-- DEFINER and runs with the function owner's rights. Only removal was broken,
-- and only for the one person who is meant to be able to do it.
--
-- DELETE is granted to authenticated and RESTRICTED TO ADMINS BY THE EXISTING
-- POLICY — the same shape every other admin-managed table uses. Granting it
-- without a policy would let any signed-in customer delete anyone's photograph.
grant delete on style_submissions to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.role_table_grants
    where table_name='style_submissions' and grantee='authenticated'
      and privilege_type='DELETE') as delete_granted,
  -- The policy that keeps that grant safe must still exist.
  (select count(*) from pg_policies
    where tablename='style_submissions' and policyname='Admins moderate style') as admin_policy,
  (select count(*) from information_schema.column_privileges
    where table_name='style_submissions' and grantee='authenticated'
      and privilege_type='UPDATE') as customer_updatable_columns;
