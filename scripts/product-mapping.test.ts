/**
 * Every column the storefront FETCHES must survive into the Product it renders.
 *
 * This exists because it didn't. `video_youtube_id` was added to
 * PRODUCT_SELECT, arrived in the row, and was silently dropped by mapProduct —
 * which builds its result field by field rather than spreading. The product
 * page then checked `product.video_youtube_id`, got undefined, and rendered
 * nothing. Data correct, query correct, page blank.
 *
 * TypeScript could not catch it: Product's customer-facing extras are optional
 * (so cost and sku can stay admin-only), and an optional field that is never
 * assigned type-checks perfectly.
 *
 *   npx tsx scripts/product-mapping.test.ts
 */
import {
  ADMIN_ONLY_SELECT,
  PRODUCT_SELECT,
  mapAdminProduct,
  mapProduct,
  type AdminProductRow,
  pickHoverImage,
  type ProductVersionRow,
} from "../lib/products";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// Columns that intentionally change name or are consumed rather than copied.
const RENAMED: Record<string, string> = {
  product_id: "id",       // the stable identity id
  category_id: "category_id", // kept, and also resolved to a display name
};

/**
 * The plain columns, with EMBEDDED RESOURCES removed first.
 *
 * PostgREST embeds look like `product_images(url, sort_order)` — one selection
 * containing a comma, which a naive split turns into two columns named
 * "product_images(url" and "sort_order)". This test failed exactly that way when
 * the gallery embed was added, which is the guard doing its job rather than a
 * nuisance: an embed is not a column and is not carried by mapProduct field for
 * field, so it is checked separately below.
 */
const embedded = [...PRODUCT_SELECT.matchAll(/(\w+)\s*\([^)]*\)/g)].map((m) => m[1]);
const columns = PRODUCT_SELECT.replace(/\w+\s*\([^)]*\)/g, "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

console.log(`\n=== PRODUCT_SELECT fetches ${columns.length} columns ===`);

// A row with every fetched column set to something recognisable.
const row = Object.fromEntries(
  columns.map((c) => [c, `VALUE_${c}`])
) as unknown as ProductVersionRow;

const mapped = mapProduct(row, new Map()) as unknown as Record<string, unknown>;

console.log("\n=== every fetched column survives into Product ===");
for (const column of columns) {
  const key = RENAMED[column] ?? column;
  const present = key in mapped && mapped[key] !== undefined;
  t(`${column}${RENAMED[column] ? ` → ${RENAMED[column]}` : ""}`, present,
    present ? "" : "FETCHED BUT DROPPED BY mapProduct");
}

console.log("\n=== the specific regression ===");
t(
  "video_youtube_id is carried through",
  mapped.video_youtube_id === "VALUE_video_youtube_id",
  String(mapped.video_youtube_id)
);

// A null video must stay null rather than becoming undefined — the product
// page tests truthiness, and both are falsy, but null is the honest value and
// undefined is what a dropped field looks like.
const withoutVideo = mapProduct(
  { ...(row as unknown as Record<string, unknown>), video_youtube_id: null } as unknown as ProductVersionRow,
  new Map()
) as unknown as Record<string, unknown>;
t("a product with no video maps to null, not undefined",
  withoutVideo.video_youtube_id === null, String(withoutVideo.video_youtube_id));

// ── The admin path, which had the same bug and nobody was looking ──
//
// getAdminProducts asks for columns the storefront never does. It used to map
// them with mapProduct, which drops them — so cost_price_inr arrived from the
// database and reached the product editor as undefined. The editor showed an
// empty box and, because it saves what it shows, wrote null back on the next
// save: opening a product to fix a typo silently un-costed it.
//
// Same assertion as above, over the admin mapper and the admin columns.
console.log(`\n=== ADMIN_ONLY_SELECT fetches ${ADMIN_ONLY_SELECT.split(",").length} more ===`);

const adminColumns = ADMIN_ONLY_SELECT.split(",").map((c) => c.trim()).filter(Boolean);
const adminRow = {
  ...(row as unknown as Record<string, unknown>),
  state: "draft",
  pending_delete: false,
  ...Object.fromEntries(adminColumns.map((c) => [c, `VALUE_${c}`])),
} as unknown as AdminProductRow;

const adminMapped = mapAdminProduct(adminRow, new Map()) as unknown as Record<string, unknown>;

for (const column of adminColumns) {
  const ok = adminMapped[column] === `VALUE_${column}`;
  t(column, ok, ok ? "" : "FETCHED BUT DROPPED BY mapAdminProduct");
}

