/**
 * What a product needs to say about itself, by type — and what stops it going
 * live.
 *
 * NO REACT, NO NEXT, NO DATABASE. The admin form reads this to show the
 * completeness panel as the admin types; migration 0065 states the publish half
 * of it in SQL (product_info_missing), because publishing happens in the
 * database and a rule the browser alone enforces is a rule a second tab skips.
 * scripts/product-info-db.test.ts runs both against the same cases and fails if
 * they ever disagree about what blocks a publish.
 *
 * ── THE THREE LEVELS ──
 *
 *   REQUIRED     — publishing is refused without it. Saving a draft never is.
 *   RECOMMENDED  — makes the page better for a customer or a search engine;
 *                  counted in the completeness figure, never blocks anything.
 *   OPTIONAL     — only when it is genuinely known (origin, weave, the notes).
 *                  Not counted: an unknown origin is not a gap to fill, and a
 *                  percentage that rose by typing a guess would reward inventing.
 *   N/A          — not shown for this type at all.
 *
 * ── NEVER A REASON TO INVENT ──
 *
 * Only facts the admin can know by looking at, measuring or handling the piece
 * are required: what it is made of, its colour, how to look after it, and what
 * its main photograph shows. Origin, weave and craft are optional everywhere,
 * because "I don't know" is a legitimate and common answer for them.
 */

export type ProductProfile = "saree" | "drape" | "garment" | "jewellery" | "general";

export const PRODUCT_PROFILES: { value: ProductProfile; label: string; hint: string }[] = [
  { value: "saree", label: "Saree", hint: "Fabric, colour, care; dimensions and blouse piece recommended." },
  { value: "drape", label: "Dhoti / mundu / drape", hint: "Unstitched cloth: fabric, colour, care; dimensions recommended." },
  { value: "garment", label: "Stitched garment", hint: "Fabric, colour, care; fit and sizing recommended." },
  { value: "jewellery", label: "Jewellery", hint: "Material and care; dimensions and finish recommended." },
  { value: "general", label: "General", hint: "Care required; everything else recommended." },
];

export const PROFILE_VALUES = PRODUCT_PROFILES.map((p) => p.value);

export function isProductProfile(value: unknown): value is ProductProfile {
  return typeof value === "string" && (PROFILE_VALUES as string[]).includes(value);
}

export function profileLabel(profile: ProductProfile): string {
  return PRODUCT_PROFILES.find((p) => p.value === profile)!.label;
}

/** The minimum a category needs to resolve its type: its own value and its parent. */
export interface ProfileCategory {
  id: string;
  parent_id: string | null;
  product_profile?: ProductProfile | null;
}

/**
 * The type that applies to products filed in `categoryId`: its own, else its
 * parent's, else general. The same order as category_product_profile (0065).
 */
export function effectiveProfile(
  categoryId: string | null | undefined,
  categories: readonly ProfileCategory[]
): ProductProfile {
  const own = categories.find((c) => c.id === categoryId);
  if (!own) return "general";
  if (own.product_profile) return own.product_profile;
  const parent = categories.find((c) => c.id === own.parent_id);
  return parent?.product_profile ?? "general";
}

export type InfoLevel = "required" | "recommended" | "optional" | "na";

export type InfoGroup = "basic" | "details" | "care" | "images" | "search";

export const GROUP_LABEL: Record<InfoGroup, string> = {
  basic: "Basic information",
  details: "Product details",
  care: "Care & fit",
  images: "Images",
  search: "Search & discovery",
};

export type InfoKey =
  | "name"
  | "slug"
  | "price"
  | "category"
  | "description"
  | "fabric"
  | "colour"
  | "dimensions"
  | "blouse_piece"
  | "finish"
  | "weave"
  | "origin"
  | "heritage"
  | "craft"
  | "care"
  | "fit"
  | "photos"
  | "cover_alt"
  | "gallery_alt"
  | "seo_title"
  | "meta_description";

const R = "required" as const;
const r = "recommended" as const;
const o = "optional" as const;
const x = "na" as const;

/**
 * The whole matrix, in one place. Columns: saree, drape, garment, jewellery,
 * general. Rows are in the order the form shows them.
 */
