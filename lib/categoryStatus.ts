import type { Category } from "./types";

/**
 * Why a category is or isn't on the live site.
 *
 * The storefront applies several independent rules, and the admin previously
 * showed only one of them ("Visible"). A section could read as Visible and be
 * suppressed for three other reasons with nothing on screen saying so — which
 * is exactly how a published, visible Jewellery section stayed invisible.
 *
 * The rules mirrored here:
 *  - getVisibleCategoryTree drops parents with no visible children
 *  - getNavCategoryTree additionally needs an active product
 *  - a hidden parent hides its children regardless of their own flag
 */
export type LiveStatus = {
  live: boolean;
  /** Short reason, shown on the row. Null when live. */
  reason: string | null;
  /** What to do about it. */
  fix: string | null;
};

const LIVE: LiveStatus = { live: true, reason: null, fix: null };

export function categoryLiveStatus(
  cat: Category,
  {
    all,
    productCounts,
    neverPublished,
    pageMissing = false,
  }: {
    all: Category[];
    /** Active PUBLISHED products per category id. */
    productCounts: Record<string, number>;
    neverPublished: Set<string>;
    /** Parent only: its page 404s, so it needs a deploy. */
    pageMissing?: boolean;
  }
): LiveStatus {
  if (neverPublished.has(cat.id)) {
    return {
      live: false,
      reason: "Not published",
      fix: "Press Publish to site.",
    };
  }

  if (!cat.is_visible) {
    return {
      live: false,
      reason: "Hidden",
      fix: "Switch it to Visible when you're ready to show it.",
    };
  }

  // Sub-category
  if (cat.parent_id) {
    const parent = all.find((c) => c.id === cat.parent_id);
    if (parent && !parent.is_visible) {
      return {
        live: false,
        reason: `${parent.name} is hidden`,
        fix: `A hidden section hides everything inside it — make ${parent.name} visible too.`,
      };
    }
    if ((productCounts[cat.id] ?? 0) === 0) {
      return {
        live: false,
        reason: "No products",
        fix: "Assign an active product to it, or it stays out of the menu.",
      };
    }
    return LIVE;
  }

  // Top-level section
  const children = all.filter((c) => c.parent_id === cat.id);
  const visibleChildren = children.filter((c) => c.is_visible);

  if (children.length === 0) {
    return {
      live: false,
      reason: "No sub-categories",
      fix: "Add one below — an empty section is never shown, to avoid a dead link in the menu.",
    };
  }
  if (visibleChildren.length === 0) {
    return {
      live: false,
      reason: "No visible sub-categories",
      fix: "Make at least one of its sub-categories visible.",
    };
  }
  if (!visibleChildren.some((c) => (productCounts[c.id] ?? 0) > 0)) {
    return {
      live: false,
      reason: "No products",
      fix: "Add an active product to one of its sub-categories.",
    };
  }
  if (pageMissing) {
    return {
      live: false,
      reason: "Needs a deploy",
      fix: `Everything is set, but /${cat.slug} is built at deploy time. Redeploy to create the page.`,
    };
  }
  return LIVE;
}
