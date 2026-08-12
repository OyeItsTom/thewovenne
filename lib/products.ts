import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { getAllCategories, getVisibleCategoryIds } from "./categories";
import { ANON_CTX, preferDraft, statesFor, type ReadCtx } from "./readCtx";
import type { Category, Product } from "./types";

// Storefront reads come from PUBLISHED versions, never the identity tables.
// RLS only exposes state = 'published' to anon, so a mistake here cannot leak
// draft work — the policy is the guarantee, this is just the query.
export const PRODUCT_SELECT =
  "product_id, name, slug, description, price_inr, category_id, fabric, colour, " +
  "stock_quantity, image_url, is_active, created_at, collection, " +
  // Customer-facing, unlike cost and sku: the product page renders it.
  "video_youtube_id, " +
  "discount_type, discount_value, discount_starts_at, discount_ends_at, " +
  // The gallery, embedded rather than fetched per card. Two URLs — the cover and
  // the one a card cross-fades to — are two short strings; the IMAGE BYTES are
  // the expensive part and none are fetched here. Reading it in the listing
  // query is what lets the card decide on hover without a round trip of its own.
  //
  // Embedded through product_images.product_version_id, so it is this version's
  // gallery: a draft's photos stay with the draft.
  "product_images(url, sort_order)";

/**
 * Base query for every storefront listing.
 *
 * In preview it also pulls draft rows (and the columns needed to collapse
 * them), so an admin sees the site as publishing would leave it. Normally it is
 * exactly the published-only query it always was.
 */
function storefrontQuery(ctx: ReadCtx) {
  return ctx.client
    .from("product_versions")
    .select(
      ctx.preview ? `${PRODUCT_SELECT}, state, pending_delete` : PRODUCT_SELECT
    )
    .in("state", statesFor(ctx));
}

/** Collapse to one row per product and map. A no-op outside preview. */
function finish(data: unknown, cats: Map<string, Category>): Product[] {
  const rows = (data as (ProductVersionRow & {
    state?: string;
    pending_delete?: boolean;
  })[] | null) ?? [];
  return preferDraft(rows, (r) => r.product_id).map((r) => mapProduct(r, cats));
}

export type ProductVersionRow = {
  product_id: string;
  name: string;
  slug: string;
  description: string | null;
  price_inr: number;
  category_id: string | null;
  fabric: string | null;
  colour: string | null;
  stock_quantity: number;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  collection: string | null;
  discount_type: "percent" | "flat" | null;
  discount_value: number | null;
  discount_starts_at: string | null;
  discount_ends_at: string | null;
  video_youtube_id: string | null;
  /** Embedded gallery. Absent on queries that do not ask for it. */
  product_images?: { url: string | null; sort_order: number | null }[] | null;
};

/**
 * Flatten a version row to the Product shape callers expect: the stable
 * product id, plus the category NAME resolved from the published category
 * versions rather than joined.
 *
 * Resolved from a map rather than a PostgREST embed because the name lives on
 * category_versions, not the categories identity row — embedding would give
 * whatever the identity table happens to hold.
 */
export function mapProduct(row: ProductVersionRow, categories: Map<string, Category>): Product {
  const category = row.category_id ? categories.get(row.category_id) : undefined;
  return {
    id: row.product_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    price_inr: row.price_inr,
    category_id: row.category_id,
    fabric: row.fabric,
    colour: row.colour,
    stock_quantity: row.stock_quantity,
    image_url: row.image_url,
    is_active: row.is_active,
    created_at: row.created_at,
    category: category?.name ?? null,
    category_slug: category?.slug ?? null,
    category_parent_slug:
      (category?.parent_id ? categories.get(category.parent_id)?.slug : null) ??
      null,
    collection: row.collection,
    discount_type: row.discount_type,
    discount_value: row.discount_value,
    discount_starts_at: row.discount_starts_at,
    discount_ends_at: row.discount_ends_at,
    // Added in the fix for #94: PRODUCT_SELECT fetched this and mapProduct
    // dropped it, so the product page saw undefined and rendered nothing.
    //
    // THIS MAPPER IS AN ALLOW-LIST. A column reaching the storefront has to be
    // named in three places — PRODUCT_SELECT, ProductVersionRow, and here — and
    // missing the third is silent, because Product's customer-facing optional
    // fields make an absent one type-check perfectly. scripts/product-mapping.test.ts
    // now fails if any of the three disagree.
    video_youtube_id: row.video_youtube_id ?? null,
    images: galleryImages(row.product_images, row.image_url),
  };
}

