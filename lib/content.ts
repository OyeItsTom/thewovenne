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
    eyebrow: "Chosen piece by piece.",
    heading: "THE WOVENNE",
    subheading: "A considered selection of clothing, sarees and jewellery.",
    cta_label: "Explore the Collection",
    cta_href: "/in/shop",
  },
  /*
   * The "Why Us" section. The key and component keep their old linen names on
   * purpose — renaming a site_content key orphans the stored row — but nothing
   * in the copy may say the shop sells linen today. Card 2 names linen only as
   * where the collection is going; product metadata and schema read the
   * product's own fabric, never this.
   */
  why_linen: {
    title: "Why Us",
    cards: [
      {
        title: "Chosen piece by piece",
        text: "Every product is reviewed and chosen before it reaches the shop. Many designs are carried in very small quantities, often just one or two pieces.",
      },
      {
        title: "Natural fabrics first",
        text: "Our clothing range is centred on natural fibres. Today that means cotton, including handloom mul cotton and tissue cotton, with linen becoming a key material as the collection grows.",
      },
      {
        title: "Chosen to be worn again",
        text: "We look for pieces with the fabric, feel and design to earn repeat wear — for an occasion, an ordinary day, or somewhere in between.",
      },
    ],
  },
  seasonal_edit: {
    // Off until a campaign is deliberately turned on in the admin.
    enabled: false,
    eyebrow: "",
    heading: "",
    body: "",
    image_url: "",
    image_url_mobile: "",
    image_fit: "cover",
    link_label: "",
    link_href: "",
  },
  // Empty until the admin adds one. An array rather than a fixed set of slots:
  // six blank sections in the editor invites filling them for the sake of it.
  lookbook: { sections: [] },
  brand_story: {
    title: "Chosen piece by piece",
    body: "THE WOVENNE is based in Kerala, India and built around a considered approach to what we stock. We focus on clothing and sarees in natural fabrics, alongside a small selected jewellery range.",
  },
  footer: {
    brand_description:
      "Chosen piece by piece. A considered selection of clothing, sarees and jewellery, shipped across India.",
    brand_description_visible: true,
    /*
     * ONE DEFAULT OVERRIDE, AND IT IS A CASING FIX.
     *
     * The Terms & Conditions page is titled "TERMS & CONDITIONS" in the CMS, so
     * the footer — which has always shown the page's own title — printed one
     * shouting link in a column of title-cased ones.
     *
     * Correcting it HERE rather than in CSS is the difference between fixing the
     * label and hiding it: a text-transform would leave the underlying word
     * wrong everywhere it is read aloud or copied, and would have to be applied
     * to one link and no other, which is exactly the special case worth
     * avoiding. Correcting it here rather than by renaming the page is
     * deliberate too — the page's own heading and browser title are the
     * owner's editorial decision, and this change does not reach into them.
     *
     * The owner can change or remove this from Admin → Footer like any other
     * label; if that page is ever renamed or unpublished, this row simply stops
     * matching anything and does nothing.
     */
    explore: [{ id: "page:policies", label: "Terms & Conditions" }],
    whatsapp: {
      visible: true,
      label: "WhatsApp",
      // Blank on purpose: the number stays in the environment unless somebody
      // deliberately overrides it here. See lib/whatsapp.
      number: "",
    },
    email: {
      visible: true,
      address: "hello@thewovenne.com",
    },
    instagram: {
      visible: true,
      // Both taken from the address the footer already linked, not invented.
      username: "thewovenne",
      url: "https://www.instagram.com/thewovenne",
    },
    bottom_note: "Made with care in India",
    bottom_note_visible: true,
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
