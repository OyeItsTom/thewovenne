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
import { getAllCategories } from "@/lib/categories";
import { cn, uniqueSlug } from "@/lib/utils";
import type { Category } from "@/lib/types";
import Button from "@/components/ui/Button";
import NameEditor from "./NameEditor";

export default function CategoryManager() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newParentName, setNewParentName] = useState("");
  const [newChild, setNewChild] = useState<{ parentId: string; name: string }>({
    parentId: "",
    name: "",
  });

  const load = useCallback(async () => {
    const [cats, { data: products }] = await Promise.all([
      getAllCategories(getBrowserSupabase()),
      getBrowserSupabase().from("products").select("category_id"),
    ]);

    const tally: Record<string, number> = {};
    for (const p of products ?? []) {
      if (p.category_id) tally[p.category_id] = (tally[p.category_id] ?? 0) + 1;
    }
    setCounts(tally);
    setCategories(cats);
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
  };

  const toggleVisible = (cat: Category) =>
    run(cat.id, async () =>
      getBrowserSupabase()
        .from("categories")
        .update({ is_visible: !cat.is_visible })
        .eq("id", cat.id)
    );

  const rename = (cat: Category, name: string) =>
    run(cat.id, async () =>
      getBrowserSupabase().from("categories").update({ name }).eq("id", cat.id)
    );

  /** Swap sort_order with the adjacent sibling so ordering is stable. */
  const move = (cat: Category, direction: -1 | 1) => {
    const siblings = cat.parent_id === null ? parents : childrenOf(cat.parent_id);
    const index = siblings.findIndex((c) => c.id === cat.id);
    const swapWith = siblings[index + direction];
    if (!swapWith) return;

    return run(cat.id, async () => {
      const a = await getBrowserSupabase()
        .from("categories")
        .update({ sort_order: swapWith.sort_order })
        .eq("id", cat.id);
      if (a.error) return a;
      return getBrowserSupabase()
        .from("categories")
        .update({ sort_order: cat.sort_order })
        .eq("id", swapWith.id);
    });
  };

  const remove = (cat: Category) =>
    run(cat.id, async () => {
      setConfirmDelete(null);
      return getBrowserSupabase().from("categories").delete().eq("id", cat.id);
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

    await run("new", async () =>
      getBrowserSupabase().from("categories").insert({
        name: name.trim(),
        slug,
        parent_id: parentId,
        // New sections start hidden — nothing appears on the storefront until
        // you have products in it and deliberately make it visible.
        is_visible: false,
        sort_order,
      })
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
        <p className="mt-0.5 text-xs text-ink/40">
          /{cat.slug} · {productCount} {productCount === 1 ? "product" : "products"}
          {parentHidden && cat.is_visible && " · parent hidden, so still not public"}
        </p>
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