/**
 * A product's photographs, in the order a card should offer them.
 *
 * REPLACES pickHoverImage (#108), which returned a single "other angle" because
 * the card only ever showed two. A card now steps through the whole set, so it
 * needs the whole set — from the SAME embed that was already being fetched. No
 * new columns, nothing added to the storefront payload beyond what was already
 * there.
 *
 * THE COVER LEADS, whatever the gallery says. image_url is what every other
 * surface shows — the cart, chat, an order line — and a card that opens on a
 * different photograph than the one the customer clicked from is disorienting.
 * It is also de-duplicated against the gallery, because the cover is normally
 * the lowest sort_order and would otherwise appear twice.
 *
 * Empty in, empty out: a product with no photographs returns [], and a card with
 * fewer than two entries shows no navigation at all.
 */
export function galleryImages(
  images: { url: string | null; sort_order: number | null }[] | null | undefined,
  cover: string | null
): string[] {
  const ordered = [...(images ?? [])]
    .filter((i): i is { url: string; sort_order: number | null } => typeof i.url === "string" && i.url.length > 0)
    // Nulls last, so a row saved without an order cannot jump to the front of a
    // deliberately arranged gallery.
    .sort((a, b) => (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER))
    .map((i) => i.url);

  const all = cover ? [cover, ...ordered] : ordered;
  // Same URL twice would be an arrow that appears to do nothing.
  return all.filter((url, i) => all.indexOf(url) === i);
}

/**
 * Columns the ADMIN asks for and the storefront never does.
 *
 * Named once, here, because the select string and the mapper below have to agree
 * and there is no type that makes them — see mapAdminProduct.
 */
export const ADMIN_ONLY_SELECT =
  "cost_price_inr, sku, heritage_note, craft_note, care_note";

export type AdminProductRow = ProductVersionRow & {
  state: string;
  pending_delete: boolean;
  cost_price_inr: number | null;
  sku: string | null;
  heritage_note: string | null;
  craft_note: string | null;
  care_note: string | null;
};

/**
 * A product for an admin screen: everything the storefront sees, plus the
 * columns only we see.
 *
 * THIS EXISTS BECAUSE mapProduct SILENTLY DROPPED THEM. getAdminProducts fetched
 * cost_price_inr and sku, mapProduct built its result field by field and never
 * copied either, and Product declares both optional so nothing type-checked
 * wrong. The cost price therefore loaded as undefined into the product editor,
 * showed as an empty box, and — because the form writes what it shows — SAVED
 * BACK AS NULL. Opening a product to fix a typo in its description silently
 * un-costed it, and the P&L would then read that piece as pure margin.
 *
 * Kept OUT of mapProduct rather than added to it: that mapper is the storefront
 * allow-list, and what a piece costs us must not ride a public page payload
 * even as a null. Two mappers, one of which is allowed to know more.
 */
export function mapAdminProduct(
  row: AdminProductRow,
  categories: Map<string, Category>
): Product {
  return {
    ...mapProduct(row, categories),
    cost_price_inr: row.cost_price_inr ?? null,
    sku: row.sku ?? null,
    heritage_note: row.heritage_note ?? null,
    craft_note: row.craft_note ?? null,
    care_note: row.care_note ?? null,
  };
}

