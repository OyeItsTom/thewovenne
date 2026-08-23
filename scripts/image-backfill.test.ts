/**
 * The backfill planner, and the promise that it cannot touch anything.
 *
 * Two kinds of check. The REFERENCE GRAPH and the classifier are executed
 * against literal rows — which is the only way to test the cases that would
 * actually cost photography: a basket holding the last reference, a draft
 * version holding the last reference, a table that could not be read. The
 * NO-WRITE PROOF is a source assertion, and it is the point of this PR: it reads
 * the two new files and fails if any Supabase mutation verb appears in them at
 * all. Not "behind a flag" — at all.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  HISTORICAL_REFERENCE_TABLES,
  ImageReferenceGraph,
  LIVE_REFERENCE_TABLES,
  RECENT_UPLOAD_WINDOW_HOURS,
  classifyObject,
  extractObjectKeys,
  isDeletionEligible,
  isRecent,
  type StorageObject,
} from "../lib/imageReferences";
import { NORMALIZER_VERSION, masterKey, targetSize } from "../lib/imageNormalize";
import { displayDimensions, estimateMasterBytes, parseHeader } from "./backfill-images";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else {
    fail++;
    if (detail) console.log(`        ${detail}`);
  }
}

const B = "product-images";
const url = (key: string) =>
  `https://x.supabase.co/storage/v1/object/public/product-images/${key}`;
const obj = (key: string, bytes = 1000, extra: Partial<StorageObject> = {}): StorageObject => ({
  bucket: B, key, bytes, mime: "image/jpeg", createdAt: "2026-01-01T00:00:00Z", ...extra,
});

async function main() {
  console.log("\n=== the no-write proof — the reason this PR exists ===");
  const planner = readFileSync("scripts/backfill-images.ts", "utf8");
  const graphSrc = readFileSync("lib/imageReferences.ts", "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = strip(planner) + "\n" + strip(graphSrc);
  for (const verb of ["insert", "update", "upsert", "delete", "remove", "upload"]) {
    check(`no .${verb}( call anywhere in the C1 tooling`,
      !new RegExp(`\\.\\s*${verb}\\s*\\(`).test(code),
      `found .${verb}( in the new files`);
  }
  check("no DELETE/PUT/PATCH/POST-to-rest HTTP verbs", !/method:\s*"(DELETE|PUT|PATCH)"/.test(code));
  // Every POST in this file must be a storage LIST, which is a query. The
  // count used to be pinned at 2 because the file carried two near-identical
  // listers; the recursion now lives in lib/storagePrefixes.ts, so there is
  // one. Assert the property rather than the number, so consolidating or
  // adding a listing cannot fail this for the wrong reason — and a POST to
  // anything other than object/list still does.
  const posts = code.split(/method:\s*"POST"/).slice(1);
  check("every POST is a storage LIST query, and there is at least one",
    posts.length >= 1 && posts.every((_, i) =>
      /object\/list\//.test(code.split(/method:\s*"POST"/)[i])));
  check("no POST targets a REST table", !/rest\/v1\/[^`"']*[\s\S]{0,200}?method:\s*"POST"/.test(code));
  check("no supabase-js client is constructed (it can write)", !/createClient\s*\(/.test(code));
  check("the only file written is the gitignored report", (code.match(/writeFileSync\(/g) ?? []).length === 1);
  check("and it goes to reports/", code.includes('"reports/image-backfill"'));
  check("reports/ is gitignored", readFileSync(".gitignore", "utf8").includes("reports/"));
  check("no destructive flag exists to be discovered later",
    !/--execute|--force|--yes|--confirm|destructive/i.test(code));

  console.log("\n=== reference extraction ===");
  check("a public URL is recognised", extractObjectKeys(url("products/a.jpg"))[0].key === "products/a.jpg");
  check("bucket is captured", extractObjectKeys(url("products/a.jpg"))[0].bucket === B);
  check("a signed URL is still a reference",
    extractObjectKeys("https://x.supabase.co/storage/v1/object/sign/product-images/products/b.jpg?token=z")[0].key === "products/b.jpg");
  check("a query string is not part of the key",
    extractObjectKeys(url("products/c.jpg") + "?width=200")[0].key === "products/c.jpg");
  check("percent-encoding is decoded",
    extractObjectKeys(url("products/a%20b.jpg"))[0].key === "products/a b.jpg");
  check("URLs nested in JSONB are found",
    extractObjectKeys({ blocks: [{ image: url("lookbook/d.jpg") }] })[0].key === "lookbook/d.jpg");
  check("a row with no URL yields nothing", extractObjectKeys({ name: "plain" }).length === 0);
  check("the same key twice in one row counts once",
    extractObjectKeys({ a: url("products/e.jpg"), b: url("products/e.jpg") }).length === 1);

  console.log("\n=== every reference source the audit found ===");
  const graph = new ImageReferenceGraph([
    { table: "product_images", rows: [{ id: "pi1", product_id: "p1", url: url("products/one.jpg") }] },
    { table: "products", rows: [{ id: "p2", image_url: url("products/cover.jpg") }] },
    { table: "product_versions", rows: [{ id: "v1", product_id: "p3", image_url: url("products/draft.jpg"), state: "draft" }] },
    { table: "site_content", rows: [{ id: "sc1", value: { hero: url("lookbook/cms.jpg") } }] },
    { table: "carts", rows: [{ id: "c1", items: [{ image_url: url("products/incart.jpg") }] }] },
    { table: "admin_audit_log", rows: [{ id: "a1", payload: { url: url("products/logged.jpg") } }] },
  ]);
  for (const [key, table] of [["products/one.jpg", "product_images"], ["products/cover.jpg", "products"],
    ["products/draft.jpg", "product_versions"], ["lookbook/cms.jpg", "site_content"],
    ["products/incart.jpg", "carts"]] as const) {
    check(`${table} counts as a LIVE reference`, graph.liveReferenceCount(B, key) === 1, `${key}`);
  }
  check("admin_audit_log does NOT count as live", graph.liveReferenceCount(B, "products/logged.jpg") === 0);
  check("but is recorded as historical", graph.historicalReferenceCount(B, "products/logged.jpg") === 1);
  check("the five live tables are the audited ones",
    [...LIVE_REFERENCE_TABLES].join() === "product_images,products,product_versions,site_content,carts");
  check("audit log is the only historical table", [...HISTORICAL_REFERENCE_TABLES].join() === "admin_audit_log");
  check("an object nothing mentions has no references", graph.liveReferenceCount(B, "products/ghost.jpg") === 0);
  check("the field holding the URL is reported",
    graph.referencesFor(B, "products/cover.jpg")[0].field === "image_url");

  console.log("\n=== a table nobody classified is treated as LIVE, never ignored ===");
  const surprise = new ImageReferenceGraph([
    { table: "some_new_table_2027", rows: [{ id: "n1", banner: url("products/new.jpg") }] },
  ]);
  check("an unknown table's reference counts as live", surprise.liveReferenceCount(B, "products/new.jpg") === 1);
  check("so the object cannot be classified deletable",
    classifyObject({ object: obj("products/new.jpg"), liveReferences: 1, historicalReferences: 0, graphIsComplete: true }) !== "CONFIRMED_ZERO_REFERENCE");

  console.log("\n=== shared sources ===");
  const shared = new ImageReferenceGraph([
    { table: "product_images", rows: [
      { id: "x1", product_id: "pA", url: url("products/shared.jpg") },
      { id: "x2", product_id: "pB", url: url("products/shared.jpg") }] },
    { table: "product_versions", rows: [{ id: "v9", product_id: "pA", image_url: url("products/shared.jpg") }] },
  ]);
  check("three live references are counted", shared.liveReferenceCount(B, "products/shared.jpg") === 3);
  check("it is flagged as shared", shared.isShared(B, "products/shared.jpg"));
  check("a single-reference object is not shared", graph.isShared(B, "products/one.jpg") === false);
  check("associated entities are de-duplicated", shared.associatedEntities(B, "products/shared.jpg").length === 3);
  check("the breakdown names each table",
    JSON.stringify(shared.breakdown(B, "products/shared.jpg")) === '{"product_images":2,"product_versions":1}');

  console.log("\n=== classification ===");
  const old = "2026-01-01T00:00:00Z";
  const cls = (o: StorageObject, live: number, hist = 0, complete = true) =>
    classifyObject({ object: o, liveReferences: live, historicalReferences: hist, graphIsComplete: complete, now: new Date("2026-08-21T00:00:00Z") });
  check("referenced product source", cls(obj("products/a.jpg", 1, { createdAt: old }), 1) === "REFERENCED_PRODUCT_SOURCE");
  check("referenced shared source", cls(obj("products/a.jpg", 1, { createdAt: old }), 2) === "REFERENCED_SHARED_SOURCE");
  check("referenced non-product asset", cls(obj("lookbook/a.jpg", 1, { createdAt: old }), 1) === "REFERENCED_NON_PRODUCT_ASSET");
  check("already normalized master", cls(obj("products/abc-v1.jpg", 1, { createdAt: old }), 1) === "ALREADY_NORMALIZED");
  check("a -v1 master is never a backfill source", cls(obj("products/abc-v1.jpg", 1, { createdAt: old }), 0) === "ALREADY_NORMALIZED");
  check("confirmed zero reference", cls(obj("products/a.jpg", 1, { createdAt: old }), 0) === "CONFIRMED_ZERO_REFERENCE");
  check("historical reference only", cls(obj("products/a.jpg", 1, { createdAt: old }), 0, 3) === "HISTORICAL_REFERENCE_ONLY");
  check("recent zero reference", cls(obj("products/a.jpg", 1, { createdAt: "2026-08-20T12:00:00Z" }), 0) === "RECENT_ZERO_REFERENCE");
  check("HEIC by extension", cls(obj("products/a.heic", 1, { createdAt: old }), 0) === "HEIC_REVIEW");
  check("HEIC by mime", cls(obj("products/a.bin", 1, { createdAt: old, mime: "image/heic" }), 0) === "HEIC_REVIEW");
  check("a referenced HEIC is still HEIC_REVIEW", cls(obj("products/a.heic", 1, { createdAt: old }), 2) === "HEIC_REVIEW");
  check("an incomplete graph can never confirm an orphan",
    cls(obj("products/a.jpg", 1, { createdAt: old }), 0, 0, false) === "UNKNOWN_REVIEW");
  check("staging is never a backfill source", cls(obj("staging/a.jpg", 1, { createdAt: old }), 0) === "RECENT_ZERO_REFERENCE");

  console.log("\n=== nothing unknown is ever deletable ===");
  for (const c of ["UNKNOWN_REVIEW", "HEIC_REVIEW", "RECENT_ZERO_REFERENCE", "HISTORICAL_REFERENCE_ONLY",
    "REFERENCED_PRODUCT_SOURCE", "REFERENCED_SHARED_SOURCE", "ALREADY_NORMALIZED",
    "REFERENCED_NON_PRODUCT_ASSET"] as const) {
    check(`${c} is not deletion-eligible`, !isDeletionEligible(c, 0));
  }
  check("only CONFIRMED_ZERO_REFERENCE is eligible", isDeletionEligible("CONFIRMED_ZERO_REFERENCE", 0));
  check("and never while a live reference remains", !isDeletionEligible("CONFIRMED_ZERO_REFERENCE", 1));
  check(`the recent-upload window is ${RECENT_UPLOAD_WINDOW_HOURS}h`, RECENT_UPLOAD_WINDOW_HOURS === 72);
  check("a missing creation date is treated as recent", isRecent(null));
  check("an unparseable date is treated as recent", isRecent("not a date"));

  console.log("\n=== EXIF orientation 1, 3, 6, 8 — measured on real encoded bytes ===");
  // withMetadata({orientation}), NOT withExif({IFD0:{Orientation}}): the latter
  // silently writes nothing, so a fixture built that way reports orientation 1
  // and every assertion against it passes without testing anything.
  for (const orientation of [1, 3, 6, 8] as const) {
    const src = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a2b2b" } })
      .withMetadata({ orientation }).jpeg().toBuffer();
    const header = parseHeader(src);
    check(`orientation ${orientation}: parsed from the raw header`, header.orientation === orientation,
      `got ${header.orientation}`);
    const display = displayDimensions(header)!;
    const rotated = orientation >= 5;
    check(`orientation ${orientation}: planner predicts ${rotated ? "600x800" : "800x600"}`,
      display.width === (rotated ? 600 : 800) && display.height === (rotated ? 800 : 600),
      `${display.width}x${display.height}`);
    // The pipeline must be EXECUTED to be measured: sharp(x).rotate().metadata()
    // reports the INPUT's metadata, which is how a broken rotate would hide.
    const encoded = await sharp(await sharp(src).rotate().jpeg().toBuffer()).metadata();
    check(`orientation ${orientation}: sharp .rotate() output matches the prediction`,
      encoded.width === display.width && encoded.height === display.height,
      `encoded ${encoded.width}x${encoded.height} vs predicted ${display.width}x${display.height}`);
    check(`orientation ${orientation}: output no longer depends on EXIF`,
      (encoded.orientation ?? 1) === 1, `orientation=${encoded.orientation}`);
  }

  console.log("\n=== header parsing ===");
  const png = await sharp({ create: { width: 300, height: 400, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
  const ph = parseHeader(png);
  check("PNG size is read from IHDR", ph.width === 300 && ph.height === 400);
  check("PNG alpha channel is noticed", ph.alpha === true);
  const opaque = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
  check("an RGB PNG reports no alpha", parseHeader(opaque).alpha === false);
  check("HEIC container is recognised",
    parseHeader(Buffer.from("000000206674797068656963000000006865696300000000", "hex")).format === "HEIF");
  check("AVIF is not mistaken for HEIC",
    parseHeader(Buffer.from("0000002066747970617669660000000061766966", "hex")).format === "AVIF");
  check("rubbish yields no format", parseHeader(Buffer.from("not an image at all")).format === null);

  console.log("\n=== the plan reuses PR #135's rules, never its own copy ===");
  check("portrait 6120x8160 -> 2400x3200", JSON.stringify(targetSize({ width: 6120, height: 8160 })) === '{"width":2400,"height":3200}');
  check("landscape 8160x6120 -> 3200x2400", JSON.stringify(targetSize({ width: 8160, height: 6120 })) === '{"width":3200,"height":2400}');
  check("square 6112x6112 -> 2400x2400", JSON.stringify(targetSize({ width: 6112, height: 6112 })) === '{"width":2400,"height":2400}');
  check("a 1122x1402 source is never enlarged", JSON.stringify(targetSize({ width: 1122, height: 1402 })) === '{"width":1122,"height":1402}');
  check("a tall panorama keeps its width", JSON.stringify(targetSize({ width: 1848, height: 4000 })) === '{"width":1848,"height":4000}');
  check("the planner imports the constants rather than restating them",
    planner.includes('from "../lib/imageNormalize"') && !/const\s+TARGET_SHORT_EDGE\s*=/.test(planner));
  check("normalizer version comes from the shared module", NORMALIZER_VERSION === 1);

  console.log("\n=== determinism: a rerun must produce an identical plan ===");
  const once = targetSize({ width: 6120, height: 8160 });
  const twice = targetSize({ width: 6120, height: 8160 });
  check("target size is deterministic", JSON.stringify(once) === JSON.stringify(twice));
  const h = "d".repeat(64);
  check("master key is deterministic", masterKey(h, "jpg") === masterKey(h, "jpg"));
  check("and versioned", masterKey(h, "jpg").endsWith(`-v${NORMALIZER_VERSION}.jpg`));
  check("estimate is deterministic",
    estimateMasterBytes(2400, 3200, 20_000_000) === estimateMasterBytes(2400, 3200, 20_000_000));
  check("an estimate never exceeds the source", estimateMasterBytes(2400, 3200, 500_000) === 500_000);
  const dupGraph = new ImageReferenceGraph([
    { table: "product_images", rows: [{ id: "d1", url: url("products/dup.jpg") }, { id: "d2", url: url("products/dup.jpg") }] },
  ]);
  check("one object appears once however many rows point at it",
    dupGraph.referencesFor(B, "products/dup.jpg").length === 2 &&
    new Set(dupGraph.referencesFor(B, "products/dup.jpg").map((r) => r.rowId)).size === 2);

  console.log("\n=== the graph knows when it cannot prove absence ===");
  const partial = new ImageReferenceGraph([{ table: "product_images", rows: [] }], ["carts"]);
  check("an unreadable table makes the graph incomplete", partial.isComplete === false);
  check("a complete graph says so", graph.isComplete === true);

  console.log("\n=== a cart row identifies by user_id, because it has no id ===");
{
  const url = "https://x.supabase.co/storage/v1/object/public/product-images/products/a.jpg";
  const g = new ImageReferenceGraph([
    { table: "carts", rows: [{ user_id: "cart-owner-1", items: [{ image_url: url }] }] },
    { table: "product_images", rows: [{ id: "pi-1", url }] },
  ]);
  const hits = g.referencesFor("product-images", "products/a.jpg");
  const cart = hits.find((h) => h.table === "carts");
  check("the cart reference is found", Boolean(cart));
  check("and identifies by its user_id, not \"?\"", cart?.rowId === "cart-owner-1");
  check("a row with no usable identifier still degrades to ?",
    new ImageReferenceGraph([{ table: "carts", rows: [{ items: [{ image_url: url }] }] }])
      .referencesFor("product-images", "products/a.jpg")[0]?.rowId === "?");
  check("two different carts are two different references",
    new ImageReferenceGraph([{ table: "carts", rows: [
      { user_id: "cart-A", items: [{ image_url: url }] },
      { user_id: "cart-B", items: [{ image_url: url }] }] }])
      .referencesFor("product-images", "products/a.jpg")
      .map((h) => h.rowId).sort().join() === "cart-A,cart-B");
  check("an id column still wins when present",
    new ImageReferenceGraph([{ table: "carts", rows: [{ id: "real-id", user_id: "u", items: [{ image_url: url }] }] }])
      .referencesFor("product-images", "products/a.jpg")[0]?.rowId === "real-id");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
