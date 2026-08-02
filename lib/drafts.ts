import type { SupabaseClient } from "@supabase/supabase-js";

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

/**
 * Mark an entity for deletion at the next publish. It stays live until then,
 * which is what "nothing changes until I publish" has to mean for deletes.
 */
export async function markPendingDelete(
  client: SupabaseClient,
  table:
    | "product_versions"
    | "category_versions"
    | "journal_versions"
    | "site_page_versions",
  draftVersionId: string
): Promise<string | null> {
  const { error } = await client
    .from(table)
    .update({ pending_delete: true })
    .eq("id", draftVersionId);
  return error?.message ?? null;
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
  if (error) {
    console.error("getPendingQueue:", error.message);
    return [];
  }
  return (data as QueueItem[]) ?? [];
}

/** Throw away one item's draft, leaving everything else queued. */
export async function discardOne(
  client: SupabaseClient,
  kind: DraftKind,
  entityId: string | null,
  key?: string
): Promise<string | null> {
  const { error } = await client.rpc("discard_one", {
    p_kind: kind,
    p_id: entityId,
    p_key: key ?? null,
  });
  return error?.message ?? null;
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
  if (error) throw new Error(error.message);
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

  if (error || !row) {
    return { products: 0, categories: 0, journal: 0, content: 0, pages: 0, total: 0 };
  }
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
  if (error) throw new Error(error.message);
  return data as PendingChanges;
}

/** Throw away every pending change and go back to what is live. */
export async function discardDrafts(client: SupabaseClient): Promise<void> {
  const { error } = await client.rpc("discard_drafts");
  if (error) throw new Error(error.message);
}