/** category id -> published category, for resolving display names. */
async function categoryMap(client?: SupabaseClient, ctx?: ReadCtx) {
  const all = await getAllCategories(client, { drafts: ctx?.preview });
  return new Map(all.map((c) => [c.id, c]));
}

/**
 * Every public query below is scoped to categories a shopper may see, so
 * hiding a category hides its products too — not just its filter chip.
 *
 * Note this also excludes products with no category at all: an uncategorised
 * product has not been placed anywhere, so it stays off the storefront until
 * it is filed. Admin queries don't go through this module and are unaffected.
 */
async function scopeToVisible(
  categoryIds: string[] | undefined,
  ctx: ReadCtx
): Promise<string[]> {
  const visible = await getVisibleCategoryIds(ctx);
  if (!categoryIds) return visible;

  const allowed = new Set(visible);
  return categoryIds.filter((id) => allowed.has(id));
}

/**
 * A product's gallery, in order. Returns [] rather than throwing if the
 * product_images table isn't there yet, so the product page falls back to the
 * single image_url instead of the whole route erroring.
 */
export async function getProductImages(
  productId: string,
  client: SupabaseClient = supabase
): Promise<string[]> {
  // Galleries hang off the version, so read the published version's images.
  const { data, error } = await client
    .from("product_images")
    .select("url, product_versions!inner(product_id, state)")
    .eq("product_versions.product_id", productId)
    .eq("product_versions.state", "published")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getProductImages:", error.message);
    return [];
  }
  return (data ?? []).map((row) => row.url as string);
}

/**
 * Every product, including inactive ones and those in hidden categories, with
 * category names resolved. For the admin table only — deliberately skips the
 * visibility scoping above, since the whole point of the dashboard is to see
 * and manage what the storefront hides. RLS still gates it: the "Admins can
 * view all products" policy requires is_admin().
 */
export async function getAdminProducts(
  client: SupabaseClient = supabase
): Promise<Product[]> {
  const cats = await categoryMap(client);
  const { data, error } = await client
    .from("product_versions")
    .select(`${PRODUCT_SELECT}, state, pending_delete, ${ADMIN_ONLY_SELECT}`)
    .in("state", ["published", "draft"])
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getAdminProducts:", error.message);
    return [];
  }

  // A draft supersedes the published version of the same product, so the admin
  // always sees what it will look like once published.
  const rows = (data as unknown as AdminProductRow[]) ?? [];
  const byProduct = new Map<string, AdminProductRow>();
  for (const row of rows) {
    const seen = byProduct.get(row.product_id);
    if (!seen || row.state === "draft") byProduct.set(row.product_id, row);
  }

  // A product whose only draft deletes it is still live, so it stays listed —
  // marked, not hidden. Hiding it would make the pending deletion invisible.
  return [...byProduct.values()].map((r) => mapAdminProduct(r, cats));
}

/** Product ids with unpublished changes — for "not yet live" markers. */
export async function getDraftProductIds(
  client: SupabaseClient = supabase
): Promise<Set<string>> {
  const { data } = await client
    .from("product_versions")
    .select("product_id")
    .eq("state", "draft");
  return new Set((data ?? []).map((r) => r.product_id as string));
}

/**
 * The draft version's gallery, for the admin editor. Falls back to the
 * published gallery when no draft exists yet.
 */
export async function getDraftProductImages(
  productId: string,
  client: SupabaseClient = supabase
): Promise<string[]> {
  const { data, error } = await client
    .from("product_images")
    .select("url, sort_order, product_versions!inner(product_id, state)")
    .eq("product_versions.product_id", productId)
    .in("product_versions.state", ["draft", "published"])
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getDraftProductImages:", error.message);
    return [];
  }
  const rows = (data ?? []) as unknown as {
    url: string;
    product_versions: { state: string };
  }[];
  const draft = rows.filter((r) => r.product_versions.state === "draft");
  return (draft.length ? draft : rows).map((r) => r.url);
}

