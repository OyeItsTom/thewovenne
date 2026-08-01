import { supabase } from "./supabase";
import type { SiteContentMap } from "./types";
import { ANON_CTX, type ReadCtx } from "./readCtx";

/**
 * Default homepage content — mirrors the seed in supabase/migrations/0007_seed.sql. Used as a graceful
 * fallback so pages always render, even before Supabase is configured/seeded or
 * if a key has been deleted from the admin.
 */
export const DEFAULT_CONTENT: SiteContentMap = {
  home_hero: {
    eyebrow: "Woven in India · Worn for life",
    heading: "THE WOVENNE",
    subheading:
      "Authentic, handcrafted linen — sent direct from the loom houses of Kerala to your door. From the loom, to you. Nothing in between.",
    cta_label: "Explore the Collection",
    cta_href: "/shop",
  },
  why_linen: {
    title: "Why linen",
    cards: [
      { title: "Kind to your skin", text: "Naturally breathable and hypoallergenic — linen keeps you cool and comfortable all day." },
      { title: "Kinder to the earth", text: "Flax needs little water and no irrigation. Woven by hand, it treads lightly." },
      { title: "Made to last", text: "Linen softens with every wash and outlives fast fashion by decades." },
    ],
  },
  seasonal_edit: {
    // Off until a campaign is deliberately turned on in the admin.
    enabled: false,
    eyebrow: "",
    heading: "",
    body: "",
    image_url: "",
    link_label: "",
    link_href: "",
  },
  brand_story: {
    title: "From the loom, to you",
    body: "THE WOVENNE works directly with handloom artisans across Kerala. No middleman, no compromise — just honest cloth, woven the way it has been for generations, sent straight to you.",
  },
};

/** Fetch one content block by key, falling back to the built-in default. */
export async function getContent<K extends keyof SiteContentMap>(
  key: K,
  ctx: ReadCtx = ANON_CTX
): Promise<SiteContentMap[K]> {
  const preview = ctx.preview;
  const { data, error } = await ctx.client
    .from("site_content")
    .select(preview ? "value, draft_value" : "value")
    .eq("key", key)
    .maybeSingle();

  const row = data as { value?: unknown; draft_value?: unknown } | null;
  // In preview the unpublished copy wins, falling back to the live one for a
  // key that has never been edited.
  const chosen = preview ? row?.draft_value ?? row?.value : row?.value;
  if (error || !chosen) return DEFAULT_CONTENT[key];
  // Merge over defaults so a partially-edited block never loses required fields.
  return { ...DEFAULT_CONTENT[key], ...(chosen as object) } as SiteContentMap[K];
}
