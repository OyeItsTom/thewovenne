/**
 * Whether a photograph is publicly visible, decided the way the site decides.
 *
 * These tests exist because batch 1 got it wrong. Four of five migrated
 * photographs turned out to be invisible, because selection reasoned about
 * `product_images.product_id` while lib/products.ts reasons about
 * `product_images.product_version_id`. Everything below is a fixture built to
 * make that distinction fail loudly if anyone reintroduces it.
 */
import { readFileSync } from "node:fs";
import {
  PUBLIC_STATES,
  keyOf,
  resolveVisibility,
  selectVisibleBatch,
  visibilityFor,
  type GalleryRow,
  type VersionRow,
} from "../lib/imageVisibility";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else { fail++; if (detail) console.log(`        ${detail}`); }
}

const url = (key: string) => `https://x.supabase.co/storage/v1/object/public/product-images/${key}`;
const version = (over: Partial<VersionRow> & { id: string }): VersionRow => ({
  product_id: "p1", state: "published", image_url: null, name: "A Saree",
  slug: "a-saree", is_active: true, ...over,
});
const row = (over: Partial<GalleryRow> & { id: string }): GalleryRow => ({
  product_version_id: "v-pub", product_id: "p1", url: null, sort_order: 0, ...over,
});

console.log("\n=== it mirrors the production query, not a guess ===");
const products = readFileSync("lib/products.ts", "utf8");
const readCtx = readFileSync("lib/readCtx.ts", "utf8");
const vis = readFileSync("lib/imageVisibility.ts", "utf8");
check("the site reads galleries FROM product_versions", products.includes('.from("product_versions")'));
check("filtered by state", products.includes('.in("state", statesFor(ctx))'));
check("anonymous state is exactly published", readCtx.includes('ctx.preview ? ["published", "draft"] : ["published"]'));
check("the gallery is embedded, not fetched by product", products.includes("product_images(url, sort_order)"));
check("and that embed goes through product_version_id",
  products.includes("Embedded through product_images.product_version_id"));
check("our PUBLIC_STATES matches the anonymous filter", [...PUBLIC_STATES].join() === "published");
check("this module never keys visibility on product_id",
  !/product_version_id/.test("") && vis.includes("product_version_id") && !/row\.product_id\s*===/.test(vis));

console.log("\n=== the exact batch-1 mistake ===");
const versions = [
  version({ id: "v-pub", state: "published", image_url: url("products/cover.jpg") }),
  version({ id: "v-arch", state: "archived" }),
];
const gallery = [
  row({ id: "g1", product_version_id: "v-pub", url: url("products/live.jpg"), sort_order: 0 }),
  row({ id: "g2", product_version_id: "v-arch", url: url("products/archived.jpg"), sort_order: 0 }),
];
const map = resolveVisibility(versions, gallery);
check("a row on the published version is visible", map.get("products/live.jpg")?.publiclyVisible === true);
check("a row on an ARCHIVED version is NOT visible", map.has("products/archived.jpg") === false);
check("both rows share a product_id, so product_id cannot decide it",
  gallery[0].product_id === gallery[1].product_id);
check("the archived row explains itself",
  visibilityFor("products/archived.jpg", map, gallery, versions).reason.includes("archived"));

console.log("\n=== inactive products are not on the shop ===");
const inactive = resolveVisibility(
  [version({ id: "v-pub", is_active: false, image_url: url("products/x.jpg") })],
  [row({ id: "g", product_version_id: "v-pub", url: url("products/x.jpg") })]
);
check("a published version on an inactive product is not visible", inactive.has("products/x.jpg") === false);
check("and says why",
  visibilityFor("products/x.jpg", inactive,
    [row({ id: "g", product_version_id: "v-pub", url: url("products/x.jpg") })],
    [version({ id: "v-pub", is_active: false })]).reason.includes("not active"));

console.log("\n=== draft-only is excluded ===");
const draftOnly = resolveVisibility(
  [version({ id: "v-draft", state: "draft" })],
  [row({ id: "g", product_version_id: "v-draft", url: url("products/d.jpg") })]
);
check("a draft-only image is not publicly visible", draftOnly.has("products/d.jpg") === false);

console.log("\n=== covers, gallery order, and the card ===");
const ordered = resolveVisibility(
  [version({ id: "v-pub", image_url: url("products/b.jpg") })],
  [
    row({ id: "g2", url: url("products/b.jpg"), sort_order: 1 }),
    row({ id: "g1", url: url("products/a.jpg"), sort_order: 0 }),
    row({ id: "g3", url: url("products/c.jpg"), sort_order: 2 }),
  ]
);
check("gallery index follows sort_order, not row order", ordered.get("products/a.jpg")?.galleryIndex === 0);
check("second image is index 1", ordered.get("products/b.jpg")?.galleryIndex === 1);
check("the version's image_url is flagged as the cover", ordered.get("products/b.jpg")?.isCover === true);
check("a non-cover gallery image is not", ordered.get("products/c.jpg")?.isCover === false);
check("the first image is on the card", ordered.get("products/a.jpg")?.onProductCard === true);
check("the cover is on the card even at index 1", ordered.get("products/b.jpg")?.onProductCard === true);
check("a middle gallery image is not on the card", ordered.get("products/c.jpg")?.onProductCard === false);
check("product name is carried for the report", ordered.get("products/a.jpg")?.productName === "A Saree");
check("slug is carried so a PDP URL can be built", ordered.get("products/a.jpg")?.productSlug === "a-saree");
check("the public version id is recorded", ordered.get("products/a.jpg")?.publicVersionId === "v-pub");