export async function getFeaturedProducts(
  limit = 4,
  ctx: ReadCtx = ANON_CTX
): Promise<Product[]> {
  const [visibleIds, cats] = await Promise.all([scopeToVisible(undefined, ctx), categoryMap(ctx.client, ctx)]);
  if (visibleIds.length === 0) return [];

  const { data, error } = await storefrontQuery(ctx)
    .eq("is_active", true)
    .in("category_id", visibleIds)
    // NO STOCK FILTER, deliberately. This was the one query on the storefront
    // that hid a sold-out piece; every category and search path already showed
    // them. A piece that sold out is the best evidence the shop has that people
    // buy here — it keeps its photographs and its reviews, and says "sold out"
    // rather than vanishing and taking its social proof with it.
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getFeaturedProducts:", error.message);
    return [];
  }
  return finish(data, cats);
}

export async function getAllProducts(ctx: ReadCtx = ANON_CTX): Promise<Product[]> {
  const [visibleIds, cats] = await Promise.all([scopeToVisible(undefined, ctx), categoryMap(ctx.client, ctx)]);
  if (visibleIds.length === 0) return [];

  const { data, error } = await storefrontQuery(ctx)
    .eq("is_active", true)
    .in("category_id", visibleIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getAllProducts:", error.message);
    return [];
  }
  return finish(data, cats);
}

/**
 * The catalogue, filtered by the database rather than by the browser.
 *
 * WHAT THIS REPLACES. getAllProducts() returned every product, and the shop page
 * handed the whole array to a client component to filter in memory. Measured on
 * the live site that was 1,052 characters of serialised product per row — 41 KB
 * at forty products, 411 KB at four hundred, sent to a phone so it could hide
 * most of it again.
 *
 * SCOPING IS UNCHANGED AND MUST STAY THAT WAY. Every path still goes through
 * scopeToVisible(), so hiding a category in admin still removes its products
 * everywhere. Filtering narrows within that set; it can never widen it.
 *
 * SIZE NEEDS A SECOND QUERY, and only pays for one when it is used. product_sizes
 * is a separate table, so a size filter first asks which products still have
 * stock in that label and then constrains on the answer. No size filter, no
 * extra round trip.
 *
 * `limit` and `offset` are accepted but unused by callers today. They are here
 * so paging becomes a caller change rather than a rewrite of this function.
 */
export interface CatalogueFilterInput {
  /** Sub-category slug. Resolved to an id here, so callers pass what the URL has. */
  category?: string | null;
  fabric?: string | null;
  colour?: string | null;
  size?: string | null;
  maxPrice?: number | null;
}

export async function getCatalogue(
  filters: CatalogueFilterInput = {},
  opts: { limit?: number; offset?: number } = {},
  ctx: ReadCtx = ANON_CTX
): Promise<{ products: Product[]; total: number }> {
  const [visibleIds, cats] = await Promise.all([
    scopeToVisible(undefined, ctx),
    categoryMap(ctx.client, ctx),
  ]);
  if (visibleIds.length === 0) return { products: [], total: 0 };

  // A category slug narrows the visible set. An unrecognised slug narrows it to
  // nothing, which is the honest answer — better an empty listing than silently
  // ignoring half the URL and showing everything.
  let scopedIds = visibleIds;
  if (filters.category) {
    const match = [...cats.values()].find((c) => c.slug === filters.category);
    scopedIds = match && visibleIds.includes(match.id) ? [match.id] : [];
    if (scopedIds.length === 0) return { products: [], total: 0 };
  }

  // Only products with stock in the chosen size. Done first so the main query
  // can constrain on ids rather than filtering after the fact.
  let sizeScopedProductIds: string[] | null = null;
  if (filters.size) {
    const { data: sizeRows, error: sizeError } = await ctx.client
      .from("product_sizes")
      .select("product_id")
      .eq("label", filters.size)
      .gt("stock_quantity", 0);

    if (sizeError) {
      console.error("getCatalogue sizes:", sizeError.message);
      return { products: [], total: 0 };
    }
    sizeScopedProductIds = [
      ...new Set((sizeRows ?? []).map((r) => (r as { product_id: string }).product_id)),
    ];
    if (sizeScopedProductIds.length === 0) return { products: [], total: 0 };
  }

  let query = storefrontQuery(ctx)
    .eq("is_active", true)
    .in("category_id", scopedIds);

  // ilike rather than eq: the columns are free text and the values in them are
  // inconsistently cased. This matches how the facet list is built, so a chip
  // the customer can see always selects the products it was derived from.
  if (filters.fabric) query = query.ilike("fabric", filters.fabric);
  if (filters.colour) query = query.ilike("colour", filters.colour);
  if (filters.maxPrice !== null && filters.maxPrice !== undefined) {
    query = query.lte("price_inr", filters.maxPrice);
  }
  if (sizeScopedProductIds) query = query.in("product_id", sizeScopedProductIds);

  query = query.order("created_at", { ascending: false });
  if (opts.limit !== undefined) {
    const from = opts.offset ?? 0;
    query = query.range(from, from + opts.limit - 1);
  }

  const { data, error } = await query;
  if (error) {
    console.error("getCatalogue:", error.message);
    return { products: [], total: 0 };
  }

  const products = finish(data, cats);
  // Without paging the row count IS the total. When paging arrives this becomes
  // a count query; the shape of the return value already allows for it.
  return { products, total: products.length };
}

