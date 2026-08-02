"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { getAllCategories, getDraftCategoryIds } from "@/lib/categories";
import { categoryLiveStatus, type LiveStatus } from "@/lib/categoryStatus";
import { categoryDraftId, markPendingDelete, newCategoryDraft, settleDraft } from "@/lib/drafts";
import { cn, uniqueSlug } from "@/lib/utils";
import type { Category } from "@/lib/types";
import Button from "@/components/ui/Button";
import NameEditor from "./NameEditor";
import DraftBadge from "./DraftBadge";

export default function CategoryManager({ onChange }: { onChange?: () => void }) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [neverPublished, setNeverPublished] = useState<Set<string>>(new Set());
  const [pageMissing, setPageMissing] = useState<Set<string>>(new Set());
  const [newParentName, setNewParentName] = useState("");
  const [newChild, setNewChild] = useState<{ parentId: string; name: string }>({
    parentId: "",
    name: "",
  });

  const load = useCallback(async () => {
    const [cats, { data: products }] = await Promise.all([
      getAllCategories(getBrowserSupabase(), { drafts: true }),
      getBrowserSupabase()
        .from("product_versions")
        .select("category_id")
        .eq("state", "published")
        .eq("is_active", true),
    ]);

    const tally: Record<string, number> = {};
    for (const p of products ?? []) {
      if (p.category_id) tally[p.category_id] = (tally[p.category_id] ?? 0) + 1;
    }
    setCounts(tally);
    setCategories(cats);
    setDraftIds(await getDraftCategoryIds(getBrowserSupabase()));

    // A category with no published version has never reached the site at all.
    const { data: publishedRows } = await getBrowserSupabase()
      .from("category_versions")
      .select("category_id")
      .eq("state", "published");
    const published = new Set((publishedRows ?? []).map((r) => r.category_id as string));
    setNeverPublished(new Set(cats.filter((c) => !published.has(c.id)).map((c) => c.id)));

    // "Needs a deploy" cannot be inferred — top-level pages are generated at
    // build time. Ask the site whether the page exists rather than guessing.
    const parentsToCheck = cats.filter((c) => c.parent_id === null && c.is_visible);
    const missing = await Promise.all(
      parentsToCheck.map(async (c) => {
        try {
          const res = await fetch(`/${c.slug}`, { method: "HEAD" });
          return res.status === 404 ? c.id : null;
        } catch {
          return null;
        }
      })
    );
    setPageMissing(new Set(missing.filter(Boolean) as string[]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const parents = (categories ?? []).filter((c) => c.parent_id === null);
  const childrenOf = (id: string) =>
    (categories ?? []).filter((c) => c.parent_id === id);
  const allSlugs = (categories ?? []).map((c) => c.slug);

  /** Wrap a mutation with busy state + error surfacing + reload. */
  const run = async (key: string, fn: () => Promise<{ error: unknown }>) => {
    setBusy(key);
    setError(null);
    const { error: opError } = await fn();
    if (opError) {
      setError(
        opError instanceof Error
          ? opError.message
          : (opError as { message?: string }).message ?? "Something went wrong."
      );
    }
    await load();
    setBusy(null);
    // Tell the dashboard an edit landed so the publish count re-reads.
    if (!opError) onChange?.();
  };

  /** Resolve the draft version for a category, then apply a patch to it. */
  const patchDraft = async (
    cat: Category,
    patch: Record<string, unknown>
  ): Promise<{ error: unknown }> => {
    const client = getBrowserSupabase();
    const { id: versionId, error } = await categoryDraftId(client, cat.id);
    if (error || !versionId) {
      return { error: { message: error ?? "Could not start a draft." } };
    }
    const result = await client
      .from("category_versions")
      .update(patch)
      .eq("id", versionId);

    // Hiding a section and showing it again is a round trip to nowhere; don't
    // leave it queued as a change.
    if (!result.error) await settleDraft(client, "category", versionId);
    return result;
  };

  const toggleVisible = (cat: Category) =>
    run(cat.id, () => patchDraft(cat, { is_visible: !cat.is_visible }));

  const rename = (cat: Category, name: string) =>
    run(cat.id, () => patchDraft(cat, { name }));

  /** Swap sort_order with the adjacent sibling so ordering is stable. */
  const move = (cat: Category, direction: -1 | 1) => {
    const siblings = cat.parent_id === null ? parents : childrenOf(cat.parent_id);
    const index = siblings.findIndex((c) => c.id === cat.id);
    const swapWith = siblings[index + direction];
    if (!swapWith) return;

    return run(cat.id, async () => {
      const a = await patchDraft(cat, { sort_order: swapWith.sort_order });
      if (a.error) return a;
      return patchDraft(swapWith, { sort_order: cat.sort_order });
    });
  };

  // Staged, not immediate: the section stays live until the next publish.
  const remove = (cat: Category) =>
    run(cat.id, async () => {
      setConfirmDelete(null);
      const client = getBrowserSupabase();
      const { id: versionId, error } = await categoryDraftId(client, cat.id);
      if (error || !versionId) {
        return { error: { message: error ?? "Could not stage this deletion." } };
      }
      const message = await markPendingDelete(client, "category_versions", versionId);
      return { error: message ? { message } : null };
    });

  const addCategory = async (name: string, parentId: string | null) => {
    const slug = uniqueSlug(name, allSlugs);
    if (!slug) {
      setError("Give the category a name with at least one letter or number.");
      return;
    }
    const siblings = parentId === null ? parents : childrenOf(parentId);
    const sort_order = siblings.length
      ? Math.max(...siblings.map((c) => c.sort_order)) + 1
      : 1;

    await run("new", async () => {
      // New sections start hidden AND unpublished — two independent gates, so a
      // half-built section cannot reach the site by either route.
      const { error } = await newCategoryDraft(
        getBrowserSupabase(),
        name.trim(),
        slug,
        parentId,
        sort_order
      );
      return { error: error ? { message: error } : null };
    });
  };

  const handleAddParent = (e: FormEvent) => {
    e.preventDefault();
    if (!newParentName.trim()) return;
    addCategory(newParentName, null);
    setNewParentName("");
  };

  const handleAddChild = (e: FormEvent, parentId: string) => {
    e.preventDefault();
    if (!newChild.name.trim()) return;
    addCategory(newChild.name, parentId);
    setNewChild({ parentId: "", name: "" });
  };

  if (categories === null) {
    return <p className="text-ink/60">Loading categories…</p>;
  }

  return (
    <div className="space-y-6">
      <p className="max-w-prose text-sm leading-relaxed text-ink/60">
        Hiding a section removes it from the menu <em>and</em> hides every
        product in it from the shop. A sub-category is only public when its
        parent is visible too. Storefront changes appear within a minute.
      </p>

      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      <div className="space-y-4">
        {parents.map((parent, pIndex) => {
          const children = childrenOf(parent.id);
          return (
            <div
              key={parent.id}
              className="overflow-hidden rounded-2xl border border-ink/10"
            >
              <Row
                cat={parent}
                isDraft={draftIds.has(parent.id)}
                status={categoryLiveStatus(parent, {
                  all: categories ?? [],
                  productCounts: counts,
                  neverPublished,
                  pageMissing: pageMissing.has(parent.id),
                })}
                productCount={counts[parent.id] ?? 0}
                effectivelyVisible={parent.is_visible}
                isParent
                busy={busy === parent.id}
                canMoveUp={pIndex > 0}
                canMoveDown={pIndex < parents.length - 1}
                confirming={confirmDelete === parent.id}
                childCount={children.length}
                onToggle={() => toggleVisible(parent)}
                onRename={(name) => rename(parent, name)}
                onMove={(d) => move(parent, d)}
                onAskDelete={() => setConfirmDelete(parent.id)}
                onCancelDelete={() => setConfirmDelete(null)}
                onConfirmDelete={() => remove(parent)}
              />

              <div className="divide-y divide-ink/5 border-t border-ink/10 bg-linen/20">
                {children.map((child, cIndex) => (
                  <Row
                    key={child.id}
                    cat={child}
                    isDraft={draftIds.has(child.id)}
                    status={categoryLiveStatus(child, {
                      all: categories ?? [],
                      productCounts: counts,
                      neverPublished,
                    })}
                    productCount={counts[child.id] ?? 0}
                    effectivelyVisible={child.is_visible && parent.is_visible}
                    parentHidden={!parent.is_visible}
                    busy={busy === child.id}
                    canMoveUp={cIndex > 0}
                    canMoveDown={cIndex < children.length - 1}
                    confirming={confirmDelete === child.id}
                    onToggle={() => toggleVisible(child)}
                    onRename={(name) => rename(child, name)}
                    onMove={(d) => move(child, d)}
                    onAskDelete={() => setConfirmDelete(child.id)}
                    onCancelDelete={() => setConfirmDelete(null)}
                    onConfirmDelete={() => remove(child)}
                  />
                ))}

                <form
                  onSubmit={(e) => handleAddChild(e, parent.id)}
                  className="flex items-center gap-2 px-4 py-3"
                >
                  <input
                    value={newChild.parentId === parent.id ? newChild.name : ""}
                    onChange={(e) =>
                      setNewChild({ parentId: parent.id, name: e.target.value })
                    }
                    placeholder={`Add a sub-category to ${parent.name}…`}
                    className="w-full max-w-xs rounded-lg border border-ink/15 bg-cream px-3 py-1.5 text-sm text-ink focus:border-terracotta focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 text-sm text-ink/60 transition-colors hover:text-terracotta"
                  >
                    <Plus className="h-4 w-4" /> Add
                  </button>
                </form>
              </div>
            </div>
          );
        })}
      </div>

      <form onSubmit={handleAddParent} className="flex items-center gap-3">
        <input
          value={newParentName}
          onChange={(e) => setNewParentName(e.target.value)}
          placeholder="New top-level section (e.g. Kids)"
          className="w-full max-w-xs rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
        />
        <Button type="submit" variant="outline" size="md">
          <Plus className="h-4 w-4" /> Add Section
        </Button>
      </form>

      <p className="max-w-prose text-xs text-ink/50">
        Sub-categories appear on the site within a minute. A brand-new
        <em> top-level section</em> needs a deploy before its page (e.g.
        /kids) exists — its address is baked in at build time.
      </p>
    </div>
  );
}

function Row({
  cat,
  isDraft = false,
  status,
  productCount,
  effectivelyVisible,
  parentHidden = false,
  isParent = false,
  childCount = 0,
  busy,
  canMoveUp,
  canMoveDown,
  confirming,
  onToggle,
  onRename,
  onMove,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  cat: Category;
  isDraft?: boolean;
  status?: LiveStatus;
  productCount: number;
  effectivelyVisible: boolean;
  parentHidden?: boolean;
  isParent?: boolean;
  childCount?: number;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  confirming: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onMove: (direction: -1 | 1) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 px-4 py-3",
        isParent ? "bg-linen/50" : "pl-8"
      )}
    >
      <div className="min-w-0 flex-1">
        <NameEditor
          value={cat.name}
          onSave={onRename}
          className={isParent ? "font-heading text-lg" : "text-sm"}
        />
        {isDraft && (
          <span className="ml-2 align-middle">
            <DraftBadge />
          </span>
        )}
        <p className="mt-0.5 text-xs text-ink/40">
          /{cat.slug} · {productCount} {productCount === 1 ? "product" : "products"}
        </p>
        {status && !status.live && (
          <p className="mt-1 text-xs text-terracotta-dark">
            <span className="font-medium">Not on the site — {status.reason}.</span>{" "}
            <span className="text-ink/60">{status.fix}</span>
          </p>
        )}
      </div>

      <button
        onClick={onToggle}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider transition-colors disabled:opacity-50",
          effectivelyVisible
            ? "bg-gold/20 text-ink hover:bg-gold/30"
            : "bg-ink/10 text-ink/60 hover:bg-ink/20"
        )}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : effectivelyVisible ? (
          <Eye className="h-3.5 w-3.5" />
        ) : (
          <EyeOff className="h-3.5 w-3.5" />
        )}
        {effectivelyVisible ? "Visible" : "Hidden"}
      </button>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onMove(-1)}
          disabled={!canMoveUp || busy}
          aria-label={`Move ${cat.name} up`}
          className="rounded p-1 text-ink/40 transition-colors hover:text-ink disabled:opacity-25"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={!canMoveDown || busy}
          aria-label={`Move ${cat.name} down`}
          className="rounded p-1 text-ink/40 transition-colors hover:text-ink disabled:opacity-25"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {confirming ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-terracotta-dark">
            {isParent && childCount > 0
              ? `Deletes ${childCount} sub-categor${childCount === 1 ? "y" : "ies"} too.`
              : productCount > 0
                ? `${productCount} product${productCount === 1 ? "" : "s"} will be left uncategorised and hidden.`
                : "Delete?"}
          </span>
          <button
            onClick={onConfirmDelete}
            className="rounded-full bg-terracotta px-3 py-1 font-medium text-cream"
          >
            Delete
          </button>
          <button onClick={onCancelDelete} className="text-ink/50 hover:text-ink">
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={onAskDelete}
          disabled={busy}
          aria-label={`Delete ${cat.name}`}
          className="rounded p-1 text-ink/30 transition-colors hover:text-terracotta disabled:opacity-25"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
