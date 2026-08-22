/**
 * Whether a customer can actually see a photograph.
 *
 * WHY THIS EXISTS. Batch 1 of the backfill migrated five photographs and four of
 * them turned out to be invisible on the storefront, which made the visual
 * review it was supposed to enable impossible. The mistake was reasoning about
 * `product_images.product_id` — the product a row belongs to — when the site
 * reasons about `product_images.product_version_id`, the VERSION it belongs to.
 * A catalogue of 34 products carries 68 versions and 262 gallery rows, of which
 * only 137 hang off a published version. Choosing by product is choosing
 * roughly at random between a live photograph and an archived one.
 *
 * So this module answers the question the way lib/products.ts answers it, and
 * nowhere else in the backfill is allowed to guess:
 *
 *   PRODUCT_SELECT reads FROM product_versions, filtered `.in("state",
 *   statesFor(ctx))` — for anonymous visitors that is exactly ["published"] —
 *   and embeds "product_images(url, sort_order)", which PostgREST resolves
 *   through product_images.product_version_id. The cover is that same version
 *   row's `image_url`.
 *
 * Two consequences worth stating plainly, because both cost a batch to learn:
 * `products.image_url` is NOT what the storefront renders — the version's is.
 * And a published version on an inactive product is still not on the shop.
 */

export interface VersionRow {
  id: string;
  product_id: string;
  state: string;
  image_url: string | null;
  name: string | null;
  slug: string | null;
  is_active: boolean | null;
  category_id?: string | null;
}

export interface GalleryRow {
  id: string;
  product_version_id: string | null;
  product_id: string | null;
  url: string | null;
  sort_order: number | null;
}

/** The states a visitor's query admits. Mirrors readCtx.statesFor(ANON_CTX). */
export const PUBLIC_STATES = ["published"] as const;

export interface Visibility {
  publiclyVisible: boolean;
  productName: string | null;
  productSlug: string | null;
  /** Path a person can open, once the category prefix is known. */
  pdpPath: string | null;
  isCover: boolean;
  /** Position within the published version's gallery, 0-based. */
  galleryIndex: number | null;
  publicVersionId: string | null;
  /** Whether a card renders it: the card leads with the first photograph. */
  onProductCard: boolean;
  reason: string;
}

const NOT_VISIBLE = (reason: string): Visibility => ({
  publiclyVisible: false, productName: null, productSlug: null, pdpPath: null,
  isCover: false, galleryIndex: null, publicVersionId: null, onProductCard: false, reason,
});

/** The object key inside the bucket, from any storage URL. */
export function keyOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = "/product-images/";
  const at = url.indexOf(marker);
  if (at < 0) return null;
  return decodeURIComponent(url.slice(at + marker.length).split("?")[0]);
}

/**
 * Resolve visibility for every object, the way the storefront would.
 *
 * Returns a map keyed by storage key. An object absent from the map is not
 * publicly rendered — but callers should read `reason` rather than assume why,
 * because "belongs to an archived version" and "belongs to an inactive product"
 * are different problems.
 */
export function resolveVisibility(
  versions: VersionRow[],
  gallery: GalleryRow[]
): Map<string, Visibility> {
  const publicVersions = new Map<string, VersionRow>();
  for (const version of versions) {
    if (!(PUBLIC_STATES as readonly string[]).includes(version.state)) continue;
    // A published version on a product nobody can reach is still not on the
    // shop. is_active lives on the version row, which is what the listing reads.
    if (version.is_active !== true) continue;
    publicVersions.set(version.id, version);
  }

  // Gallery rows belonging to a public version, ordered as the site orders them.
  const byVersion = new Map<string, GalleryRow[]>();
  for (const row of gallery) {
    if (!row.product_version_id || !publicVersions.has(row.product_version_id)) continue;
    const list = byVersion.get(row.product_version_id) ?? [];
    list.push(row);
    byVersion.set(row.product_version_id, list);
  }
  for (const list of byVersion.values()) {
    list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
  }

  const out = new Map<string, Visibility>();
  const remember = (key: string | null, v: Visibility) => {
    if (!key) return;
    const existing = out.get(key);
    // One object can be both a cover and a gallery entry, and can appear on
    // several products. Keep the strongest claim rather than the last one seen.
    if (!existing || (!existing.onProductCard && v.onProductCard) || (!existing.isCover && v.isCover)) {
      out.set(key, { ...v, isCover: v.isCover || existing?.isCover === true });
    }
  };

  for (const [versionId, version] of publicVersions) {
    const rows = byVersion.get(versionId) ?? [];
    const coverKey = keyOf(version.image_url);
    rows.forEach((row, index) => {
      const key = keyOf(row.url);
      remember(key, {
        publiclyVisible: true,
        productName: version.name,
        productSlug: version.slug,
        pdpPath: version.slug ? `/in/…/${version.slug}` : null,
        isCover: key !== null && key === coverKey,
        galleryIndex: index,
        publicVersionId: versionId,
        onProductCard: index === 0 || (key !== null && key === coverKey),
        reason: "on a published, active version's gallery",
      });
    });
    if (coverKey && !rows.some((r) => keyOf(r.url) === coverKey)) {
      // A cover that is not also a gallery row still renders on the card.
      remember(coverKey, {
        publiclyVisible: true, productName: version.name, productSlug: version.slug,
        pdpPath: version.slug ? `/in/…/${version.slug}` : null,
        isCover: true, galleryIndex: null, publicVersionId: versionId,
        onProductCard: true, reason: "published version cover",
      });
    }
  }
  return out;
}