/**
 * The values worth offering as filters, across the whole visible catalogue.
 *
 * A SEPARATE, DELIBERATELY THIN QUERY. The chips must describe the entire
 * catalogue, not merely the page being shown — otherwise filtering down to one
 * product would leave one chip and no way back. Reading two short text columns
 * for every product is a fraction of reading every product: no description, no
 * gallery, no prices, no discount window.
 *
 * Values are returned as stored. Normalising them is separate work; this is the
 * query, not the vocabulary.
 */
export async function getCatalogueFacetValues(
  ctx: ReadCtx = ANON_CTX
): Promise<{ fabrics: string[]; colours: string[] }> {
  const visibleIds = await scopeToVisible(undefined, ctx);
  if (visibleIds.length === 0) return { fabrics: [], colours: [] };

  const { data, error } = await ctx.client
    .from("product_versions")
    .select("fabric, colour")
    .in("state", statesFor(ctx))
    .eq("is_active", true)
    .in("category_id", visibleIds);

  if (error) {
    console.error("getCatalogueFacetValues:", error.message);
    return { fabrics: [], colours: [] };
  }

  const rows = (data ?? []) as { fabric: string | null; colour: string | null }[];
  const pick = (get: (r: (typeof rows)[number]) => string | null) => {
    // Keyed case-insensitively so "gold" and "Gold" are one chip, shown with the
    // first spelling seen. Genuinely different fabrics stay separate — this only
    // collapses values that differ by case or surrounding space.
    const seen = new Map<string, string>();
    for (const row of rows) {
      const value = get(row)?.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (!seen.has(key)) seen.set(key, value);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  };

  return { fabrics: pick((r) => r.fabric), colours: pick((r) => r.colour) };
}

/**
 * Products in a seasonal collection, e.g. "onam-edit".
 *
 * Goes through scopeToVisible like every other listing, so putting a product
 * from a hidden category into a campaign does not become a way around the
 * visibility rules.
 */
export async function getProductsByCollection(
  collection: string,
  ctx: ReadCtx = ANON_CTX
): Promise<Product[]> {
  const [visibleIds, cats] = await Promise.all([scopeToVisible(undefined, ctx), categoryMap(ctx.client, ctx)]);
  if (visibleIds.length === 0) return [];

  const { data, error } = await storefrontQuery(ctx)
    .eq("is_active", true)
    .eq("collection", collection)
    .in("category_id", visibleIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getProductsByCollection:", error.message);
    return [];
  }
  return finish(data, cats);
}

/**
 * Published products by identity id, for the wishlist.
 *
 * Scoped like every other listing, so a saved item whose category was later
 * hidden stops appearing — a wishlist should not be a back door to products
 * that have been taken off the site.
 */
export async function getProductsByIds(
  ids: string[],
  ctx: ReadCtx = ANON_CTX
): Promise<Product[]> {
  if (ids.length === 0) return [];
  const [visibleIds, cats] = await Promise.all([
    scopeToVisible(undefined, ctx),
    categoryMap(ctx.client, ctx),
  ]);
  if (visibleIds.length === 0) return [];

  const { data, error } = await storefrontQuery(ctx)
    .eq("is_active", true)
    .in("product_id", ids)
    .in("category_id", visibleIds);

  if (error) {
    console.error("getProductsByIds:", error.message);
    return [];
  }
  return finish(data, cats);
}

/**
 * Distinct published collection slugs, for generateStaticParams. Deliberately
 * published-only: this runs at build time, where preview does not apply, and a
 * draft collection reaches its page through dynamicParams anyway.
 */
export async function getCollectionSlugs(): Promise<string[]> {
  const { data, error } = await supabase
    .from("product_versions")
    .select("collection")
    .eq("state", "published")
    .eq("is_active", true)
    .not("collection", "is", null);

  if (error) {
    console.error("getCollectionSlugs:", error.message);
    return [];
  }
  return [
    ...new Set(
      (data ?? [])
        .map((r) => (r as { collection: string | null }).collection)
        .filter((c): c is string => !!c)
    ),
  ];
}

/**
 * Active products across a set of categories — used by the /men and /women
 * landing pages, which pass in their visible sub-category ids.
 */
export async function getProductsByCategoryIds(
  categoryIds: string[],
  ctx: ReadCtx = ANON_CTX
): Promise<Product[]> {
  if (categoryIds.length === 0) return [];

  const [scoped, cats] = await Promise.all([scopeToVisible(categoryIds, ctx), categoryMap(ctx.client, ctx)]);
  if (scoped.length === 0) return [];

  const { data, error } = await storefrontQuery(ctx)
    .eq("is_active", true)
    .in("category_id", scoped)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getProductsByCategoryIds:", error.message);
    return [];
  }
  return finish(data, cats);
}

