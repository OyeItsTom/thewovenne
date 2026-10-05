import type { SupabaseClient } from "@supabase/supabase-js";
import { adminErrorMessage, checkDraftWrite, type DraftWrite } from "./adminStatus";

/**
 * Every admin write goes through here.
 *
 * The rule is the same everywhere: never touch a published version. Get (or
 * fork) the draft, write to that, and it stays invisible until publish. Putting
 * it in one place means a new admin screen cannot accidentally write straight to
 * live content — the mistake this whole system exists to prevent.
 *
 * The ensure_* functions are SECURITY DEFINER and fork the published version
 * copy-on-write, gallery included (supabase/migrations/0012).
 */

/** Draft version id for a product, forking from published if needed. */
export async function productDraftId(
  client: SupabaseClient,
  productId: string
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc("ensure_product_draft", {
    p_product_id: productId,
  });
  return { id: (data as string) ?? null, error: error?.message ?? null };
}

/** A brand-new product: identity plus an empty draft, invisible until published. */
export async function newProductDraft(
  client: SupabaseClient
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc("create_product_draft");
  return { id: (data as string) ?? null, error: error?.message ?? null };
}

export async function categoryDraftId(
  client: SupabaseClient,
  categoryId: string
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc("ensure_category_draft", {
    p_category_id: categoryId,
  });
  return { id: (data as string) ?? null, error: error?.message ?? null };
}

export async function newCategoryDraft(
  client: SupabaseClient,
  name: string,
  slug: string,
  parentId: string | null,
  sortOrder: number
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc("create_category_draft", {
    p_name: name,
    p_slug: slug,
    p_parent_id: parentId,
    p_sort_order: sortOrder,
  });
  return { id: (data as string) ?? null, error: error?.message ?? null };
}

export async function journalDraftId(
  client: SupabaseClient,
  journalId: string
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc("ensure_journal_draft", {
    p_journal_id: journalId,
  });
  return { id: (data as string) ?? null, error: error?.message ?? null };
}

export async function newJournalDraft(
  client: SupabaseClient
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc("create_journal_draft");
  return { id: (data as string) ?? null, error: error?.message ?? null };
}

export async function pageDraftId(
  client: SupabaseClient,
  pageId: string
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc("ensure_page_draft", {
    p_page_id: pageId,
  });
  return { id: (data as string) ?? null, error: error?.message ?? null };
}

export async function newPageDraft(
  client: SupabaseClient,
  title: string,
  slug: string
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.rpc("create_page_draft", {
    p_title: title,
    p_slug: slug,
  });
  return { id: (data as string) ?? null, error: error?.message ?? null };
}

type VersionTable =
  | "product_versions"
  | "category_versions"
  | "journal_versions"
  | "site_page_versions";

/**
 * Write to a DRAFT version, and report success only if exactly one draft row
 * changed (lib/adminStatus checkDraftWrite).
 *
 * Two guards, both new:
 *  - `state = 'draft'`: the id came from ensure_*_draft a moment ago, but
 *    another admin can publish in between, turning that row into the LIVE
 *    version. Without the filter this update would then edit what customers
 *    see — the one thing this module exists to prevent.
 *  - the returned rows: an UPDATE that matches nothing (draft published or
 *    discarded meanwhile, or rights lost under RLS) is not an error to
 *    PostgREST, and used to be reported as saved.
 *
 * `action` finishes the failure sentence: "Couldn't <action> — …".
 */
export async function updateDraftVersion<T = { id: string }>(
  client: SupabaseClient,
  table: VersionTable,
  versionId: string,
  patch: Record<string, unknown>,
  { select = "id", action = "save this draft" }: { select?: string; action?: string } = {}
): Promise<DraftWrite<T>> {
  try {
    const { data, error } = await client
      .from(table)
      .update(patch)
      .eq("id", versionId)
      .eq("state", "draft")
      .select(select);
    return checkDraftWrite<T>({ error, data: data as T[] | null }, action);
  } catch (err) {
    // fetch itself threw — offline, DNS, a dropped connection.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "network", message: adminErrorMessage(message, action) };
  }
}

/**
 * Mark an entity for deletion at the next publish. It stays live until then,
 * which is what "nothing changes until I publish" has to mean for deletes.
 * Returns a readable failure, or null only when the mark really landed.
 */
export async function markPendingDelete(
  client: SupabaseClient,
  table: VersionTable,
  draftVersionId: string
): Promise<string | null> {
  const result = await updateDraftVersion(client, table, draftVersionId, { pending_delete: true }, {
    action: "stage this deletion",
  });
  return result.ok ? null : result.message;
}