/** Visibility for one object, with an explanation when it is not visible. */
export function visibilityFor(
  key: string,
  map: Map<string, Visibility>,
  gallery: GalleryRow[],
  versions: VersionRow[]
): Visibility {
  const hit = map.get(key);
  if (hit) return hit;
  const rows = gallery.filter((r) => keyOf(r.url) === key);
  if (rows.length === 0) return NOT_VISIBLE("no gallery row references it");
  const states = new Set<string>();
  let inactive = false;
  for (const row of rows) {
    const version = versions.find((v) => v.id === row.product_version_id);
    if (!version) { states.add("orphaned row"); continue; }
    states.add(version.state);
    if (version.state === "published" && version.is_active !== true) inactive = true;
  }
  if (inactive) return NOT_VISIBLE("published version, but the product is not active");
  return NOT_VISIBLE(`only on ${[...states].join("/")} version(s)`);
}

/**
 * Pick a batch for visual review.
 *
 * PUBLIC VISIBILITY OUTRANKS EVERYTHING. Batch 1 was chosen for orientation
 * coverage and produced four photographs nobody could look at, so the ordering
 * is now: visible first, then the largest saving, and orientation variety only
 * as a tie-break among candidates that are already visible.
 *
 * It will return fewer than `size` rather than reach for a non-public row. A
 * short batch is a thing to report; a batch padded with invisible photographs
 * is a review that cannot be done.
 */
export function selectVisibleBatch<T extends { sourcePath: string; sourceBytes: number; orientation: number | null }>(
  candidates: T[],
  visibility: Map<string, Visibility>,
  size: number
): { batch: T[]; skippedInvisible: number } {
  const visible = candidates.filter((c) => visibility.get(c.sourcePath)?.publiclyVisible === true);
  const skippedInvisible = candidates.length - visible.length;
  const bySaving = [...visible].sort((a, b) => b.sourceBytes - a.sourceBytes);

  const batch: T[] = [];
  const seenOrientation = new Set<number | null>();

  // Reserve one photograph the ProductCard actually shows, when the visible
  // pool has one. A gallery image can only be reviewed on the product page;
  // a cover is also the thing a customer meets first, on the shop listing, so
  // including one lets both surfaces be judged in a single pass.
  const onCard = bySaving.find((c) => visibility.get(c.sourcePath)?.onProductCard === true);
  if (onCard) {
    batch.push(onCard);
    seenOrientation.add(onCard.orientation);
  }

  // Then: biggest saving, one per orientation, so the batch still spans
  // rotations where the visible pool allows it.
  for (const candidate of bySaving) {
    if (batch.length >= size) break;
    if (batch.includes(candidate)) continue;
    if (seenOrientation.has(candidate.orientation)) continue;
    seenOrientation.add(candidate.orientation);
    batch.push(candidate);
  }
  // Second pass: fill any remaining places with the largest still unused.
  for (const candidate of bySaving) {
    if (batch.length >= size) break;
    if (!batch.includes(candidate)) batch.push(candidate);
  }
  return { batch, skippedInvisible };
}