export async function getProductBySlug(
  slug: string,
  ctx: ReadCtx = ANON_CTX
): Promise<Product | null> {
  const [visibleIds, cats] = await Promise.all([scopeToVisible(undefined, ctx), categoryMap(ctx.client, ctx)]);
  if (visibleIds.length === 0) return null;

  const { data, error } = await storefrontQuery(ctx)
    .eq("slug", slug)
    .eq("is_active", true)
    .in("category_id", visibleIds);

  if (error) {
    console.error("getProductBySlug:", error.message);
    return null;
  }
  // Not maybeSingle(): in preview a product with a draft matches twice, and
  // maybeSingle errors on more than one row.
  return finish(data, cats)[0] ?? null;
}

/**
 * What we know about a piece beyond what sells it: where it comes from, how it
 * was made, how to look after it. Migration 0051.
 */
export interface BrandKnowledge {
  productId: string;
  name: string;
  slug: string;
  heritage: string | null;
  craft: string | null;
  care: string | null;
}

/** The three columns, named once. Deliberately NOT part of PRODUCT_SELECT. */
export const BRAND_KNOWLEDGE_SELECT =
  "product_id, name, slug, heritage_note, craft_note, care_note";

export type BrandKnowledgeRow = {
  product_id: string;
  name: string;
  slug: string;
  heritage_note: string | null;
  craft_note: string | null;
  care_note: string | null;
};

export function mapBrandKnowledge(row: BrandKnowledgeRow): BrandKnowledge {
  return {
    productId: row.product_id,
    name: row.name,
    slug: row.slug,
    heritage: row.heritage_note,
    craft: row.craft_note,
    care: row.care_note,
  };
}

