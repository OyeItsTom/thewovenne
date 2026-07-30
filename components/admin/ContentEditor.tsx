"use client";

import { useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import { DEFAULT_CONTENT } from "@/lib/content";
import type { SiteContentMap } from "@/lib/types";

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Edits the homepage copy stored in `site_content` (home_hero / why_linen /
 * brand_story). Loads current values, merges over the built-in defaults, and
 * upserts each block by key. No code editing required to change site wording.
 */
export default function ContentEditor() {
  const [content, setContent] = useState<SiteContentMap>(DEFAULT_CONTENT);
  const [loading, setLoading] = useState(true);
  const [save, setSave] = useState<Record<string, SaveState>>({});
  const [pending, setPending] = useState(false);
  const [publishState, setPublishState] = useState<
    "idle" | "publishing" | "published" | "error"
  >("idle");
  const [publishError, setPublishError] = useState<string | null>(null);

  useEffect(() => {
    getBrowserSupabase()
      .from("site_content")
      .select("key, draft_value, value")
      .then(({ data }) => {
        // Edit the draft; fall back to the published copy for any block that
        // pre-dates migration 0010 and has no draft yet.
        const rows = new Map(
          (data ?? []).map((r: { key: string; draft_value: unknown; value: unknown }) => [
            r.key,
            r.draft_value ?? r.value,
          ])
        );
        setPending(
          (data ?? []).some(
            (r: { draft_value: unknown; value: unknown }) =>
              JSON.stringify(r.draft_value) !== JSON.stringify(r.value)
          )
        );
        setContent({
          home_hero: { ...DEFAULT_CONTENT.home_hero, ...((rows.get("home_hero") as object) ?? {}) },
          why_linen: { ...DEFAULT_CONTENT.why_linen, ...((rows.get("why_linen") as object) ?? {}) },
          brand_story: { ...DEFAULT_CONTENT.brand_story, ...((rows.get("brand_story") as object) ?? {}) },
        });
        setLoading(false);
      });
  }, []);

  async function saveBlock<K extends keyof SiteContentMap>(key: K) {
    setSave((s) => ({ ...s, [key]: "saving" }));
    const { error } = await getBrowserSupabase()
      .from("site_content")
      .upsert(
        {
          key,
          draft_value: content[key],
          // A brand-new block needs a published value too, or the storefront
          // has nothing to read until the first publish.
          value: content[key],
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
    setSave((s) => ({ ...s, [key]: error ? "error" : "saved" }));
    if (!error) setPending(true);
    if (!error) setTimeout(() => setSave((s) => ({ ...s, [key]: "idle" })), 2000);
  }

  async function publish() {
    setPublishState("publishing");
    setPublishError(null);
    const { error } = await getBrowserSupabase().rpc("publish_site_content");
    if (error) {
      setPublishState("error");
      setPublishError(error.message);
      return;
    }
    setPending(false);
    setPublishState("published");
    setTimeout(() => setPublishState("idle"), 5000);
  }

  if (loading) return <p className="text-ink/60">Loading content…</p>;

  const hero = content.home_hero;
  const why = content.why_linen;
  const story = content.brand_story;

  return (
    <div className="space-y-8">
      <PublishBar
        pending={pending}
        state={publishState}
        error={publishError}
        onPublish={publish}
      />

      {/* Hero */}
      <Block title="Homepage hero" onSave={() => saveBlock("home_hero")} state={save.home_hero}>
        <Text label="Eyebrow" value={hero.eyebrow} onChange={(v) => setContent((c) => ({ ...c, home_hero: { ...c.home_hero, eyebrow: v } }))} />
        <Text label="Heading" value={hero.heading} onChange={(v) => setContent((c) => ({ ...c, home_hero: { ...c.home_hero, heading: v } }))} />
        <Text area label="Subheading" value={hero.subheading} onChange={(v) => setContent((c) => ({ ...c, home_hero: { ...c.home_hero, subheading: v } }))} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Button label" value={hero.cta_label} onChange={(v) => setContent((c) => ({ ...c, home_hero: { ...c.home_hero, cta_label: v } }))} />
          <Text label="Button link" value={hero.cta_href} onChange={(v) => setContent((c) => ({ ...c, home_hero: { ...c.home_hero, cta_href: v } }))} />
        </div>
      </Block>

      {/* Why linen */}
      <Block title="“Why linen” section" onSave={() => saveBlock("why_linen")} state={save.why_linen}>
        <Text label="Heading" value={why.title} onChange={(v) => setContent((c) => ({ ...c, why_linen: { ...c.why_linen, title: v } }))} />
        {why.cards.map((card, i) => (
          <div key={i} className="rounded-lg border border-ink/10 p-3">
            <Text label={`Card ${i + 1} title`} value={card.title} onChange={(v) =>
              setContent((c) => {
                const cards = [...c.why_linen.cards];
                cards[i] = { ...cards[i], title: v };
                return { ...c, why_linen: { ...c.why_linen, cards } };
              })} />
            <Text area label={`Card ${i + 1} text`} value={card.text} onChange={(v) =>
              setContent((c) => {
                const cards = [...c.why_linen.cards];
                cards[i] = { ...cards[i], text: v };
                return { ...c, why_linen: { ...c.why_linen, cards } };
              })} />
          </div>
        ))}
      </Block>

      {/* Brand story */}
      <Block title="Brand story" onSave={() => saveBlock("brand_story")} state={save.brand_story}>
        <Text label="Heading" value={story.title} onChange={(v) => setContent((c) => ({ ...c, brand_story: { ...c.brand_story, title: v } }))} />
        <Text area label="Body" value={story.body} onChange={(v) => setContent((c) => ({ ...c, brand_story: { ...c.brand_story, body: v } }))} />
      </Block>
    </div>
  );
}

function Block({
  title,
  children,
  onSave,
  state = "idle",
}: {
  title: string;
  children: React.ReactNode;
  onSave: () => void;
  state?: SaveState;
}) {
  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h3 className="font-heading text-2xl text-ink">{title}</h3>
      <div className="mt-4 space-y-4">{children}</div>
      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={state === "saving"}
          className="rounded-full bg-terracotta px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-terracotta-dark disabled:opacity-50"
        >
          {state === "saving" ? "Saving…" : "Save changes"}
        </button>
        {state === "saved" && <span className="text-sm text-ink/60">Saved ✓</span>}
        {state === "error" && <span className="text-sm text-terracotta-dark">Couldn’t save — try again.</span>}
      </div>
    </section>
  );
}

function Text({
  label,
  value,
  onChange,
  area = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  area?: boolean;
}) {
  const cls =
    "mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none";
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      {area ? (
        <textarea rows={3} className={cls} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={cls} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

/**
 * Sits above the blocks so the state of the site is visible before you start
 * editing: whether anything is waiting to go live, and one button to send it.
 */
function PublishBar({
  pending,
  state,
  error,
  onPublish,
}: {
  pending: boolean;
  state: "idle" | "publishing" | "published" | "error";
  error: string | null;
  onPublish: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/10 bg-linen/50 px-5 py-4">
      <div className="text-sm">
        {state === "published" ? (
          <span className="font-medium text-ink">
            Successfully published — the homepage is live with your changes.
          </span>
        ) : pending ? (
          <>
            <span className="font-medium text-ink">Unpublished changes</span>
            <span className="text-ink/60">
              {" "}
              — saved here, not yet visible on the site.
            </span>
          </>
        ) : (
          <span className="text-ink/60">
            Everything here is live. Saving edits keeps them as drafts until you
            publish.
          </span>
        )}
        {state === "error" && error && (
          <p className="mt-1 text-terracotta-dark">{error}</p>
        )}
      </div>

      <button
        onClick={onPublish}
        disabled={!pending || state === "publishing"}
        className="rounded-full bg-ink px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
      >
        {state === "publishing" ? "Publishing…" : "Publish to site"}
      </button>
    </div>
  );
}