const MATRIX: Record<InfoKey, { group: InfoGroup; levels: [InfoLevel, InfoLevel, InfoLevel, InfoLevel, InfoLevel] }> = {
  name: { group: "basic", levels: [R, R, R, R, R] },
  slug: { group: "basic", levels: [R, R, R, R, R] },
  price: { group: "basic", levels: [R, R, R, R, R] },
  category: { group: "basic", levels: [R, R, R, R, R] },
  description: { group: "basic", levels: [r, r, r, r, r] },
  fabric: { group: "details", levels: [R, R, R, R, r] },
  colour: { group: "details", levels: [R, R, R, o, r] },
  dimensions: { group: "details", levels: [r, r, o, r, r] },
  blouse_piece: { group: "details", levels: [r, x, x, x, x] },
  finish: { group: "details", levels: [x, x, x, r, x] },
  weave: { group: "details", levels: [o, o, o, x, o] },
  origin: { group: "details", levels: [o, o, o, o, o] },
  heritage: { group: "details", levels: [o, o, o, o, o] },
  craft: { group: "details", levels: [o, o, o, o, o] },
  care: { group: "care", levels: [R, R, R, R, R] },
  fit: { group: "care", levels: [x, x, r, x, x] },
  photos: { group: "images", levels: [R, R, R, R, R] },
  cover_alt: { group: "images", levels: [R, R, R, R, R] },
  gallery_alt: { group: "images", levels: [r, r, r, r, r] },
  seo_title: { group: "search", levels: [o, o, o, o, o] },
  meta_description: { group: "search", levels: [o, o, o, o, o] },
};

const PROFILE_INDEX: Record<ProductProfile, number> = {
  saree: 0,
  drape: 1,
  garment: 2,
  jewellery: 3,
  general: 4,
};

export const INFO_KEYS = Object.keys(MATRIX) as InfoKey[];

export function fieldLevel(key: InfoKey, profile: ProductProfile): InfoLevel {
  return MATRIX[key].levels[PROFILE_INDEX[profile]];
}

export function fieldGroup(key: InfoKey): InfoGroup {
  return MATRIX[key].group;
}

/**
 * The admin's word for a field. The fabric column holds what jewellery is made
 * of too — it is the one "material" column, and schema.org's `material` already
 * reads it — so for jewellery it is called Material rather than Fabric.
 */
export function fieldLabel(key: InfoKey, profile: ProductProfile): string {
  switch (key) {
    case "name": return "Name";
    case "slug": return "Web address";
    case "price": return "Price";
    case "category": return "Category";
    case "description": return "Description";
    case "fabric": return profile === "jewellery" ? "Material" : "Fabric";
    case "colour": return "Colour";
    case "dimensions": return "Dimensions";
    case "blouse_piece": return "Blouse piece";
    case "finish": return "Finish";
    case "weave": return profile === "jewellery" ? "Technique" : "Weave / technique";
    case "origin": return "Origin";
    case "heritage": return "Heritage";
    case "craft": return "Craft";
    case "care": return "Care instructions";
    case "fit": return "Fit & sizing";
    case "photos": return "At least one photo";
    case "cover_alt": return "Main image alt text";
    case "gallery_alt": return "Alt text on every photo";
    case "seo_title": return "SEO title";
    case "meta_description": return "Meta description";
  }
}

/** What the form currently holds — strings as typed, so blank is "". */
export interface InfoInput {
  profile: ProductProfile;
  name: string;
  slug: string;
  price: string;
  /** A sub-category has been chosen. */
  hasCategory: boolean;
  description: string;
  fabric: string;
  colour: string;
  dimensions: string;
  blouse_piece: string;
  finish: string;
  weave: string;
  origin: string;
  heritage: string;
  craft: string;
  care: string;
  fit: string;
  /** The gallery in order, cover first. */
  images: { url: string; alt: string }[];
  seo_title: string;
  meta_description: string;
  /**
   * Hidden products are not judged (0065): hiding a piece must never wait on
   * writing it up. Absent means visible.
   */
  isActive?: boolean;
}

const filled = (s: string | null | undefined) => Boolean(s && s.trim());

