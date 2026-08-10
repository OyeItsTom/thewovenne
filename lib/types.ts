// A catalogue category. Two levels: parents (Men/Women, parent_id = null) and
// sub-categories (Sarees, Shirts…, parent_id = the parent's id).
export interface Category {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  is_visible: boolean;
  sort_order: number;
  created_at: string;
}

// A visible parent with its visible children — used to render shop nav/filters.
export interface CategoryNode extends Category {
  children: Category[];
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_inr: number;
  /**
   * What this piece costs US, today. Null means it has never been costed —
   * distinct from zero, which would claim it is free to make. The P&L reads a
   * null line as full margin and flags it; see migration 0038.
   *
   * OPTIONAL BECAUSE THE STOREFRONT MUST NOT HAVE IT. PRODUCT_SELECT does not
   * fetch it, so a product on a customer-facing page genuinely has no cost
   * attached — what it costs us is nobody's business but ours, and a field
   * that is merely hidden in the UI still ships in the page payload. Only the
   * admin queries ask for it.
   */
  cost_price_inr?: number | null;
  /** Stable identifier for spreadsheets and bulk import. Admin-only, like cost. */
  sku?: string | null;
  /**
   * YouTube video ID for the official product video. Unlike cost and sku this
   * IS customer-facing — the product page renders it — so it is fetched by the
   * storefront query too.
   */
  video_youtube_id?: string | null;
  /**
   * Brand knowledge — heritage, craft and care, written by hand (migration
   * 0051). Customer-facing, but NOT on the storefront listing query: three
   * paragraphs per product on every category page, for text only the product
   * page and the concierge read, is weight those routes were deliberately
   * stripped of. The admin editor fetches them; the product page and Ask Wovenne
   * read them through getBrandKnowledge, one piece at a time.
   */
  heritage_note?: string | null;
  craft_note?: string | null;
  care_note?: string | null;
  category_id: string | null;
  // Derived from the joined categories row (name/slug) — not stored on products.
  // Kept so display code can show the category name without a second lookup.
  category: string | null;
  category_slug: string | null;
  /** Slug of the category's PARENT, so a product URL can be built without a
      second lookup. Null when the category has no published parent. */
  category_parent_slug: string | null;
  fabric: string | null;
  colour: string | null;
  stock_quantity: number;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  /** Seasonal collection slug, e.g. "onam-edit". Null when not in a campaign. */
  collection: string | null;
  discount_type: "percent" | "flat" | null;
  discount_value: number | null;
  discount_starts_at: string | null;
  discount_ends_at: string | null;
  /**
   * Every photograph a card may show, cover first, de-duplicated. Derived by
   * mapProduct from the embedded gallery — never stored, and never wider than
   * the gallery the storefront already fetches. One entry (or none) means a card
   * shows no image navigation at all.
   */
  images?: string[];
}

/**
 * A photo in a product's gallery. products.image_url stays in sync with the
 * lowest sort_order (the cover) so listings, cart and chat keep working from
 * one column without joining this table.
 */
export interface ProductImage {
  id: string;
  product_id: string;
  url: string;
  sort_order: number;
  created_at: string;
}

/**
 * One recorded admin action. Written by the log_admin_action() trigger, never
 * by the app — see supabase/migrations/0009.
 */
export interface AuditEntry {
  id: string;
  actor_id: string | null;
  /** Kept even if the auth user is later deleted. */
  actor_email: string | null;
  action: "insert" | "update" | "delete";
  table_name: string;
  record_id: string | null;
  /** name/title/key as it was, so deleted records still read sensibly. */
  record_label: string | null;
  /** update: { column: { from, to } } · insert/delete: the whole row. */
  changes: Record<string, unknown> | null;
  created_at: string;
}

export interface OrderItem {
  id: string;
  name: string;
  price_inr: number;
  quantity: number;
  size: string;
}

export interface Order {
  id: string;
  customer_email: string | null;
  total_inr: number;
  // TODO(payments): add "paypal" here when re-introducing UK checkout.
  payment_provider: "razorpay" | null;
  payment_status: string;
  tracking_status: string | null;
  items: OrderItem[];
  created_at: string;
}

export interface JournalPost {
  id: string;
  title: string;
  slug: string;
  body: string | null;
  image_url: string | null;
  published: boolean;
  created_at: string;
}

// Editable homepage content (site_content table, keyed JSON).
export interface HomeHeroContent {
  eyebrow: string;
  heading: string;
  subheading: string;
  cta_label: string;
  cta_href: string;
}

export interface WhyLinenContent {
  title: string;
  cards: { title: string; text: string }[];
}

export interface BrandStoryContent {
  title: string;
  body: string;
}

/**
 * The homepage seasonal section. `enabled` is the off switch — when false the
 * section is not rendered at all, which is how the site sits outside a campaign.
 */
export interface SeasonalEditContent {
  enabled: boolean;
  eyebrow: string;
  heading: string;
  body: string;
  /**
   * The desktop image. Kept as `image_url` rather than renamed to
   * `image_url_desktop` so every campaign already saved keeps its picture —
   * a rename would need a data migration and could silently blank one.
   */
  image_url: string;
  /** Portrait crop for narrow screens. Falls back to image_url when empty. */
  image_url_mobile: string;
  /**
   * How the image meets the band.
   *
   * "cover" fills it edge to edge and crops whatever does not fit — right for a
   * photograph, where losing an edge costs nothing.
   *
   * "contain" shows the whole image and lets the band's colour show around it —
   * right for an illustration or anything with text in it, where a cropped edge
   * destroys the thing itself.
   *
   * The two cannot be reconciled: filling a band whose shape differs from the
   * image means cropping, by definition. So it is a choice, not a default.
   */
  image_fit: "cover" | "contain";
  link_label: string;
  link_href: string;
}

/**
 * One full-bleed lookbook block on the homepage.
 *
 * Desktop and mobile images are separate for the same reason the seasonal band
 * keeps them apart: a landscape crop on a phone is a letterbox strip, and a
 * portrait crop on a laptop is a column with two empty sides. Mobile falls
 * back to the desktop image when left blank, so one upload still works.
 */
export interface LookbookImage {
  /** Desktop / wide. Empty means this slot renders nothing. */
  image_url: string;
  /** Portrait crop for narrow screens. Falls back to image_url when empty. */
  image_url_mobile: string;
  /** Where the image goes when tapped. Empty leaves it unclickable. */
  href: string;
  /** Describes the picture for screen readers. Empty marks it decorative. */
  alt: string;
}

export type LookbookLayout = "single" | "split-2" | "split-3";

export interface LookbookSection {
  /** Stable across reorders, so React keys and edits do not chase positions. */
  id: string;
  /** Off by default — a section with no image should never reach the site. */
  enabled: boolean;
  layout: LookbookLayout;
  /** One entry for "single", two for "split-2", three for "split-3". */
  images: LookbookImage[];
}

export interface LookbookContent {
  sections: LookbookSection[];
}

export interface SiteContentMap {
  home_hero: HomeHeroContent;
  why_linen: WhyLinenContent;
  brand_story: BrandStoryContent;
  seasonal_edit: SeasonalEditContent;
  lookbook: LookbookContent;
}
