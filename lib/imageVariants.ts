/**
 * WHICH FILE THE IMAGE OPTIMIZER IS POINTED AT.
 *
 * ── WHY THIS EXISTS ──
 *
 * Every photograph on the storefront reaches the visitor through an image
 * optimizer (Vercel's in production, Next's own locally). On a cache miss the
 * optimizer downloads the WHOLE source object from Supabase Storage — once per
 * photograph, per width, per region, per server — and keeps only a small
 * resized copy. Our masters are 2400px on the short edge at JPEG q92: about
 * 3.2 MB each, measured across the live catalogue (12 Oct 2026). The widest
 * thing the site ever displays is 1920px. So most of every optimizer fetch was
 * pixels it threw away, and that traffic is what Supabase bills as egress.
 *
 * A DERIVATIVE is a smaller copy of a master, made once, kept next to it under
 * a new name (never by overwriting: a replaced object stays cached at
 * Supabase's CDN with its old bytes — see SEO-6B). Two sizes:
 *
 *   w1080 — product cards, thumbnails, anything rendered narrow. Cards are at
 *           most 272 CSS px, so even a 3x phone asks for 828. ~0.5 MB.
 *   w1920 — the product page frame and the zoom viewer, whose widest request is
 *           1920. ~1.7 MB.
 *
 * The master stays exactly as it is: the archival copy, the fallback, and what
 * every non-storefront surface (cart, orders, admin, chat) keeps naming.
 *
 * ── THE ONE RULE ──
 *
 * A derivative is used ONLY when the registry (public.image_derivatives, 0071)
 * has recorded it as ready for the current recipe. The storefront's data layer
 * reads that registry and hands components an ImageVariantMap; components ask
 * imageFor() and never build a derived URL themselves. A photograph with no
 * entry — every photograph, until the backfill runs — resolves to its master,
 * which is precisely what the site renders today.
 *
 * CLIENT-SAFE. No sharp, no Supabase client, no Node APIs: ProductCard and the
 * gallery import this.
 */

/** The two delivery sizes, by the width of the derivative. */
export type DerivedTier = "w1080" | "w1920";

/** What a surface needs: a narrow card/thumbnail, or a large detail view. */
export type ImageUse = "card" | "detail";

export const DERIVED_TIERS: readonly DerivedTier[] = ["w1080", "w1920"] as const;

/**
 * The tiers that are MADE — by the admin upload route and, by default, the
 * backfill. Every tier is still READ: imageFor() uses whatever the registry
 * says is ready, so turning a tier on later needs no storefront change.
 *
 * w1080 only, by owner decision (13 Oct 2026). Cards and thumbnails carry
 * most of the optimizer's origin traffic, and w1080 is the bulk of the saving
 * for ~73 MB of storage; w1920 would add ~200 MB more against the Free plan's
 * 1 GB. PDP, gallery frame and zoom keep using the master until w1920 is
 * separately approved — then add it here and run the backfill with
 * `--tiers w1920`.
 */
export const ACTIVE_TIERS: readonly DerivedTier[] = ["w1080"] as const;

/** Parse a comma-separated tier list (`w1080,w1920`). Throws on anything else. */
export function parseTiers(raw: string): DerivedTier[] {
  const out: DerivedTier[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!(DERIVED_TIERS as readonly string[]).includes(part)) {
      throw new Error(`unknown tier "${part}" — expected ${DERIVED_TIERS.join(" or ")}`);
    }
    if (!out.includes(part as DerivedTier)) out.push(part as DerivedTier);
  }
  if (out.length === 0) throw new Error("no tier given");
  return out;
}

/** Pixel width of each derivative. */
export const TIER_WIDTH: Record<DerivedTier, number> = { w1080: 1080, w1920: 1920 };

/**
 * The recipe version. Part of every derived name, and the storefront reads only
 * registry rows of THIS recipe — so changing the encoder later means new names
 * and a fresh backfill, never an overwrite of a cached object.
 */
export const DERIVATIVE_RECIPE = 1;

/** Where derivatives live in the bucket: NOT products/, which the orphan tooling owns. */
export const DERIVED_PREFIX = "derived";

