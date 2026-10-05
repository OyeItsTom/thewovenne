"use client";

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { getAdminPosts } from "@/lib/journal";
import {
  journalDraftId,
  markPendingDelete,
  newJournalDraft,
  settleDraft,
  updateDraftVersion,
} from "@/lib/drafts";
import {
  adminErrorMessage,
  deleteConfirmText,
  draftSavedMessage,
  isDirty,
} from "@/lib/adminStatus";
import { uploadImage } from "@/lib/storage";
import type { JournalPost, PublicationFacts } from "@/lib/types";
import StatusBadges from "./StatusBadges";

type Draft = {
  id?: string;
  title: string;
  slug: string;
  body: string;
  image_url: string;
  published: boolean;
};

const EMPTY: Draft = { title: "", slug: "", body: "", image_url: "", published: false };

const NEVER: PublicationFacts = { hasPublished: false, hasDraft: true, pendingDelete: false, liveVisible: false };

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const draftFrom = (post: JournalPost): Draft => ({
  id: post.id,
  title: post.title,
  slug: post.slug,
  body: post.body ?? "",
  image_url: post.image_url ?? "",
  published: post.published,
});

/**
 * Create / edit / delete journal posts, with image upload.
 *
 * Two different "published" meet here, and the screen used to blur them:
 *   - the post's own flag (`published`): is this article meant to be shown?
 *   - the VERSION state: has this edit been released to the site yet?
 * Both must hold for a customer to read it (lib/journal). So the flag is
 * called "Show on the site", the release state comes from the versions
 * (StatusBadges), and nothing here says "Published" about a draft.
 */
