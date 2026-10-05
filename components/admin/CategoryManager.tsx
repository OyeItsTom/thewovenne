"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { PRODUCT_PROFILES, profileLabel, type ProductProfile } from "@/lib/productInfo";
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
import { getAllCategories } from "@/lib/categories";
import { categoryLiveStatus, type LiveStatus } from "@/lib/categoryStatus";
import {
  categoryDraftId,
  markPendingDelete,
  newCategoryDraft,
  settleDraft,
  updateDraftVersion,
} from "@/lib/drafts";
import { adminErrorMessage, factsFromVersions, deleteConfirmText } from "@/lib/adminStatus";
import { cn, uniqueSlug } from "@/lib/utils";
import type { Category, PublicationFacts } from "@/lib/types";
import Button from "@/components/ui/Button";
import NameEditor from "./NameEditor";
import StatusBadges from "./StatusBadges";

export default function CategoryManager({ onChange }: { onChange?: () => void }) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Where each category stands, read from its versions (lib/adminStatus).
  const [facts, setFacts] = useState<Map<string, PublicationFacts>>(new Map());
  const [neverPublished, setNeverPublished] = useState<Set<string>>(new Set());
  // What the last action really did, for the live region.
  const [notice, setNotice] = useState<string | null>(null);
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

    // Both versions of every category: which are live, which have a draft,
    // which drafts delete it. A category with no published version has never
    // reached the site at all.
    const { data: versionRows } = await getBrowserSupabase()
      .from("category_versions")
      .select("category_id, state, pending_delete, is_visible")
      .in("state", ["published", "draft"]);
    const byCategory = new Map<string, { state: string; pending_delete: boolean; visible: boolean }[]>();
    for (const r of versionRows ?? []) {
      const list = byCategory.get(r.category_id as string) ?? [];
      list.push({ state: r.state as string, pending_delete: !!r.pending_delete, visible: !!r.is_visible });
      byCategory.set(r.category_id as string, list);
    }
    const next = new Map(cats.map((c) => [c.id, factsFromVersions(byCategory.get(c.id) ?? [])]));
    setFacts(next);
    setNeverPublished(new Set(cats.filter((c) => !next.get(c.id)?.hasPublished).map((c) => c.id)));

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

  /**
   * Wrap a mutation with busy state + error surfacing + reload. `fn` returns a
   * readable failure, or null when the write really landed — and only then is
   * `success` shown.
   */
  const run = async (
    key: string,
    fn: () => Promise<string | null>,
    success: string | (() => string)
  ) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    let failure: string | null;
    try {
      failure = await fn();
    } catch (err) {
      failure = adminErrorMessage(err instanceof Error ? err.message : String(err), "save this change");
    }
    if (failure) setError(failure);
    await load();
    setBusy(null);
    if (!failure) {
      setNotice(typeof success === "function" ? success() : success);
      // Tell the dashboard an edit landed so the publish count re-reads.
      onChange?.();
    }
  };

  /** Resolve the draft version for a category, then apply a patch to it. */
  const patchDraft = async (
    cat: Category,
    patch: Record<string, unknown>
  ): Promise<string | null> => {
    const client = getBrowserSupabase();
    const { id: versionId, error } = await categoryDraftId(client, cat.id);
    if (error || !versionId) {
      return adminErrorMessage(error, `change ${cat.name}`);
    }
    // Verified: only a real change to the DRAFT row counts as saved.
    const result = await updateDraftVersion(client, "category_versions", versionId, patch, {
      action: `change ${cat.name}`,
    });
    if (!result.ok) return result.message;

    // Hiding a section and showing it again is a round trip to nowhere; don't
    // leave it queued as a change.
    await settleDraft(client, "category", versionId);
    return null;
  };

  /** "…when you publish", said in terms of what customers see meanwhile. */
  const untilPublish = (cat: Category) =>
    facts.get(cat.id)?.hasPublished === false
      ? "It isn't on the site yet — customers see nothing until you publish it."
      : "Customers see the current live version until you publish.";

  const toggleVisible = (cat: Category) =>
    run(
      cat.id,
      () => patchDraft(cat, { is_visible: !cat.is_visible }),
      () => `${cat.name} will be ${cat.is_visible ? "hidden" : "visible"} after you publish. ${untilPublish(cat)}`
    );

  /**
   * The product type decides which facts the product form asks for, and which
   * are required to publish (lib/productInfo, migration 0065). Null inherits
   * the parent's. A draft change like any other, live at Publish.
   */
  const setProfile = (cat: Category, profile: ProductProfile | null, inherited: string) =>
    run(
      cat.id,
      () => patchDraft(cat, { product_profile: profile }),
      () =>
        `${cat.name} will use “${profile ? profileLabel(profile) : inherited}” product details after you publish. ${untilPublish(cat)}`
    );

  const rename = (cat: Category, name: string) =>
    run(
      cat.id,
      () => patchDraft(cat, { name }),
      () => `Renamed to “${name}” in the draft. ${untilPublish(cat)}`
    );

  /** Swap sort_order with the adjacent sibling so ordering is stable. */
  const move = (cat: Category, direction: -1 | 1) => {
    const siblings = cat.parent_id === null ? parents : childrenOf(cat.parent_id);
    const index = siblings.findIndex((c) => c.id === cat.id);
    const swapWith = siblings[index + direction];
    if (!swapWith) return;

    return run(
      cat.id,
      async () => {
        const a = await patchDraft(cat, { sort_order: swapWith.sort_order });
        if (a) return a;
        return patchDraft(swapWith, { sort_order: cat.sort_order });
      },
      `Moved ${cat.name} in the draft order. Customers see the current order until you publish.`
    );
  };

  // Staged, not immediate: the section stays live until the next publish.
  const remove = (cat: Category) =>
    run(
      cat.id,
      async () => {
        setConfirmDelete(null);
        const client = getBrowserSupabase();
        const { id: versionId, error } = await categoryDraftId(client, cat.id);
        if (error || !versionId) {
          return adminErrorMessage(error, `stage the deletion of ${cat.name}`);
        }
        return markPendingDelete(client, "category_versions", versionId);
      },
      () =>
        facts.get(cat.id)?.hasPublished === false
          ? `${cat.name} will be removed when you next publish. It was never published, so customers aren't affected.`
          : `${cat.name} will be deleted when you publish. It stays on the site until then.`
    );

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

    await run(
      "new",
      async () => {
        // New sections start hidden AND unpublished — two independent gates, so a
        // half-built section cannot reach the site by either route.
        const { id, error } = await newCategoryDraft(
          getBrowserSupabase(),
          name.trim(),
          slug,
          parentId,
          sort_order
        );
        if (error) return adminErrorMessage(error, `add ${name.trim()}`);
        return id ? null : adminErrorMessage(null, `add ${name.trim()}`);
      },
      `Added “${name.trim()}” as a hidden draft. Customers can't see it until you make it visible and publish.`
    );
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
        <p role="alert" className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}
      <p role="status" className={notice ? "rounded-lg bg-linen/70 px-4 py-3 text-sm text-ink" : "sr-only"}>
        {notice}
      </p>

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
                facts={facts.get(parent.id)}
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
                onSetProfile={(p) => setProfile(parent, p, "General")}
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
                    facts={facts.get(child.id)}
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
                    inheritedProfile={parent.product_profile ?? "general"}
                    onSetProfile={(p) =>
                      setProfile(child, p, `Same as ${parent.name} (${profileLabel(parent.product_profile ?? "general")})`)
                    }
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
  facts,
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
  inheritedProfile,
  onSetProfile,
  onRename,
  onMove,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  cat: Category;
  facts?: PublicationFacts;
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
  /** A sub-category's parent type, offered as "Same as parent". Absent for a parent. */
  inheritedProfile?: ProductProfile;
  onSetProfile: (profile: ProductProfile | null) => void;
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
        {facts && (
          <StatusBadges
            // With no draft, the status below describes the live section too,
            // so a published, switched-on section that the shop still drops
            // (no products, hidden parent) must not read "Live".
            facts={!facts.hasDraft && status && !status.live ? { ...facts, liveVisible: false } : facts}
            noun="category"
            className="ml-2 align-middle"
          />
        )}
        {facts?.hasPublished && !facts.pendingDelete && cat.is_visible !== facts.liveVisible && (
          <span className="ml-2 align-middle text-xs text-ink/70">
            {cat.is_visible ? "Visible after you publish" : "Hidden after you publish"}
          </span>
        )}
        <p className="mt-0.5 text-xs text-ink/60">
          /{cat.slug} · {productCount} {productCount === 1 ? "product" : "products"}
        </p>
        {/* Which details the product form asks for here — and which it needs
            before publishing. A sub-category normally inherits its parent's. */}
        <label className="mt-1 inline-flex items-center gap-2 text-xs text-ink/60">
          Product type
          <select
            value={cat.product_profile ?? ""}
            disabled={busy}
            onChange={(e) => onSetProfile((e.target.value || null) as ProductProfile | null)}
            className="rounded border border-ink/15 bg-cream px-2 py-0.5 text-xs text-ink focus:border-terracotta focus:outline-none disabled:opacity-50"
          >
            <option value="">
              {inheritedProfile ? `Same as parent (${profileLabel(inheritedProfile)})` : "General (default)"}
            </option>
            {PRODUCT_PROFILES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {/* The status is worked out from the DRAFT's settings. With changes
            waiting, it describes the site after publishing — so it says so,
            instead of claiming the live section is already off the site. */}
        {status && !status.live && !facts?.pendingDelete && (
          <p className="mt-1 text-xs text-terracotta-dark">
            <span className="font-medium">
              {facts?.hasDraft && facts.hasPublished ? "After you publish: not on the site" : "Not on the site"} — {status.reason}.
            </span>{" "}
            <span className="text-ink/70">{status.fix}</span>
          </p>
        )}
      </div>

      <button
        onClick={onToggle}
        disabled={busy}
        aria-label={`${cat.name} is ${effectivelyVisible ? "visible" : "hidden"} in the draft. ${cat.is_visible ? "Hide" : "Show"} it — takes effect when you publish`}
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
        <div
          role="group"
          aria-label={`Confirm deleting ${cat.name}`}
          className="flex w-full flex-wrap items-center gap-2 text-xs sm:w-auto sm:max-w-md"
        >
          <span className="text-terracotta-dark">
            {deleteConfirmText("category", cat.name, facts?.hasPublished ?? true)}
            {isParent && childCount > 0
              ? ` Its ${childCount} sub-categor${childCount === 1 ? "y goes" : "ies go"} too.`
              : productCount > 0
                ? ` Its ${productCount} product${productCount === 1 ? "" : "s"} will be left uncategorised and hidden from customers.`
                : ""}
          </span>
          <button
            type="button"
            onClick={onConfirmDelete}
            className="rounded-full bg-terracotta-deep px-3 py-1 font-medium text-cream"
          >
            Delete at publish
          </button>
          <button type="button" autoFocus onClick={onCancelDelete} className="text-ink/70 hover:text-ink">
            Cancel
          </button>
        </div>
      ) : facts?.pendingDelete ? null : (
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