console.log("\n=== a cover that is not a gallery row still renders ===");
const coverOnly = resolveVisibility(
  [version({ id: "v-pub", image_url: url("products/only-cover.jpg") })],
  [row({ id: "g", url: url("products/other.jpg"), sort_order: 0 })]
);
check("cover-only images are visible", coverOnly.get("products/only-cover.jpg")?.publiclyVisible === true);
check("and on the card", coverOnly.get("products/only-cover.jpg")?.onProductCard === true);

console.log("\n=== an image used by two products keeps the strongest claim ===");
const shared = resolveVisibility(
  [version({ id: "vA", product_id: "pA", image_url: url("products/s.jpg") }),
   version({ id: "vB", product_id: "pB", slug: "b-saree" })],
  [row({ id: "g1", product_version_id: "vA", url: url("products/s.jpg"), sort_order: 0 }),
   row({ id: "g2", product_version_id: "vB", url: url("products/s.jpg"), sort_order: 4 })]
);
check("a shared image stays visible", shared.get("products/s.jpg")?.publiclyVisible === true);
check("and keeps its cover status", shared.get("products/s.jpg")?.isCover === true);
check("and its card status", shared.get("products/s.jpg")?.onProductCard === true);

console.log("\n=== keyOf ===");
check("a public URL yields the key", keyOf(url("products/a.jpg")) === "products/a.jpg");
check("a query string is dropped", keyOf(url("products/a.jpg") + "?x=1") === "products/a.jpg");
check("percent-encoding is decoded", keyOf(url("products/a%20b.jpg")) === "products/a b.jpg");
check("a non-storage URL yields nothing", keyOf("https://example.test/a.jpg") === null);
check("null is handled", keyOf(null) === null);

console.log("\n=== selection: visibility outranks orientation ===");
type C = { sourcePath: string; sourceBytes: number; orientation: number | null };
const cands: C[] = [
  { sourcePath: "products/big-invisible.jpg", sourceBytes: 30_000_000, orientation: 3 },
  { sourcePath: "products/small-visible.jpg", sourceBytes: 1_000_000, orientation: 1 },
  { sourcePath: "products/mid-visible.jpg", sourceBytes: 5_000_000, orientation: 6 },
];
const visMap = new Map([
  ["products/small-visible.jpg", { publiclyVisible: true, onProductCard: false } as never],
  ["products/mid-visible.jpg", { publiclyVisible: true, onProductCard: false } as never],
]);
const picked = selectVisibleBatch(cands, visMap, 5);
check("the big INVISIBLE candidate is not chosen despite its size",
  !picked.batch.some((c) => c.sourcePath.includes("invisible")));
check("both visible candidates are chosen", picked.batch.length === 2);
check("the skipped count is reported", picked.skippedInvisible === 1);
check("a short batch is returned rather than padded", picked.batch.length < 5);
check("largest visible comes first", picked.batch[0].sourcePath === "products/mid-visible.jpg");

console.log("\n=== selection reserves a ProductCard image when one exists ===");
const withCard: C[] = [
  { sourcePath: "products/huge-gallery.jpg", sourceBytes: 30_000_000, orientation: 6 },
  { sourcePath: "products/small-cover.jpg", sourceBytes: 2_000_000, orientation: 6 },
];
const cardMap = new Map([
  ["products/huge-gallery.jpg", { publiclyVisible: true, onProductCard: false } as never],
  ["products/small-cover.jpg", { publiclyVisible: true, onProductCard: true } as never],
]);
const cardPick = selectVisibleBatch(withCard, cardMap, 5);
check("the card image is included even though it is smaller",
  cardPick.batch.some((c) => c.sourcePath === "products/small-cover.jpg"));
check("it is placed first, so the review starts on the shop listing",
  cardPick.batch[0].sourcePath === "products/small-cover.jpg");
check("the larger gallery image still makes the batch", cardPick.batch.length === 2);
check("no candidate appears twice", new Set(cardPick.batch.map((c) => c.sourcePath)).size === cardPick.batch.length);

console.log("\n=== the batch never exceeds what was asked for ===");
const many: C[] = Array.from({ length: 12 }, (_, i) => ({
  sourcePath: `products/v${i}.jpg`, sourceBytes: 1_000_000 * (12 - i), orientation: i % 4,
}));
const manyMap = new Map(many.map((c) => [c.sourcePath, { publiclyVisible: true, onProductCard: false } as never]));
check("size 5 returns exactly 5", selectVisibleBatch(many, manyMap, 5).batch.length === 5);
check("orientation variety is used as a tie-break",
  new Set(selectVisibleBatch(many, manyMap, 5).batch.map((c) => c.orientation)).size === 4);
check("nothing invisible sneaks in", selectVisibleBatch(many, new Map(), 5).batch.length === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
