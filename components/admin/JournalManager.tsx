"use client";

import { ChangeEvent, useEffect, useState } from "react";
import Image from "next/image";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { uploadImage } from "@/lib/storage";
import type { JournalPost } from "@/lib/types";

type Draft = {
  id?: string;
  title: string;
  slug: string;
  body: string;
  image_url: string;
  published: boolean;
};

const EMPTY: Draft = { title: "", slug: "", body: "", image_url: "", published: false };

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Create / edit / delete journal posts (journal_posts), with image upload. */
export default function JournalManager() {
  const [posts, setPosts] = useState<JournalPost[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    getBrowserSupabase()
      .from("journal_posts")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => setPosts((data as JournalPost[]) ?? []));

  useEffect(() => {
    load();
  }, []);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !draft) return;
    setUploading(true);
    setError(null);
    try {
      const url = await uploadImage(file, "journal");
      setDraft({ ...draft, image_url: url });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  async function saveDraft() {
    if (!draft) return;
    if (!draft.title) return setError("A title is required.");
    const slug = draft.slug || slugify(draft.title);
    const row = {
      title: draft.title,
      slug,
      body: draft.body || null,
      image_url: draft.image_url || null,
      published: draft.published,
    };

    const query = draft.id
      ? getBrowserSupabase().from("journal_posts").update(row).eq("id", draft.id)
      : getBrowserSupabase().from("journal_posts").insert(row);

    const { error: err } = await query;
    if (err) return setError(err.message);
    setDraft(null);
    setError(null);
    load();
  }

  async function remove(id: string) {
    await getBrowserSupabase().from("journal_posts").delete().eq("id", id);
    load();
  }

  async function togglePublished(post: JournalPost) {
    await getBrowserSupabase()
      .from("journal_posts")
      .update({ published: !post.published })
      .eq("id", post.id);
    load();
  }

  return (
    <div className="space-y-6">
      {!draft && (
        <button
          onClick={() => setDraft({ ...EMPTY })}
          className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-ink-light"
        >
          <Plus className="h-4 w-4" /> New journal post
        </button>
      )}

      {draft && (
        <div className="rounded-2xl border border-ink/10 bg-cream p-6">
          <h3 className="font-heading text-2xl text-ink">
            {draft.id ? "Edit post" : "New post"}
          </h3>
          <div className="mt-4 space-y-4">
            <Field label="Title" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />
            <Field
              label="Slug (leave blank to auto-generate)"
              value={draft.slug}
              placeholder={draft.title ? slugify(draft.title) : "the-pit-loom-of-kerala"}
              onChange={(v) => setDraft({ ...draft, slug: v })}
            />
            <Field area label="Body" value={draft.body} onChange={(v) => setDraft({ ...draft, body: v })} />
            <div>
              <span className="text-sm font-medium text-ink/70">Cover image</span>
              <div className="mt-1 flex items-center gap-4">
                <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-linen">
                  {draft.image_url && (
                    <Image src={draft.image_url} alt="" fill sizes="96px" className="object-cover" />
                  )}
                </div>
                <label className="cursor-pointer rounded-full border border-ink/15 px-4 py-2 text-sm text-ink hover:border-terracotta">
                  {uploading ? "Uploading…" : draft.image_url ? "Change image" : "Upload image"}
                  <input type="file" accept="image/*" onChange={handleFile} disabled={uploading} className="hidden" />
                </label>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={draft.published}
                onChange={(e) => setDraft({ ...draft, published: e.target.checked })}
                className="h-4 w-4 accent-terracotta"
              />
              Published (visible on the site)
            </label>
            {error && <p className="text-sm text-terracotta-dark">{error}</p>}
            <div className="flex gap-3">
              <button
                onClick={saveDraft}
                disabled={uploading}
                className="rounded-full bg-terracotta px-6 py-2.5 text-sm font-medium text-cream hover:bg-terracotta-dark disabled:opacity-50"
              >
                Save post
              </button>
              <button
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
                className="rounded-full px-6 py-2.5 text-sm text-ink/60 hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="divide-y divide-ink/10 rounded-2xl border border-ink/10">
        {posts.length === 0 && (
          <p className="p-6 text-center text-ink/60">No journal posts yet.</p>
        )}
        {posts.map((post) => (
          <div key={post.id} className="flex items-center gap-4 p-4">
            <div className="relative h-12 w-16 shrink-0 overflow-hidden rounded bg-linen">
              {post.image_url && (
                <Image src={post.image_url} alt="" fill sizes="64px" className="object-cover" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink">{post.title}</p>
              <p className="truncate text-xs text-ink/50">/{post.slug}</p>
            </div>
            <button
              onClick={() => togglePublished(post)}
              className={
                post.published
                  ? "rounded-full bg-gold/15 px-3 py-1 text-xs uppercase tracking-wider text-ink"
                  : "rounded-full bg-ink px-3 py-1 text-xs uppercase tracking-wider text-cream"
              }
            >
              {post.published ? "Published" : "Draft"}
            </button>
            <button
              onClick={() =>
                setDraft({
                  id: post.id,
                  title: post.title,
                  slug: post.slug,
                  body: post.body ?? "",
                  image_url: post.image_url ?? "",
                  published: post.published,
                })
              }
              aria-label="Edit post"
              className="text-ink/50 hover:text-terracotta"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              onClick={() => remove(post.id)}
              aria-label="Delete post"
              className="text-ink/50 hover:text-terracotta-dark"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  area = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  area?: boolean;
  placeholder?: string;
}) {
  const cls =
    "mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none";
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      {area ? (
        <textarea rows={5} className={cls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={cls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