export function isFilled(key: InfoKey, input: InfoInput): boolean {
  switch (key) {
    case "name": return filled(input.name);
    case "slug": return filled(input.slug);
    case "price": return Number(input.price) > 0;
    case "category": return input.hasCategory;
    case "description": return filled(input.description);
    case "fabric": return filled(input.fabric);
    case "colour": return filled(input.colour);
    case "dimensions": return filled(input.dimensions);
    case "blouse_piece": return filled(input.blouse_piece);
    case "finish": return filled(input.finish);
    case "weave": return filled(input.weave);
    case "origin": return filled(input.origin);
    case "heritage": return filled(input.heritage);
    case "craft": return filled(input.craft);
    case "care": return filled(input.care);
    case "fit": return filled(input.fit);
    case "photos": return input.images.length > 0;
    case "cover_alt": return input.images.length > 0 && filled(input.images[0].alt);
    case "gallery_alt": return input.images.slice(1).every((i) => filled(i.alt));
    case "seo_title": return filled(input.seo_title);
    case "meta_description": return filled(input.meta_description);
  }
}

/**
 * Whether a field applies to THIS product right now. Alt text on later photos
 * means nothing with one photo; the cover's alt text waits until there is a
 * cover (no photo is the "photos" item's job).
 */
function applies(key: InfoKey, input: InfoInput): boolean {
  if (key === "cover_alt") return input.images.length > 0;
  if (key === "gallery_alt") return input.images.length > 1;
  return true;
}

export interface InfoItem {
  key: InfoKey;
  label: string;
  group: InfoGroup;
  level: Exclude<InfoLevel, "na">;
  done: boolean;
}

export interface InfoAssessment {
  profile: ProductProfile;
  items: InfoItem[];
  required: InfoItem[];
  recommended: InfoItem[];
  optional: InfoItem[];
  /** Required items still missing, as labels, in form order. */
  missingRequired: string[];
  missingRecommended: string[];
  /**
   * Required + recommended items done, as a whole percentage. Optional facts
   * are not counted, so 100% is reachable without knowing a piece's origin.
   */
  percent: number;
  /** True when nothing REQUIRED is missing — the product can be published. */
  publishable: boolean;
}

export function assessProductInfo(input: InfoInput): InfoAssessment {
  const items: InfoItem[] = [];
  for (const key of INFO_KEYS) {
    const level = fieldLevel(key, input.profile);
    if (level === "na" || !applies(key, input)) continue;
    items.push({
      key,
      label: fieldLabel(key, input.profile),
      group: fieldGroup(key),
      level,
      done: isFilled(key, input),
    });
  }
  const required = items.filter((i) => i.level === "required");
  const recommended = items.filter((i) => i.level === "recommended");
  const optional = items.filter((i) => i.level === "optional");
  const counted = [...required, ...recommended];
  const done = counted.filter((i) => i.done).length;
  const missingRequired = required.filter((i) => !i.done).map((i) => i.label);
  return {
    profile: input.profile,
    items,
    required,
    recommended,
    optional,
    missingRequired,
    missingRecommended: recommended.filter((i) => !i.done).map((i) => i.label),
    percent: counted.length ? Math.round((done / counted.length) * 100) : 100,
    publishable: missingRequired.length === 0,
  };
}

/**
 * The fields the DATABASE refuses to publish without (0065
 * product_info_missing), in its order and with its labels. Name, address,
 * price, category and photographs have their own older checks and messages, so
 * they are not repeated here. Empty for a hidden product.
 */
export const DB_ENFORCED: InfoKey[] = ["fabric", "colour", "care", "cover_alt"];

export function publishBlockers(input: InfoInput): string[] {
  if (input.isActive === false) return [];
  return DB_ENFORCED.filter(
    (key) =>
      fieldLevel(key, input.profile) === "required" && applies(key, input) && !isFilled(key, input)
  ).map((key) => fieldLabel(key, input.profile));
}

/** The sentence the database raises (product_info_message) — same words, same bullets. */
export function publishBlockedMessage(name: string, missing: string[]): string {
  const who = name.trim() || "this product";
  return `Complete these before publishing “${who}”:\n• ${missing.join("\n• ")}`;
}