/** The kinds of thing the versioning system tracks. */
export type DraftKind = "product" | "category" | "journal" | "page" | "content";

/**
 * Drop a draft that turned out to change nothing.
 *
 * Call once a save is COMPLETELY finished — for products that means after the
 * gallery too, since photos live in their own table. Before that point "did
 * anything change?" has no meaningful answer, which is exactly why this is a
 * call rather than a trigger.
 *
 * Best-effort by design: if it never runs, the leftover draft is not counted
 * or queued anyway (pending_changes and pending_queue both filter no-ops), so
 * a missed call leaves untidy data, never a wrong publish.
 */
export async function settleDraft(
  client: SupabaseClient,
  kind: DraftKind,
  versionId: string
): Promise<boolean> {
  const { data, error } = await client.rpc("settle_draft", {
    p_kind: kind,
    p_version_id: versionId,
  });
  if (error) {
    console.error("settleDraft:", error.message);
    return false;
  }
  return data === true;
}

/**
 * An Error that keeps PostgREST's code, so lib/adminStatus can tell our own
 * readable RAISE reasons (P0001, shown as written) from internals (translated).
 */
function rpcError(error: { message: string; code?: string }): Error & { code?: string } {
  return Object.assign(new Error(error.message), { code: error.code });
}

/** One row of the publish queue. */
export interface QueueItem {
  kind: DraftKind;
  entity_id: string | null;
  version_id: string | null;
  label: string;
  slug: string;
  is_new: boolean;
  pending_delete: boolean;
  changed_at: string;
  changed_by: string | null;
  changes: { field: string; old: unknown; new: unknown }[];
}

/** Everything waiting to go live, with a field-level diff for each item. */
export async function getPendingQueue(
  client: SupabaseClient
): Promise<QueueItem[]> {
  const { data, error } = await client.rpc("pending_queue");
  // Thrown, not emptied: an empty queue reads "Every change is already live".
  if (error) {
    console.error("getPendingQueue:", error.message);
    throw rpcError(error);
  }
  return (data as QueueItem[]) ?? [];
}

/** Throw away one item's draft, leaving everything else queued. */
export async function discardOne(
  client: SupabaseClient,
  kind: DraftKind,
  entityId: string | null,
  key?: string
): Promise<{ message: string; code?: string } | null> {
  const { error } = await client.rpc("discard_one", {
    p_kind: kind,
    p_id: entityId,
    p_key: key ?? null,
  });
  return error ? { message: error.message, code: error.code } : null;
}

/** Publish one item on its own. Throws with a readable reason if blocked. */
export async function publishOne(
  client: SupabaseClient,
  kind: DraftKind,
  entityId: string | null,
  key?: string
): Promise<void> {
  const { error } = await client.rpc("publish_one", {
    p_kind: kind,
    p_id: entityId,
    p_key: key ?? null,
  });
  if (error) throw rpcError(error);
}

export interface PendingChanges {
  products: number;
  categories: number;
  journal: number;
  content: number;
  pages: number;
  total: number;
}

/** How much is waiting to go live, for the publish bar. */
export async function getPendingChanges(
  client: SupabaseClient
): Promise<PendingChanges> {
  const { data, error } = await client.rpc("pending_changes");
  const row = (Array.isArray(data) ? data[0] : data) as
    | Omit<PendingChanges, "total">
    | undefined;

  // Thrown, not zeroed: zero is a real answer ("everything is published"), and
  // the publish bar used to give it whenever this read failed.
  if (error) throw new Error(error.message);
  if (!row) throw new Error("pending_changes returned nothing");
  return {
    ...row,
    // pages is absent until migration 0015 runs; treat it as zero rather than
    // letting NaN propagate into the count.
    pages: row.pages ?? 0,
    total:
      row.products + row.categories + row.journal + row.content + (row.pages ?? 0),
  };
}

/** Publish everything waiting. Throws with a readable message if blocked. */
export async function publishAll(
  client: SupabaseClient
): Promise<PendingChanges> {
  const { data, error } = await client.rpc("publish_all");
  if (error) throw rpcError(error);
  return data as PendingChanges;
}

/** Throw away every pending change and go back to what is live. */
export async function discardDrafts(client: SupabaseClient): Promise<void> {
  const { error } = await client.rpc("discard_drafts");
  if (error) throw rpcError(error);
}
