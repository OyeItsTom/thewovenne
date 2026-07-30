import { supabase } from "./supabase";
import type { SiteContentMap } from "./types";

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
  brand_story: {
    title: "From the loom, to you",
    body: "THE WOVENNE works directly with handloom artisans across Kerala. No middleman, no compromise — just honest cloth, woven the way it has been for generations, sent straight to you.",
  },
};

/** Fetch one content block by key, falling back to the built-in default. */
export async function getContent<K extends keyof SiteContentMap>(
  key: K
): Promise<SiteContentMap[K]> {
  const { data, error } = await supabase
    .from("site_content")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error || !data?.value) return DEFAULT_CONTENT[key];
  // Merge over defaults so a partially-edited block never loses required fields.
  return { ...DEFAULT_CONTENT[key], ...(data.value as object) } as SiteContentMap[K];
}
