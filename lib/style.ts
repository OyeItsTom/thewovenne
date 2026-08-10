import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { parseStyleLink, type StyleLink } from "./styleMedia";

/**
 * Reading customer style — the gallery, the per-product section, and a
 * customer's own submission.
 *
 * EVERY PUBLIC READ GOES THROUGH public_style_submissions, the view from 0047.
 * That view is the single definition of "may be shown": approved, consented, not
 * withdrawn. Querying the table with those three conditions spelled out here
 * would be a second copy of the rule, and the failure mode of the copy that
 * forgets `withdrawn_at` is somebody's photograph staying up after they asked
 * for it to come down.
 *
 * The view is granted to `anon`, so none of this needs a session and none of it
 * can see a pending submission. The admin queue reads the table directly, under
 * the admin policy — a different question, deliberately a different query.
 */

export interface StyleItem {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  photoUrl: string | null;
  /** Null for a video-only submission. Present so a gallery can reserve space. */
  width: number | null;
  height: number | null;
  caption: string | null;
  /** First name, only if they agreed to be credited. Null means show it anonymously. */
  creditName: string | null;
  createdAt: string;
  /** Parsed from the stored link, so the button and thumbnail need no parsing at render. */
  link: StyleLink | null;
}

/** The columns the view exposes, named once. */
const STYLE_SELECT =
  "id, product_id, photo_url, photo_width, photo_height, video_platform, " +
  "video_url, caption, credit_name, created_at, product_name, product_slug";

type StyleRow = {
  id: string;
  product_id: string;
  photo_url: string | null;
  photo_width: number | null;
  photo_height: number | null;
  video_platform: string | null;
  video_url: string | null;
  caption: string | null;
  credit_name: string | null;
  created_at: string;
  product_name: string;
  product_slug: string;
};

export function mapStyleItem(row: StyleRow): StyleItem {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    productSlug: row.product_slug,
    photoUrl: row.photo_url,
    width: row.photo_width,
    height: row.photo_height,
    caption: row.caption,
    creditName: row.credit_name,
    createdAt: row.created_at,
    // Re-parsed rather than trusted: the stored URL was normalised on the way in,
    // and parsing it again is what produces the thumbnail and the button label
    // without either being stored and able to drift.
    link: row.video_url ? parseStyleLink(row.video_url) : null,
  };
}

/**
 * The gallery, newest first.
 *
 * NO PAGINATION YET, and a limit instead. At the volume this shop is at, an
 * offset-paginated masonry gallery is machinery for a problem it does not have —
 * and a staggered layout re-flows on every page change, which is worse to look
 * at than a long scroll. When it needs paging it should be keyset on created_at,
 * which is why the ordering is already that column and not a score.
 */
export async function getApprovedStyle(
  limit = 60,
  client: SupabaseClient = supabase
): Promise<StyleItem[]> {
  const { data, error } = await client
    .from("public_style_submissions")
    .select(STYLE_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getApprovedStyle:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as StyleRow[]).map(mapStyleItem);
}

/** One product's approved submissions, for the section on its page. */
export async function getStyleForProduct(
  productId: string,
  limit = 8,
  client: SupabaseClient = supabase
): Promise<StyleItem[]> {
  const { data, error } = await client
    .from("public_style_submissions")
    .select(STYLE_SELECT)
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getStyleForProduct:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as StyleRow[]).map(mapStyleItem);
}

/**
 * The signed-in customer's own submission for one product, whatever its state.
 *
 * Reads the TABLE, not the view — a customer needs to see their own pending or
 * rejected submission, which the view exists to hide. RLS (0047) restricts it to
 * their own rows, so this is safe with no user id in the query; passing one would
 * imply the filter were doing the protecting.
 *
 * Needs the caller's authenticated client. With the anonymous one it correctly
 * returns nothing.
 */
export interface MySubmission {
  id: string;
  status: "pending" | "approved" | "rejected";
  photoUrl: string | null;
  videoUrl: string | null;
  caption: string | null;
  creditName: string | null;
  withdrawnAt: string | null;
  /** Why it was not used — shown to them now, per 0052. Null after a silent reject. */
  rejectReason: string | null;
  createdAt: string;
}

export async function getMySubmission(
  productId: string,
  client: SupabaseClient
): Promise<MySubmission | null> {
  const { data, error } = await client
    .from("style_submissions")
    .select(
      "id, status, photo_url, video_url, caption, credit_name, withdrawn_at, reject_reason, created_at"
    )
    .eq("product_id", productId)
    .maybeSingle();

  if (error) {
    // Not fatal and not logged loudly: an anonymous caller hitting this is the
    // normal case for a product page rendered for a guest.
    return null;
  }
  if (!data) return null;

  const row = data as unknown as {
    id: string;
    status: MySubmission["status"];
    photo_url: string | null;
    video_url: string | null;
    caption: string | null;
    credit_name: string | null;
    withdrawn_at: string | null;
    reject_reason: string | null;
    created_at: string;
  };

  return {
    id: row.id,
    status: row.status,
    photoUrl: row.photo_url,
    videoUrl: row.video_url,
    caption: row.caption,
    creditName: row.credit_name,
    withdrawnAt: row.withdrawn_at,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
  };
}

/**
 * Whether this customer may submit for this product at all.
 *
 * Asks the database the same question the RLS policy asks — `has_purchased()`,
 * a paid and DELIVERED order containing that product — rather than inferring it
 * from order history in the browser. The policy is what decides; this only
 * decides whether to draw the form, and the two must not be able to disagree.
 */
export async function canSubmitStyle(
  productId: string,
  client: SupabaseClient
): Promise<boolean> {
  const { data, error } = await client.rpc("has_purchased", { p_product_id: productId });
  if (error) return false;
  return data === true;
}

/**
 * How the gallery lays out one item.
 *
 * A ratio, so a column can reserve the right height before the image loads. A
 * submission with no dimensions — a video card, or a photograph uploaded before
 * 0052 — gets the recommended portrait shape rather than a square: guessing
 * square makes every unknown item visibly wrong in the same direction, while the
 * portrait guess is right most of the time and forgivable when it is not.
 */
export function aspectRatio(item: StyleItem): number {
  if (item.width && item.height) return item.width / item.height;
  return 1200 / 1500;
}
