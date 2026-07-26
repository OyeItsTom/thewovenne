export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_inr: number;
  category: string | null;
  fabric: string | null;
  colour: string | null;
  stock_quantity: number;
  image_url: string | null;
  is_active: boolean;
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
