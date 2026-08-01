"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { uploadImage, UnsupportedImageError } from "@/lib/storage";
import { getBrowserSupabase } from "@/lib/supabase";
import { DEFAULT_CONTENT } from "@/lib/content";
import type { SiteContentMap } from "@/lib/types";

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Edits the homepage copy stored in `site_content` (home_hero / why_linen /
 * brand_story / seasonal_edit). Loads current values, merges over the built-in defaults, and
 * upserts each block by key. No code editing required to change site wording.
 */
export default function ContentEditor({ onChange }: { onChange?: () => void }) {
  const [content, setContent] = useState<SiteContentMap>(DEFAULT_CONTENT);
  const [loading, setLoading] = useState(true);
  const [save, setSave] = useState<Record<string, SaveState>>({});

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
        setContent({
          home_hero: { ...DEFAULT_CONTENT.home_hero, ...((rows.get("home_hero") as object) ?? {}) },
          why_linen: { ...DEFAULT_CONTENT.why_linen, ...((rows.get("why_linen") as object) ?? {}) },
          brand_story: { ...DEFAULT_CONTENT.brand_story, ...((rows.get("brand_story") as object) ?? {}) },
          seasonal_edit: { ...DEFAULT_CONTENT.seasonal_edit, ...((rows.get("seasonal_edit") as object) ?? {}) },
        });
        setLoading(false);
      });
  }, []);

  async function saveBlock<K extends keyof SiteContentMap>(key: K) {
    setSave((s) => ({ ...s, [key]: "saving" }));
    // Writes the DRAFT only. Setting `value` here would put homepage copy live
    // the moment it saved, which is exactly what this system exists to prevent.
    // The three blocks are seeded by migration 0007, so a row always exists to
    // update — nothing here creates new keys.
    const { error } = await getBrowserSupabase()
      .from("site_content")
      .update({
        draft_value: content[key],
        updated_at: new Date().toISOString(),
      })
      .eq("key", key);
    setSave((s) => ({ ...s, [key]: error ? "error" : "saved" }));
    if (!error) {
      onChange?.();
      setTimeout(() => setSave((s) => ({ ...s, [key]: "idle" })), 2000);
    }
  }

  if (loading) return <p className="text-ink/60">Loading content…</p>;

  const hero = content.home_hero;
  const why = content.why_linen;
  const story = content.brand_story;
  const season = content.seasonal_edit;

  const setSeason = (patch: Partial<typeof season>) =>
    setContent((c) => ({ ...c, seasonal_edit: { ...c.seasonal_edit, ...patch } }));

  return (
    <div className="space-y-8">

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

      {/* Seasonal edit */}
      <Block
        title="Seasonal edit"
        onSave={() => saveBlock("seasonal_edit")}
        state={save.seasonal_edit}
      >
        <p className="-mt-1 text-sm text-ink/60">
          An optional section below the homepage hero, for Onam, Christmas and
          the like. It stays off the site entirely until you tick “Show”, and it
          needs both a heading and an image before it will appear.
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={season.enabled}
            onChange={(e) => setSeason({ enabled: e.target.checked })}
            className="h-4 w-4 accent-terracotta"
          />
          <span className="font-medium text-ink/70">
            Show this section on the homepage
          </span>
        </label>

        <SeasonImage
          url={season.image_url}
          onChange={(url) => setSeason({ image_url: url })}
        />

        <Text label="Eyebrow (small line above)" value={season.eyebrow} onChange={(v) => setSeason({ eyebrow: v })} />
        <Text label="Heading" value={season.heading} onChange={(v) => setSeason({ heading: v })} />
        <Text area label="Body" value={season.body} onChange={(v) => setSeason({ body: v })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Link label" value={season.link_label} onChange={(v) => setSeason({ link_label: v })} />
          <Text label="Link address" value={season.link_href} onChange={(v) => setSeason({ link_href: v })} />
        </div>
        <p className="text-xs text-ink/50">
          Link address can be any page on the site — for example{" "}
          <code className="text-ink/70">/collection/onam-edit</code> for products
          you have tagged “onam-edit”, or <code className="text-ink/70">/women</code>.
        </p>
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

function SeasonImage({
  url,
  onChange,
}: {
  url: string;
  onChange: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(file: File) {
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadImage(file, "campaigns"));
    } catch (e) {
      // HEIC and other unsupported formats get a plain explanation rather than
      // a storage error the admin cannot act on.
      setError(
        e instanceof UnsupportedImageError
          ? e.message
          : "Upload failed — please try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-sm">
      <span className="font-medium text-ink/70">Image</span>
      <div className="mt-1 flex items-start gap-4">
        {url ? (
          <div className="relative h-24 w-32 overflow-hidden rounded-lg bg-linen">
            <Image src={url} alt="" fill sizes="128px" className="object-cover" />
          </div>
        ) : (
          <div className="flex h-24 w-32 items-center justify-center rounded-lg border border-dashed border-ink/20 text-xs text-ink/40">
            No image
          </div>
        )}
        <div>
          <input
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handle(f);
              e.target.value = "";
            }}
            className="text-xs text-ink/70 file:mr-3 file:rounded-full file:border-0 file:bg-ink/5 file:px-4 file:py-2 file:text-xs file:text-ink hover:file:bg-ink/10"
          />
          {busy && <p className="mt-2 text-xs text-ink/50">Uploading…</p>}
          {url && !busy && (
            <button
              onClick={() => onChange("")}
              className="mt-2 block text-xs text-terracotta-dark hover:underline"
            >
              Remove image
            </button>
          )}
          {error && <p className="mt-2 text-xs text-terracotta-dark">{error}</p>}
        </div>
      </div>
    </div>
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