export default function JournalManager({ onChange }: { onChange?: () => void }) {
  const [posts, setPosts] = useState<JournalPost[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  // What the editor opened with, for "Unsaved changes" (lib/adminStatus).
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // An action waiting on "Discard unsaved changes?" — cancel, or open another post.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  const dirty = draft !== null && isDirty(baseline, draft);

  const load = useCallback(async () => {
    try {
      setPosts(await getAdminPosts(getBrowserSupabase()));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload or leave the page with edits in the editor: the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (pendingLeave) keepEditingRef.current?.focus();
  }, [pendingLeave]);

  /** Run `next` now, or — with unsaved edits — after the admin agrees to drop them. */
  const leaveEditor = (next: () => void) => {
    if (dirty) {
      setPendingLeave(() => next);
      return;
    }
    next();
  };

  const openEditor = (d: Draft) => {
    setError(null);
    setNotice(null);
    setDraft(d);
    setBaseline(d);
  };

  const closeEditor = () => {
    setDraft(null);
    setBaseline(null);
    setError(null);
  };

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
      e.target.value = "";
    }
  };

  async function saveDraft() {
    if (!draft) return;
    if (!draft.title.trim()) return setError("A title is required — nothing was saved.");
    const slug = draft.slug || slugify(draft.title);
    const row = {
      title: draft.title,
      slug,
      body: draft.body || null,
      image_url: draft.image_url || null,
      published: draft.published,
    };
    const facts = posts.find((p) => p.id === draft.id)?.publication;
    const hasPublished = !!draft.id && (facts?.hasPublished ?? true);

    setSaving(true);
    setError(null);
    setNotice(null);
    // Writes land on the draft version; the post on the site is untouched
    // until publish.
    const client = getBrowserSupabase();
    const { id: versionId, error: draftError } = draft.id
      ? await journalDraftId(client, draft.id)
      : await newJournalDraft(client);

    if (draftError || !versionId) {
      setSaving(false);
      return setError(adminErrorMessage(draftError, "start a draft for this post"));
    }

    // Verified: saved only if exactly one DRAFT row changed.
    const result = await updateDraftVersion(client, "journal_versions", versionId, row, {
      action: "save this draft",
    });
    if (!result.ok) {
      setSaving(false);
      return setError(result.message);
    }
    // Editing a post back to what is already live is not a change.
    const settled = await settleDraft(client, "journal", versionId);
    setSaving(false);
    closeEditor();
    setNotice(
      draftSavedMessage({ noun: "post", name: draft.title, hasPublished, settled }) +
        (!settled && !draft.published ? " It is set to stay off the site even once published." : "")
    );
    await load();
    onChange?.();
  }

  // Staged: the post stays live until the next publish.
  async function remove(post: JournalPost) {
    setConfirmDelete(null);
    setError(null);
    setNotice(null);
    const client = getBrowserSupabase();
    const { id: versionId, error } = await journalDraftId(client, post.id);
    if (error || !versionId) {
      return setError(adminErrorMessage(error, `stage the deletion of “${post.title}”`));
    }
    const message = await markPendingDelete(client, "journal_versions", versionId);
    if (message) return setError(message);
    setNotice(
      post.publication?.hasPublished === false
        ? `“${post.title}” will be removed when you next publish. It was never published, so readers aren't affected.`
        : `“${post.title}” will be deleted when you publish. It stays on the site until then.`
    );
    await load();
    onChange?.();
  }

  async function toggleShown(post: JournalPost) {
    setError(null);
    setNotice(null);
    const client = getBrowserSupabase();
    const { id: versionId, error } = await journalDraftId(client, post.id);
    if (error || !versionId) {
      return setError(adminErrorMessage(error, `change “${post.title}”`));
    }
    // Used to ignore the result entirely — a refused write looked like a
    // successful toggle until the next reload.
    const result = await updateDraftVersion(
      client,
      "journal_versions",
      versionId,
      { published: !post.published },
      { action: `change “${post.title}”` }
    );
    if (!result.ok) return setError(result.message);
    const settled = await settleDraft(client, "journal", versionId);
    const live = post.publication?.hasPublished !== false;
    setNotice(
      settled && live
        ? `“${post.title}” is back to its live setting — nothing is waiting to publish.`
        : `“${post.title}” will be ${post.published ? "taken off" : "shown on"} the site when you publish.${
            live ? " Until then readers see the current live version." : ""
          }`
    );
    await load();
    onChange?.();
  }

  return (
    <div className="space-y-6">
      {loadError && (
        <p role="alert" className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          Couldn&apos;t load the journal posts, so this list may be out of date.
          Reload the page, signing in again if asked.{" "}
          <button type="button" onClick={() => void load()} className="font-medium underline">
            Try again
          </button>
        </p>
      )}
      <p role="status" className={notice ? "rounded-lg bg-linen/70 px-4 py-3 text-sm text-ink" : "sr-only"}>
        {notice}
      </p>
      {error && !draft && (
        <p role="alert" className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      {!draft && (
        <button
          onClick={() => openEditor({ ...EMPTY })}
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
          {pendingLeave && (
            <div
              role="group"
              aria-labelledby="journal-unsaved-question"
              className="mt-4 rounded-xl border border-terracotta/40 bg-terracotta/10 p-4"
            >
              <p id="journal-unsaved-question" className="text-sm font-medium text-ink">
                You have unsaved changes to this post. Leave without saving them?
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  ref={keepEditingRef}
                  type="button"
                  onClick={() => setPendingLeave(null)}
                  className="rounded-full bg-ink px-4 py-2 text-xs font-medium text-cream hover:bg-ink-light"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = pendingLeave;
                    setPendingLeave(null);
                    next();
                  }}
                  className="rounded-full border border-terracotta-deep px-4 py-2 text-xs font-medium text-terracotta-deep hover:bg-terracotta/10"
                >
                  Discard changes
                </button>
              </div>
            </div>
          )}
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
                {/* sr-only, not display:none, so the upload is reachable by keyboard. */}
                <label className="cursor-pointer rounded-full border border-ink/15 px-4 py-2 text-sm text-ink focus-within:ring-2 focus-within:ring-terracotta focus-within:ring-offset-2 hover:border-terracotta">
                  {uploading ? "Uploading…" : draft.image_url ? "Change image" : "Upload image"}
                  <input type="file" accept="image/*" onChange={handleFile} disabled={uploading} className="sr-only" />
                </label>
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={draft.published}
                onChange={(e) => setDraft({ ...draft, published: e.target.checked })}
                aria-describedby="journal-show-meaning"
                className="mt-0.5 h-4 w-4 accent-terracotta"
              />
              <span>
                Show on the site
                <span id="journal-show-meaning" className="block text-xs text-ink/70">
                  Takes effect when you publish. Leave it off to keep a finished
                  post back after publishing.
                </span>
              </span>
            </label>
            {error && (
              <p role="alert" className="text-sm text-terracotta-dark">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={saveDraft}
                disabled={uploading || saving}
                aria-describedby="journal-save-meaning"
                className="rounded-full bg-terracotta-deep px-6 py-2.5 text-sm font-medium text-cream hover:bg-terracotta-dark disabled:opacity-50"
              >
                {saving ? "Saving draft…" : "Save draft"}
              </button>
              <button
                onClick={() => leaveEditor(closeEditor)}
                className="rounded-full px-6 py-2.5 text-sm text-ink/70 hover:text-ink"
              >
                Cancel
              </button>
              <p id="journal-save-meaning" className="text-xs text-ink/70">
                {dirty && <span className="font-medium text-ink">Unsaved changes · </span>}
                Saves a draft. Readers see nothing new until you publish.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="divide-y divide-ink/10 rounded-2xl border border-ink/10">
        {posts.length === 0 && !loadError && (
          <p className="p-6 text-center text-ink/60">No journal posts yet.</p>
        )}
        {posts.map((post) => {
          const facts = post.publication ?? NEVER;
          return (
            <div key={post.id} className="flex flex-wrap items-center gap-4 p-4">
              <div className="relative h-12 w-16 shrink-0 overflow-hidden rounded bg-linen">
                {post.image_url && (
                  <Image src={post.image_url} alt="" fill sizes="64px" className="object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink">{post.title}</p>
                <p className="truncate text-xs text-ink/60">/{post.slug}</p>
                <StatusBadges facts={facts} noun="post" className="mt-1" />
              </div>
              {confirmDelete === post.id ? (
                <div
                  role="group"
                  aria-label={`Confirm deleting ${post.title}`}
                  className="flex w-full flex-wrap items-center justify-end gap-2 text-xs sm:w-auto sm:max-w-md"
                >
                  <span className="text-terracotta-dark">
                    {deleteConfirmText("post", post.title, facts.hasPublished)}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(post)}
                    className="rounded-full bg-terracotta-deep px-3 py-1 font-medium text-cream"
                  >
                    Delete at publish
                  </button>
                  <button
                    type="button"
                    autoFocus
                    onClick={() => setConfirmDelete(null)}
                    className="text-ink/70 hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  {!facts.pendingDelete && (
                    // Names the action. The release state is the badge; this
                    // is the post's own "show it" setting, applied at publish.
                    <button
                      type="button"
                      onClick={() => toggleShown(post)}
                      aria-label={`${post.published ? "Take" : "Show"} “${post.title}” ${post.published ? "off" : "on"} the site — takes effect when you publish`}
                      className="rounded-full border border-ink/20 px-3 py-1 text-xs text-ink/70 hover:border-ink hover:text-ink"
                    >
                      {post.published ? "Take off site" : "Show on site"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => leaveEditor(() => openEditor(draftFrom(post)))}
                    aria-label={`Edit “${post.title}”`}
                    className="text-ink/60 hover:text-terracotta"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  {!facts.pendingDelete && (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(post.id)}
                      aria-label={`Delete “${post.title}”`}
                      className="text-ink/60 hover:text-terracotta-dark"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
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
