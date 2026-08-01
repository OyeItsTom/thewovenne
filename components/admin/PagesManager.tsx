"use client";

import { ChangeEvent, useCallback, useEffect, useState } from "react";
import Image from "next/image";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Plus,
  Trash2,
  Type,
  Image as ImageIcon,
  MessageCircleQuestion,
  Pilcrow,
} from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { getAdminPages, getDraftPageIds, type PageBlock, type SitePage } from "@/lib/pages";
import { markPendingDelete, newPageDraft, pageDraftId } from "@/lib/drafts";
import { uploadImage } from "@/lib/storage";
import { slugify, uniqueSlug } from "@/lib/utils";
import Button from "@/components/ui/Button";
import DraftBadge from "./DraftBadge";

const BLOCK_KINDS: { type: PageBlock["type"]; label: string; icon: typeof Type }[] = [
  { type: "heading", label: "Heading", icon: Type },
  { type: "paragraph", label: "Paragraph", icon: Pilcrow },
  { type: "image", label: "Image", icon: ImageIcon },
  { type: "faq", label: "Question", icon: MessageCircleQuestion },
];

function emptyBlock(type: PageBlock["type"]): PageBlock {
  switch (type) {
    case "heading":
      return { type: "heading", text: "" };
    case "paragraph":
      return { type: "paragraph", text: "" };
    case "image":
      return { type: "image", url: "", alt: "" };
    case "faq":
      return { type: "faq", question: "", answer: "" };
  }
}

/**
 * Edits About, Size Guide, Policies, Contact, FAQ and any page added later.
 *
 * Pages are rows rather than routes, so copy and images change without a code
 * change. Writes go to the draft version like everything else, so nothing here
 * reaches the site until Publish.
 */