/** True when nobody has written anything up yet — worth saying out loud. */
export function hasBrandKnowledge(k: BrandKnowledge | null): boolean {
  return Boolean(k && (k.heritage || k.craft || k.care));
}

/**
 * Brand knowledge for one product, by slug or by stable product id.
 *
 * A QUERY OF ITS OWN, AND NOT IN PRODUCT_SELECT. Three paragraphs per product,
 * on every listing payload, for text that only the product page and the
 * concierge read, is exactly the weight #73–#76 spent four PRs taking off the
 * category routes. The product page fetches it once, for the one piece it is
 * showing; the concierge fetches it for the one piece it was asked about.
 *
 * Scoped to visible categories like every other public read here, so a hidden
 * piece has no heritage the concierge can quote either.
 *
 * Returns null when the product does not exist or cannot be seen — distinct from
 * a product that exists and has nothing written, which returns a row of nulls.
 * The caller needs to tell those apart to answer honestly.
 */
export async function getBrandKnowledge(
  ref: { slug?: string; productId?: string },
  ctx: ReadCtx = ANON_CTX
): Promise<BrandKnowledge | null> {
  if (!ref.slug && !ref.productId) return null;

  const visibleIds = await scopeToVisible(undefined, ctx);
  if (visibleIds.length === 0) return null;

  let query = ctx.client
    .from("product_versions")
    .select(ctx.preview ? `${BRAND_KNOWLEDGE_SELECT}, state` : BRAND_KNOWLEDGE_SELECT)
    .in("state", statesFor(ctx))
    .eq("is_active", true)
    .in("category_id", visibleIds);

  query = ref.slug ? query.eq("slug", ref.slug) : query.eq("product_id", ref.productId!);

  const { data, error } = await query;
  if (error) {
    console.error("getBrandKnowledge:", error.message);
    return null;
  }

  // Same reason getProductBySlug avoids maybeSingle: in preview a product with
  // a draft matches twice, and the draft is the one to show.
  const rows = (data as unknown as (BrandKnowledgeRow & { state?: string })[]) ?? [];
  const row = preferDraft(rows, (r) => r.product_id)[0];
  return row ? mapBrandKnowledge(row) : null;
}

/**
 * Every piece that has been written up, for searching across them.
 *
 * Products with nothing written are dropped here rather than by the caller: a
 * search over empty fields can only return noise, and "which pieces are kasavu"
 * should not match a product whose notes are blank.
 */
export async function getAllBrandKnowledge(
  ctx: ReadCtx = ANON_CTX
): Promise<BrandKnowledge[]> {
  const visibleIds = await scopeToVisible(undefined, ctx);
  if (visibleIds.length === 0) return [];

  const { data, error } = await ctx.client
    .from("product_versions")
    .select(ctx.preview ? `${BRAND_KNOWLEDGE_SELECT}, state` : BRAND_KNOWLEDGE_SELECT)
    .in("state", statesFor(ctx))
    .eq("is_active", true)
    .in("category_id", visibleIds);

  if (error) {
    console.error("getAllBrandKnowledge:", error.message);
    return [];
  }

  const rows = (data as unknown as (BrandKnowledgeRow & { state?: string })[]) ?? [];
  return preferDraft(rows, (r) => r.product_id)
    .map(mapBrandKnowledge)
    .filter((k) => hasBrandKnowledge(k));
}

export async function getRelatedProducts(
  categoryId: string | null,
  excludeSlug: string,
  limit = 4,
  ctx: ReadCtx = ANON_CTX
): Promise<Product[]> {
  if (!categoryId) return [];

  const [scoped, cats] = await Promise.all([scopeToVisible([categoryId], ctx), categoryMap(ctx.client, ctx)]);
  if (scoped.length === 0) return [];

  const { data, error } = await storefrontQuery(ctx)
    .eq("is_active", true)
    .eq("category_id", categoryId)
    .neq("slug", excludeSlug)
    .limit(limit);

  if (error) {
    console.error("getRelatedProducts:", error.message);
    return [];
  }
  return finish(data, cats);
}
