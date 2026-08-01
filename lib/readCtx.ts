import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * How a read should behave: which client to use, and whether to include drafts.
 *
 * This is a plain value with no Next dependency on purpose. The read functions
 * live in modules that admin CLIENT components import, and `next/headers`
 * anywhere in that graph fails the build. Preview detection therefore lives in
 * lib/preview.ts (server-only) and arrives here as data — see lib/storefront.ts
 * for where the two meet.
 */
export interface ReadCtx {
  client: SupabaseClient;
  preview: boolean;
}

/** What a customer sees: anonymous, published only. */
export const ANON_CTX: ReadCtx = { client: supabase, preview: false };

export function statesFor(ctx: ReadCtx): string[] {
  return ctx.preview ? ["published", "draft"] : ["published"];
}

/**
 * Collapse published+draft rows to one per entity, preferring the draft — the
 * same rule the admin list uses, so preview and the admin agree on what
 * publishing would produce.
 *
 * Rows whose draft deletes the entity are dropped: preview answers "what will
 * the site look like after I publish", and after publishing they are gone.
 *
 * Outside preview there is only ever one row per entity, so this is a no-op.
 */
export function preferDraft<
  T extends { state?: string; pending_delete?: boolean }
>(rows: T[], keyOf: (row: T) => string): T[] {
  const byEntity = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const seen = byEntity.get(key);
    if (!seen || row.state === "draft") byEntity.set(key, row);
  }
  return [...byEntity.values()].filter((r) => !r.pending_delete);
}