// ── Alt text ──────────────────────────────────────────────────────────────

/**
 * Advice on one photo's alt text, or null when there is nothing to say. Never
 * blocks, never rewrites: alt text is for someone who cannot see the photo, so
 * the admin is told what makes it useless, not handed a keyword formula.
 */
export function altTextAdvice(
  alt: string,
  { productName, others }: { productName: string; others: string[] }
): string | null {
  const t = alt.trim();
  if (!t) return null;
  if (/\.(jpe?g|png|webp|avif|gif|heic)$/i.test(t) || /^(img|dsc|pxl|photo)[-_ ]?\d+/i.test(t)) {
    return "This looks like a file name. Describe what the photo shows instead.";
  }
  if (others.some((o) => o.trim().toLowerCase() === t.toLowerCase())) {
    return "Another photo has the same text. Say what is different about this one — the border, the pallu, the back.";
  }
  if (t.toLowerCase() === productName.trim().toLowerCase() && productName.trim()) {
    return "Just the product name. Add what the photo shows — draped, folded, a close-up of the weave.";
  }
  return null;
}

export const ALT_TEXT_MAX = 250;
export const SEO_TITLE_MAX = 70;
export const META_DESCRIPTION_LIMIT = 160;

/** Limits that mirror 0065's CHECK constraints, so the form refuses first. */
export const FACT_MAX: Record<"dimensions" | "fit_note" | "finish" | "weave" | "origin", number> = {
  dimensions: 200,
  fit_note: 600,
  finish: 120,
  weave: 120,
  origin: 120,
};

export const BLOUSE_PIECE_LABEL: Record<"included" | "not_included", string> = {
  included: "Included",
  not_included: "Not included",
};

// ── What the product page states ──────────────────────────────────────────

/**
 * A value somebody typed to fill the box rather than to state a fact — "Unknown",
 * "N/A", a dash. Blank already means unknown (0065 refuses an empty string), so
 * these say nothing a customer can use and must not be printed or marked up as
 * if they were the cloth's own details. Whole-value matches only: "Not included"
 * is a real blouse-piece answer and "Natural dye" is a real finish.
 */
const PLACEHOLDER_FACT = /^(?:unknown|not known|n\/?a|na|tbd|tbc|null|undefined|none|nil|[-–—?.\s]+)$/i;

export function isPlaceholderFact(value: string): boolean {
  return PLACEHOLDER_FACT.test(value.trim());
}

export interface FactSource {
  profile: ProductProfile;
  fabric: string | null | undefined;
  dimensions: string | null | undefined;
  blousePiece: "included" | "not_included" | null | undefined;
  fit: string | null | undefined;
  finish: string | null | undefined;
  weave: string | null | undefined;
  origin: string | null | undefined;
}

export interface FactRow {
  key: "fabric" | "weave" | "finish" | "dimensions" | "blouse_piece" | "fit" | "origin";
  label: string;
  value: string;
}

/**
 * The labelled facts a product page prints, in order — only the ones stored,
 * and only the ones that apply to this product's type. ONE LIST FOR THE PAGE
 * AND THE MARKUP: ProductDetail renders these rows and productNode() turns the
 * same rows into additionalProperty, so structured data can never state a fact
 * the customer cannot see, and never an empty one.
 */
export function productFactRows(src: FactSource): FactRow[] {
  const rows: FactRow[] = [];
  const add = (key: FactRow["key"], infoKey: InfoKey, value: string | null | undefined) => {
    const v = value?.trim();
    if (!v || isPlaceholderFact(v) || fieldLevel(infoKey, src.profile) === "na") return;
    rows.push({ key, label: fieldLabel(infoKey, src.profile), value: v });
  };
  add("fabric", "fabric", src.fabric);
  add("weave", "weave", src.weave);
  add("finish", "finish", src.finish);
  add("dimensions", "dimensions", src.dimensions);
  add("blouse_piece", "blouse_piece", src.blousePiece ? BLOUSE_PIECE_LABEL[src.blousePiece] : null);
  add("fit", "fit", src.fit);
  add("origin", "origin", src.origin);
  return rows;
}
