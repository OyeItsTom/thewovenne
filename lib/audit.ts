import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { AuditEntry } from "./types";

/**
 * Recent admin actions, newest first. Pass the authenticated client — the
 * "Admins can read the audit log" policy is the only way in, so the anon
 * client returns an empty list rather than an error.
 */
export async function getAuditLog(
  client: SupabaseClient = supabase,
  limit = 100
): Promise<AuditEntry[]> {
  const { data, error } = await client
    .from("admin_audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getAuditLog:", error.message);
    return [];
  }
  return (data as AuditEntry[] | null) ?? [];
}