export const IMAGE_BUCKET = "product-images";

/**
 * For each master URL that has at least one ready derivative, the public URL of
 * each one. Absent key = no derivatives = use the master.
 */
export type ImageVariantMap = Record<string, Partial<Record<DerivedTier, string>>>;

/**
 * The order each use prefers. A card would rather have the small copy, but the
 * large one is still a fraction of the master. A detail view never takes the
 * small copy — the zoom viewer's whole point is the pixels a 1080 lacks.
 */
const PREFERENCE: Record<ImageUse, readonly DerivedTier[]> = {
  card: ["w1080", "w1920"],
  detail: ["w1920"],
};

/**
 * THE central selection. The URL to give next/image for this photograph and
 * this use, or the master itself when nothing better is registered.
 */
export function imageFor(
  masterUrl: string,
  use: ImageUse,
  variants: ImageVariantMap | null | undefined
): string {
  const entry = variants?.[masterUrl];
  if (!entry) return masterUrl;
  for (const tier of PREFERENCE[use]) {
    const url = entry[tier];
    if (typeof url === "string" && url.length > 0) return url;
  }
  return masterUrl;
}

/**
 * The bucket key of a master, e.g. "products/abc-v1.jpg", from its stored
 * public URL — or null for anything that is not a plain public object on THIS
 * project's storage host in the product-images bucket. Query strings,
 * fragments, encoding, other hosts, other buckets and signed or transform
 * routes are all refused, exactly like lib/seo's recogniser.
 */
export function storageKeyFromPublicUrl(
  url: string,
  supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL
): string | null {
  let host: string;
  let parsed: URL;
  try {
    const base = new URL((supabaseUrl ?? "").trim());
    if (base.protocol !== "https:") return null;
    host = base.host;
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.href !== url ||
    parsed.protocol !== "https:" ||
    parsed.host !== host ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  const prefix = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  const key = parsed.pathname.slice(prefix.length);
  return isSafeSourceKey(key) ? key : null;
}

/**
 * A master key a derivative may be made from: one folder segment, a plain file
 * name, an image extension. Nothing encoded, nested, hidden or relative — the
 * derived name is built from it, so it must not be able to steer that name.
 */
export function isSafeSourceKey(key: string): boolean {
  return /^(products|journal|lookbook|campaigns|pages)\/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:jpe?g|png|webp)$/i.test(
    key
  );
}

/**
 * The derived object's key. Deterministic, so a retry, a second upload of the
 * same photograph and a resumed backfill all land on the same name — and
 * upsert:false turns "already there" into proof of idempotency rather than an
 * overwrite.
 *
 *   products/39b4…-v1.jpg  →  derived/products-39b4…-v1-w1080-r1.jpg
 *
 * The source folder is kept in the name so two folders holding the same file
 * name can never collide. The extension is the derivative's own encoding.
 */
export function derivedKey(sourceKey: string, tier: DerivedTier, ext: "jpg" | "webp"): string {
  if (!isSafeSourceKey(sourceKey)) {
    throw new Error(`Not a derivable source key: ${sourceKey}`);
  }
  const [folder, file] = sourceKey.split("/");
  const stem = file.replace(/\.[^.]+$/, "");
  return `${DERIVED_PREFIX}/${folder}-${stem}-${tier}-r${DERIVATIVE_RECIPE}.${ext}`;
}

/** Whether a bucket key is a derivative (any recipe). */
export function isDerivedKey(key: string): boolean {
  return /^derived\/[A-Za-z0-9][A-Za-z0-9_-]*-w(?:1080|1920)-r\d+\.(?:jpg|webp)$/.test(key);
}

/** The public URL of a bucket key on the configured storage host. */
export function publicObjectUrl(
  key: string,
  supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL
): string | null {
  try {
    const base = new URL((supabaseUrl ?? "").trim());
    if (base.protocol !== "https:") return null;
    return `${base.origin}/storage/v1/object/public/${IMAGE_BUCKET}/${key}`;
  } catch {
    return null;
  }
}