console.log("\n=== the admin mapper still carries the storefront columns ===");
for (const column of columns) {
  const key = RENAMED[column] ?? column;
  t(`${column} survives mapAdminProduct`, key in adminMapped && adminMapped[key] !== undefined);
}

// Null must stay null here too, and for the same reason as the video: the editor
// treats undefined and null identically on the way in, and then writes null on
// the way out. That is how a real cost price gets erased by a save.
const uncosted = mapAdminProduct(
  { ...(adminRow as unknown as Record<string, unknown>), cost_price_inr: null } as unknown as AdminProductRow,
  new Map()
);
t("an uncosted product maps to null, not undefined",
  uncosted.cost_price_inr === null, String(uncosted.cost_price_inr));

console.log("\n=== cost stays off the storefront ===");
// The storefront mapper must NOT pick these up even when the row happens to
// carry them: what a piece costs us has no business in a public page payload.
const storefrontFromAdminRow = mapProduct(
  adminRow as unknown as ProductVersionRow,
  new Map()
) as unknown as Record<string, unknown>;
t("mapProduct does not copy cost_price_inr", storefrontFromAdminRow.cost_price_inr === undefined);
t("mapProduct does not copy the brand knowledge", storefrontFromAdminRow.heritage_note === undefined,
  "the product page reads it through getBrandKnowledge, one piece at a time");

// ── The hover image (PR 1) ─────────────────────
// pickHoverImage decides what a card cross-fades to. It is pure, so it is
// testable without a database — and it has to be right, because the failure
// modes are invisible: cross-fading to the same photograph looks like a flicker,
// and picking a draft's photo would show unpublished work on a category page.
{
  const H = (imgs: ({ url: string | null; sort_order: number | null })[] | null | undefined,
             cover: string | null) => pickHoverImage(imgs, cover);

  t("no gallery means no hover image", H(null, "a.jpg") === null,
    "every product today has exactly one photograph");
  t("an empty gallery too", H([], "a.jpg") === null);
  t("a gallery of only the cover does not cycle to itself",
    H([{ url: "a.jpg", sort_order: 0 }], "a.jpg") === null,
    "a cross-fade from a photograph to the same photograph is a flicker");
  t("the second photograph is chosen",
    H([{ url: "a.jpg", sort_order: 0 }, { url: "b.jpg", sort_order: 1 }], "a.jpg") === "b.jpg");
  t("sort_order decides, not array order",
    H([{ url: "c.jpg", sort_order: 2 }, { url: "b.jpg", sort_order: 1 }], "a.jpg") === "b.jpg");
  t("a null sort_order sorts last rather than first",
    H([{ url: "z.jpg", sort_order: null }, { url: "b.jpg", sort_order: 1 }], "a.jpg") === "b.jpg",
    "a row saved without an order must not jump ahead of a deliberate gallery");
  t("a drifted cover still finds a different photograph",
    H([{ url: "a.jpg", sort_order: 0 }, { url: "b.jpg", sort_order: 1 }], "stale.jpg") === "a.jpg",
    "image_url being in sync is a promise, not a guarantee");
  t("rows with no url are skipped",
    H([{ url: null, sort_order: 0 }, { url: "b.jpg", sort_order: 1 }], "a.jpg") === "b.jpg");
  t("the input array is not mutated", (() => {
    const input = [{ url: "c.jpg", sort_order: 2 }, { url: "b.jpg", sort_order: 1 }];
    H(input, "a.jpg");
    return input[0].url === "c.jpg";
  })(), "mapProduct runs over a shared row; sorting in place would reorder the caller's gallery");
}

// ── The embed is fetched, and it is actually used ──
// The three-place rule applies to the gallery too, just differently: it must be
// asked for in PRODUCT_SELECT, typed on ProductVersionRow, and turned into
// something by mapProduct. Fetching it and dropping it is the #94 bug again,
// only quieter — the cards would simply never cycle and nobody would know why.
{
  t("PRODUCT_SELECT embeds the gallery", embedded.includes("product_images"),
    embedded.join(", ") || "none");

  const withGallery = mapProduct(
    {
      ...(row as unknown as Record<string, unknown>),
      image_url: "cover.jpg",
      product_images: [
        { url: "cover.jpg", sort_order: 0 },
        { url: "second.jpg", sort_order: 1 },
      ],
    } as ProductVersionRow,
    new Map()
  );
  t("mapProduct derives hover_image_url from the embed",
    withGallery.hover_image_url === "second.jpg", String(withGallery.hover_image_url));

  const noGallery = mapProduct({ ...(row as unknown as Record<string, unknown>), image_url: "cover.jpg" } as ProductVersionRow, new Map());
  t("and null when the query did not ask for it",
    noGallery.hover_image_url === null,
    "a read without the embed must not crash a card");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