export default function PagesManager({ onChange }: { onChange?: () => void }) {
  const [pages, setPages] = useState<SitePage[] | null>(null);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<SitePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");

  const load = useCallback(async () => {
    const client = getBrowserSupabase();
    setPages(await getAdminPages(client));
    setDraftIds(await getDraftPageIds(client));
    onChange?.();
  }, [onChange]);

  useEffect(() => {
    load();
  }, [load]);

  const patchBlock = (index: number, patch: Partial<PageBlock>) =>
    setEditing((p) =>
      p
        ? {
            ...p,
            body: p.body.map((b, i) =>
              i === index ? ({ ...b, ...patch } as PageBlock) : b
            ),
          }
        : p
    );

  const moveBlock = (index: number, direction: -1 | 1) =>
    setEditing((p) => {
      if (!p) return p;
      const next = [...p.body];
      const target = index + direction;
      if (target < 0 || target >= next.length) return p;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...p, body: next };
    });

  const removeBlock = (index: number) =>
    setEditing((p) => (p ? { ...p, body: p.body.filter((_, i) => i !== index) } : p));

  const addBlock = (type: PageBlock["type"]) =>
    setEditing((p) => (p ? { ...p, body: [...p.body, emptyBlock(type)] } : p));

  const handleImage = async (e: ChangeEvent<HTMLInputElement>, index: number) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(index);
    try {
      const url = await uploadImage(file, "pages");
      patchBlock(index, { url } as Partial<PageBlock>);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(null);
      e.target.value = "";
    }
  };

  async function save() {
    if (!editing) return;
    if (!editing.title.trim()) return setError("A title is required.");

    setSaving(true);
    setError(null);
    const client = getBrowserSupabase();

    const { id: versionId, error: draftError } = await pageDraftId(client, editing.id);
    if (draftError || !versionId) {
      setSaving(false);
      return setError(draftError ?? "Could not start a draft for this page.");
    }

    const { error: saveError } = await client
      .from("site_page_versions")
      .update({
        title: editing.title,
        intro: editing.intro || null,
        body: editing.body,
        in_footer: editing.in_footer,
        meta_description: editing.meta_description || null,
      })
      .eq("id", versionId);

    setSaving(false);
    if (saveError) return setError(saveError.message);

    setEditing(null);
    load();
  }

  async function addPage() {
    const title = newTitle.trim();
    if (!title) return;
    const slug = uniqueSlug(title, (pages ?? []).map((p) => p.slug));
    if (!slug) return setError("Give the page a name with letters or numbers.");

    const { error: err } = await newPageDraft(getBrowserSupabase(), title, slug);
    if (err) return setError(err);
    setNewTitle("");
    load();
  }

  async function remove(page: SitePage) {
    setConfirmDelete(null);
    const client = getBrowserSupabase();
    const { id: versionId, error: draftError } = await pageDraftId(client, page.id);
    if (draftError || !versionId) {
      return setError(draftError ?? "Could not stage this deletion.");
    }
    const message = await markPendingDelete(client, "site_page_versions", versionId);
    if (message) return setError(message);
    load();
  }

  if (pages === null) return <p className="text-ink/60">Loading pages…</p>;

  if (editing) {
    return (
      <div className="space-y-5">
        <button
          onClick={() => setEditing(null)}
          className="text-sm text-ink/60 transition-colors hover:text-terracotta"
        >
          ← Back to pages
        </button>

        <div className="rounded-2xl border border-ink/10 bg-cream p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Page title"
              value={editing.title}
              onChange={(v) => setEditing({ ...editing, title: v })}
            />
            <div>
              <Field label="Web address" value={`/${editing.slug}`} readOnly />
              <p className="mt-1 text-xs text-ink/50">
                Fixed once created, so existing links keep working.
              </p>
            </div>
          </div>

          <div className="mt-4">
            <Field
              area
              label="Intro (optional)"
              value={editing.intro ?? ""}
              onChange={(v) => setEditing({ ...editing, intro: v })}
            />
          </div>
          <div className="mt-4">
            <Field
              area
              label="Search description (optional)"
              value={editing.meta_description ?? ""}
              onChange={(v) => setEditing({ ...editing, meta_description: v })}
            />
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm text-ink/70">
            <input
              type="checkbox"
              checked={editing.in_footer}
              onChange={(e) => setEditing({ ...editing, in_footer: e.target.checked })}
            />
            Show a link to this page in the footer
          </label>
        </div>

        <div className="space-y-3">
          {editing.body.map((block, i) => (
            <div key={i} className="rounded-2xl border border-ink/10 bg-cream p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-ink/40">
                  {BLOCK_KINDS.find((k) => k.type === block.type)?.label ?? block.type}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => moveBlock(i, -1)}
                    disabled={i === 0}
                    aria-label="Move up"
                    className="rounded p-1 text-ink/40 hover:text-ink disabled:opacity-25"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => moveBlock(i, 1)}
                    disabled={i === editing.body.length - 1}
                    aria-label="Move down"
                    className="rounded p-1 text-ink/40 hover:text-ink disabled:opacity-25"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => removeBlock(i)}
                    aria-label="Remove block"
                    className="rounded p-1 text-ink/30 hover:text-terracotta"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {block.type === "heading" && (
                <Field label="Heading" value={block.text} onChange={(v) => patchBlock(i, { text: v })} />
              )}
              {block.type === "paragraph" && (
                <Field area label="Text" value={block.text} onChange={(v) => patchBlock(i, { text: v })} />
              )}
              {block.type === "faq" && (
                <>
                  <Field label="Question" value={block.question} onChange={(v) => patchBlock(i, { question: v })} />
                  <div className="mt-3">
                    <Field area label="Answer" value={block.answer} onChange={(v) => patchBlock(i, { answer: v })} />
                  </div>
                </>
              )}
              {block.type === "image" && (
                <div className="flex items-center gap-4">
                  <div className="relative h-20 w-28 shrink-0 overflow-hidden rounded-lg bg-linen">
                    {block.url && (
                      <Image src={block.url} alt="" fill sizes="112px" className="object-cover" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <label className="inline-block cursor-pointer rounded-full border border-ink/15 px-4 py-2 text-sm text-ink transition-colors hover:border-terracotta">
                      {uploading === i ? "Uploading…" : block.url ? "Replace image" : "Upload image"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
                        onChange={(e) => handleImage(e, i)}
                        disabled={uploading !== null}
                        className="hidden"
                      />
                    </label>
                    <div className="mt-2">
                      <Field
                        label="Caption / alt text"
                        value={block.alt ?? ""}
                        onChange={(v) => patchBlock(i, { alt: v } as Partial<PageBlock>)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-ink/40">Add</span>
          {BLOCK_KINDS.map(({ type, label, icon: Icon }) => (
            <button
              key={type}
              onClick={() => addBlock(type)}
              className="inline-flex items-center gap-1.5 rounded-full border border-ink/15 px-3 py-1.5 text-xs text-ink/70 transition-colors hover:border-terracotta hover:text-terracotta"
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-terracotta-dark">{error}</p>}

        <Button onClick={save} disabled={saving} size="lg">
          {saving ? "Saving…" : "Save as draft"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="max-w-prose text-sm leading-relaxed text-ink/60">
        Every word and image on these pages is editable here. Changes save as
        drafts and go live when you publish.
      </p>

      {error && <p className="text-sm text-terracotta-dark">{error}</p>}

      <div className="overflow-hidden rounded-2xl border border-ink/10">
        <ul className="divide-y divide-ink/10">
          {pages.map((page) => (
            <li key={page.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <span className="font-medium text-ink">{page.title}</span>
                {draftIds.has(page.id) && (
                  <span className="ml-2 align-middle">
                    <DraftBadge />
                  </span>
                )}
                <p className="mt-0.5 text-xs text-ink/40">
                  /{page.slug} · {page.body.length}{" "}
                  {page.body.length === 1 ? "block" : "blocks"}
                  {!page.in_footer && " · not in footer"}
                </p>
              </div>

              <a
                href={`/${page.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`View ${page.title}`}
                className="rounded p-1.5 text-ink/40 transition-colors hover:text-terracotta"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              <button
                onClick={() => setEditing(page)}
                className="rounded-full border border-ink/15 px-4 py-1.5 text-sm text-ink transition-colors hover:border-terracotta"
              >
                Edit
              </button>
              {confirmDelete === page.id ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-terracotta-dark">Delete at next publish?</span>
                  <button onClick={() => remove(page)} className="font-medium text-terracotta-dark underline">
                    Delete
                  </button>
                  <button onClick={() => setConfirmDelete(null)} className="text-ink/50">
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDelete(page.id)}
                  aria-label={`Delete ${page.title}`}
                  className="rounded p-1.5 text-ink/30 transition-colors hover:text-terracotta"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          addPage();
        }}
        className="flex items-center gap-3"
      >
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="New page title (e.g. Shipping)"
          className="w-full max-w-xs rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
        />
        <Button type="submit" variant="outline" size="md">
          <Plus className="h-4 w-4" /> Add Page
        </Button>
      </form>

      <p className="max-w-prose text-xs text-ink/50">
        Editing an existing page goes live on publish. A brand-new page also
        needs a deploy before its address ({newTitle ? `/${slugify(newTitle)}` : "/your-page"})
        exists — page URLs are built at deploy time.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  area = false,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  area?: boolean;
  readOnly?: boolean;
}) {
  const cls =
    "mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none disabled:opacity-60";
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      {area ? (
        <textarea
          rows={3}
          className={cls}
          value={value}
          readOnly={readOnly}
          disabled={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
        />
      ) : (
        <input
          className={cls}
          value={value}
          readOnly={readOnly}
          disabled={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
        />
      )}
    </label>
  );
}
