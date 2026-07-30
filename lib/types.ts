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
  category_id: string | null;
  // Derived from the joined categories row (name/slug) — not stored on products.
  // Kept so display code can show the category name without a second lookup.
  category: string | null;
  category_slug: string | null;
  fabric: string | null;
  colour: string | null;
  stock_quantity: number;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
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

export interface SiteContentMap {
  home_hero: HomeHeroContent;
  why_linen: WhyLinenContent;
  brand_story: BrandStoryContent;
}
