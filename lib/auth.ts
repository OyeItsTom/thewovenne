import { getBrowserSupabase } from "./supabase";

/**
 * Whether the signed-in user is an admin, per profiles.is_admin.
 *
 * Calls the same SECURITY DEFINER `is_admin()` function the RLS policies use,
 * so the UI can't drift from what the database actually permits. RLS remains
 * the real boundary — this only decides what to render. A non-admin who forces
 * their way onto an admin screen still can't read or write anything.
 */
export async function isCurrentUserAdmin(): Promise<boolean> {
  const { data, error } = await getBrowserSupabase().rpc("is_admin");

  if (error) {
    // Fail closed: an unreachable or not-yet-migrated database is not an admin.
    console.error("isCurrentUserAdmin:", error.message);
    return false;
  }
  return data === true;
}
