/**
 * Delivery-sized derivatives (lib/imageVariants, lib/imageDerivatives, 0071).
 *
 *   PG_HARNESS_DIR=<dir with embedded-postgres> npx --cache <cache> --yes tsx@4.19.2 scripts/image-derivatives.test.ts
 *
 * No network and no production: images are synthesised with sharp, storage and
 * the public GET are fakes, and the registry policies run on embedded Postgres
 * (skipped, and said so, when PG_HARNESS_DIR is not set).
 *
 * TEST TECHNIQUE, NOT TEST QUALITY. Nothing here downloads a real catalogue
 * photograph: every image property that matters (size, orientation, alpha,
 * colour profile, compressibility) is made on the spot.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
const BASE = "https://proj.supabase.co/storage/v1/object/public/product-images/";

import {
  DERIVATIVE_RECIPE,
  derivedKey,
  imageFor,
  isDerivedKey,
  isSafeSourceKey,
  publicObjectUrl,
  storageKeyFromPublicUrl,
  type ImageVariantMap,
} from "../lib/imageVariants";
import { attachImageVariants, keysForUrls, loadImageVariants, variantMapFromRows } from "../lib/imageVariantsRegistry";
import { buildDerivative, makeAndStoreDerivatives, usesAlpha, MIN_SAVING } from "../lib/imageDerivatives";
import { parseLimit, planBackfill, MAX_BATCH } from "../lib/imageDerivativeBackfill";
import { classifyObject, isDeletionEligible } from "../lib/imageReferences";
import { productImageUrl } from "../lib/seo";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function throws(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const master = `${BASE}products/abc123-v1.jpg`;
const d1080 = `${BASE}derived/products-abc123-v1-w1080-r1.jpg`;
const d1920 = `${BASE}derived/products-abc123-v1-w1920-r1.jpg`;

/* ───────────── selection ───────────── */
function selection() {
  console.log("selection (imageFor)");
  const both: ImageVariantMap = { [master]: { w1080: d1080, w1920: d1920 } };
  const only1080: ImageVariantMap = { [master]: { w1080: d1080 } };
  const only1920: ImageVariantMap = { [master]: { w1920: d1920 } };

  check("no map → master (card)", imageFor(master, "card", undefined) === master);
  check("no map → master (detail)", imageFor(master, "detail", null) === master);
  check("empty map → master", imageFor(master, "card", {}) === master);
  check("other photo's entry ignored", imageFor(master, "card", { [`${BASE}products/zzz.jpg`]: { w1080: d1080 } }) === master);
  check("both → card gets 1080", imageFor(master, "card", both) === d1080);
  check("both → detail gets 1920", imageFor(master, "detail", both) === d1920);
  check("only 1080 → card gets 1080", imageFor(master, "card", only1080) === d1080);
  check("only 1080 → detail keeps the MASTER (zoom never downgraded)", imageFor(master, "detail", only1080) === master);
  check("only 1920 → card gets 1920", imageFor(master, "card", only1920) === d1920);
  check("only 1920 → detail gets 1920", imageFor(master, "detail", only1920) === d1920);
  check("empty-string entry ignored", imageFor(master, "card", { [master]: { w1080: "" } }) === master);
}

/* ───────────── keys and URLs ───────────── */
function keys() {
  console.log("keys and URLs");
  check("public URL → key", storageKeyFromPublicUrl(master) === "products/abc123-v1.jpg");
  check("legacy uuid png → key", storageKeyFromPublicUrl(`${BASE}products/0c359a46-7162-450b-8896-3c225a9c13b6.png`) === "products/0c359a46-7162-450b-8896-3c225a9c13b6.png");
  for (const [label, url] of [
    ["other host", "https://evil.supabase.co/storage/v1/object/public/product-images/products/a.jpg"],
    ["http", "http://proj.supabase.co/storage/v1/object/public/product-images/products/a.jpg"],
    ["query", `${master}?x=1`],
    ["fragment", `${master}#x`],
    ["other bucket", "https://proj.supabase.co/storage/v1/object/public/style-photos/products/a.jpg"],
    ["signed route", "https://proj.supabase.co/storage/v1/object/sign/product-images/products/a.jpg"],
    ["traversal", `${BASE}products/../secret.jpg`],
    ["encoded", `${BASE}products/a%2Fb.jpg`],
    ["nested", `${BASE}products/a/b.jpg`],
    ["staging", `${BASE}staging/a.jpg`],
    ["not a url", "not a url"],
  ] as const) {
    check(`refused: ${label}`, storageKeyFromPublicUrl(url) === null);
  }
  check("derivedKey shape", derivedKey("products/abc123-v1.jpg", "w1080", "jpg") === "derived/products-abc123-v1-w1080-r1.jpg");
  check("derivedKey webp", derivedKey("products/abc.png", "w1920", "webp") === "derived/products-abc-w1920-r1.webp");
  check("derived keys from two folders never collide",
    derivedKey("products/x.jpg", "w1080", "jpg") !== derivedKey("journal/x.jpg", "w1080", "jpg"));
  check("isDerivedKey true", isDerivedKey(derivedKey("products/abc123-v1.jpg", "w1920", "jpg")));
  check("isDerivedKey false for a master", !isDerivedKey("products/abc123-v1.jpg"));
  check("isSafeSourceKey refuses derived/ (no derivative of a derivative)", !isSafeSourceKey("derived/products-a-w1080-r1.jpg"));
  return Promise.all([
    throws(() => derivedKey("../etc/passwd", "w1080", "jpg")).then((m) => check("derivedKey refuses traversal", m !== "")),
    throws(() => derivedKey("products/a b.jpg", "w1080", "jpg")).then((m) => check("derivedKey refuses spaces", m !== "")),
  ]).then(() => {
    // The migration's CHECK and lib/seo's recogniser accept exactly what derivedKey builds.
    const sql = readFileSync("supabase/migrations/0071_image_derivatives.sql", "utf8");
    const derivedCheck = /derived_path ~ '([^']+)'/.exec(sql)?.[1];
    check("0071 derived_path CHECK found", Boolean(derivedCheck));
    if (derivedCheck) {
      const re = new RegExp(derivedCheck);
      check("0071 accepts a built 1080 key", re.test(derivedKey("products/abc123-v1.jpg", "w1080", "jpg")));
      check("0071 accepts a built webp key", re.test(derivedKey("products/0c35-ab.png", "w1920", "webp")));
      check("0071 refuses a master key", !re.test("products/abc123-v1.jpg"));
    }
    const sourceCheck = /source_path ~ '([^']+)'/.exec(sql)?.[1];
    if (sourceCheck) {
      const re = new RegExp(sourceCheck);
      check("0071 accepts a hash master", re.test("products/abc123-v1.jpg"));
      check("0071 accepts a legacy uuid png", re.test("products/0c359a46-7162-450b-8896-3c225a9c13b6.png"));
      check("0071 refuses a derived source", !re.test("derived/products-a-w1080-r1.jpg"));
    }
    // SEO: a derived URL goes through the optimizer exactly like a master.
    const ld = productImageUrl(d1920, "jsonLd");
    check("JSON-LD names /_next/image for a derived copy", ld === `https://www.thewovenne.com/_next/image?url=${encodeURIComponent(d1920)}&w=1920&q=75`, ld);
    check("og names /_next/image for a derived copy", productImageUrl(d1920, "openGraph").includes("/_next/image?url=") );
    check("JSON-LD still rewrites a master", productImageUrl(master, "jsonLd").startsWith("https://www.thewovenne.com/_next/image?url="));
    check("a look-alike derived name is NOT rewritten",
      productImageUrl(`${BASE}derived/products-a-w999-r1.jpg`, "jsonLd") === `${BASE}derived/products-a-w999-r1.jpg`);
    check("publicObjectUrl", publicObjectUrl("derived/x-w1080-r1.jpg") === `${BASE}derived/x-w1080-r1.jpg`);
  });
}

/* ───────────── registry read ───────────── */
function fakeRegistryClient(rows: unknown[] | Error, seen: { calls: number; filters: unknown[] } = { calls: 0, filters: [] }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = (col: string, v: unknown) => (seen.filters.push([col, v]), chain);
  chain.in = (col: string, v: unknown) => {
    seen.filters.push([col, v]);
    seen.calls += 1;
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ data: rows, error: null });
  };
  return { from: () => chain } as never;
}

async function registry() {
  console.log("registry read");
  const byKey = keysForUrls([master, master, `${BASE}products/zzz.png`, "https://elsewhere.test/a.jpg"]);
  check("keysForUrls dedupes and drops foreign URLs", byKey.size === 2 && byKey.get("products/abc123-v1.jpg")!.length === 1);
  const map = variantMapFromRows(byKey, [
    { source_path: "products/abc123-v1.jpg", tier: "w1080", derived_path: "derived/products-abc123-v1-w1080-r1.jpg" },
    { source_path: "products/abc123-v1.jpg", tier: "w1920", derived_path: "derived/products-abc123-v1-w1920-r1.jpg" },
    { source_path: "products/unrelated.jpg", tier: "w1080", derived_path: "derived/products-unrelated-w1080-r1.jpg" },
  ]);
  check("map keyed by master URL", map[master]?.w1080 === d1080 && map[master]?.w1920 === d1920);
  check("unrelated rows dropped", Object.keys(map).length === 1);

  const seen = { calls: 0, filters: [] as unknown[] };
  const ok = await loadImageVariants(fakeRegistryClient([
    { source_path: "products/abc123-v1.jpg", tier: "w1080", derived_path: "derived/products-abc123-v1-w1080-r1.jpg" },
  ], seen), [master]);
  check("loadImageVariants reads one query", seen.calls === 1 && ok[master]?.w1080 === d1080);
  check("reads only the current recipe", JSON.stringify(seen.filters).includes(`["recipe",${DERIVATIVE_RECIPE}]`));
  check("reads only ready rows", JSON.stringify(seen.filters).includes(`["status","ready"]`));

  const origWarn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };
  const failedRead = await loadImageVariants(fakeRegistryClient(new Error('relation "public.image_derivatives" does not exist')), [master]);
  const failedAgain = await loadImageVariants(fakeRegistryClient(new Error("boom")), [master]);
  console.warn = origWarn;
  check("missing table → no variants (fails open to masters)", Object.keys(failedRead).length === 0 && Object.keys(failedAgain).length === 0);
  check("warned once per process, not per render", warnings === 1, `warnings=${warnings}`);

  const none = { calls: 0, filters: [] as unknown[] };
  await loadImageVariants(fakeRegistryClient([], none), ["https://elsewhere.test/a.jpg"]);
  check("no recognisable URLs → no query at all", none.calls === 0);

  const products = [
    { id: "a", image_url: master, images: [master, `${BASE}products/second.jpg`] },
    { id: "b", image_url: `${BASE}products/other.jpg`, images: [`${BASE}products/other.jpg`] },
  ];
  const attached = await attachImageVariants(products as never[], fakeRegistryClient([
    { source_path: "products/abc123-v1.jpg", tier: "w1080", derived_path: "derived/products-abc123-v1-w1080-r1.jpg" },
  ]));
  const [a, b] = attached as { imageVariants?: ImageVariantMap }[];
  check("product gets only its own slice", Object.keys(a.imageVariants ?? {}).length === 1 && a.imageVariants?.[master]?.w1080 === d1080);
  check("product without derivatives carries NO new key (payload unchanged)", !("imageVariants" in b));
  const untouched = await attachImageVariants(products as never[], fakeRegistryClient(new Error("down")));
  check("registry down → products returned as they were", untouched === (products as unknown));
}

/* ───────────── encoder ───────────── */
async function photo(width: number, height: number, opts: { orientation?: number; alpha?: boolean; flat?: boolean; format?: "jpeg" | "png" } = {}) {
  const channels = opts.alpha ? 4 : 3;
  const data = Buffer.alloc(width * height * channels);
  // Noisy, textile-like content so JPEG behaves as it does on cloth; or flat.
  for (let i = 0; i < data.length; i += channels) {
    const p = i / channels;
    const x = p % width, y = Math.floor(p / width);
    const v = opts.flat ? 180 : (Math.sin(x / 3) * 40 + Math.cos(y / 2) * 40 + ((x * 7919 + y * 104729) % 61)) | 0;
    data[i] = 120 + v; data[i + 1] = 60 + (v >> 1); data[i + 2] = 140 - (v >> 2);
    if (opts.alpha) data[i + 3] = x < width / 2 ? 255 : 0;
  }
  let img = sharp(data, { raw: { width, height, channels } });
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return opts.format === "png" || opts.alpha ? img.png().toBuffer() : img.jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
}

async function encoder() {
  console.log("encoder");
  const portrait = await photo(2400, 3200);
  const d = await buildDerivative(portrait, "w1080", { hasRealAlpha: false });
  check("portrait → 1080 ready", d.status === "ready");
  if (d.status === "ready") {
    check("1080 width, aspect kept", d.width === 1080 && d.height === 1440, `${d.width}x${d.height}`);
    check("JPEG", d.ext === "jpg" && d.contentType === "image/jpeg");
    const meta = await sharp(d.buffer).metadata();
    check("4:4:4 chroma", meta.chromaSubsampling === "4:4:4", String(meta.chromaSubsampling));
    check("sRGB profile attached", Boolean(meta.icc) && meta.space === "srgb");
    check("progressive", meta.isProgressive === true);
    check("md5 is of the bytes", d.md5 === createHash("md5").update(d.buffer).digest("hex"));
    check("smaller than the source", d.buffer.byteLength < portrait.byteLength);
  }
  const d19 = await buildDerivative(portrait, "w1920", { hasRealAlpha: false });
  check("portrait → 1920 is 1920×2560", d19.status === "ready" && d19.width === 1920 && d19.height === 2560);
  const again = await buildDerivative(portrait, "w1080", { hasRealAlpha: false });
  check("deterministic: same source → same bytes", d.status === "ready" && again.status === "ready" && d.md5 === again.md5);

  const narrow = await buildDerivative(await photo(900, 1200), "w1080", { hasRealAlpha: false });
  check("source narrower than tier → not_needed (never enlarged)", narrow.status === "not_needed" && narrow.reason === "source_narrow");
  const mid = await photo(1500, 2000);
  check("1500 source: 1080 made, 1920 not needed",
    (await buildDerivative(mid, "w1080", { hasRealAlpha: false })).status === "ready" &&
    (await buildDerivative(mid, "w1920", { hasRealAlpha: false })).status === "not_needed");

  // A source already small for its size (saved at low quality): a q88 copy
  // would not save MIN_SAVING, so it is not worth a second object.
  const flat = await sharp(await photo(2400, 3200)).jpeg({ quality: 25 }).toBuffer();
  const flatD = await buildDerivative(flat, "w1920", { hasRealAlpha: false });
  check(`no meaningful saving (<${MIN_SAVING * 100}%) → not_needed`, flatD.status === "not_needed" && flatD.reason === "no_saving",
    `${flatD.status} src=${flat.byteLength}`);

  // EXIF orientation 6: stored landscape, displayed portrait.
  const rotatedSrc = await photo(3200, 2400, { orientation: 6 });
  const r = await buildDerivative(rotatedSrc, "w1080", { hasRealAlpha: false });
  check("EXIF 6 → baked upright portrait", r.status === "ready" && r.width === 1080 && r.height === 1440, r.status === "ready" ? `${r.width}x${r.height}` : r.status);
  if (r.status === "ready") check("no orientation tag left", ((await sharp(r.buffer).metadata()).orientation ?? 1) === 1);

  const alphaSrc = await photo(2400, 3200, { alpha: true });
  check("real alpha detected", await usesAlpha(alphaSrc));
  check("opaque PNG is not 'alpha'", !(await usesAlpha(await photo(1200, 1600, { format: "png" }))));
  const a = await buildDerivative(alphaSrc, "w1080", { hasRealAlpha: true });
  if (a.status === "ready") {
    const m = await sharp(a.buffer).metadata();
    check("alpha → WebP keeping alpha", a.ext === "webp" && m.format === "webp" && m.hasAlpha === true);
  } else {
    check("alpha → WebP keeping alpha", false, a.status);
  }
}

/* ───────────── store, verify, register ───────────── */
function fakeWorld(opts: { failUploadFor?: string; registryError?: string; corruptExisting?: string } = {}) {
  const objects = new Map<string, Buffer>();
  const uploads: { key: string; options: Record<string, unknown> }[] = [];
  const registryCalls: { rows: unknown[]; options: unknown }[] = [];
  const storage = {
    storage: {
      from: (bucket: string) => ({
        upload: async (key: string, body: Buffer, options: Record<string, unknown>) => {
          if (bucket !== "product-images") throw new Error("wrong bucket");
          uploads.push({ key, options });
          if (opts.failUploadFor && key.includes(opts.failUploadFor)) return { error: { message: "storage down", statusCode: "500" } };
          if (objects.has(key)) return { error: { message: "The resource already exists", statusCode: "409" } };
          objects.set(key, body);
          return { error: null };
        },
      }),
    },
  };
  const registry = {
    from: (table: string) => ({
      upsert: async (rows: unknown[], options: unknown) => {
        if (table !== "image_derivatives") throw new Error("wrong table");
        registryCalls.push({ rows, options });
        return { error: opts.registryError ? { message: opts.registryError } : null };
      },
    }),
  };
  const fetchImpl = (async (url: string) => {
    const key = url.replace(BASE, "");
    let body = objects.get(key);
    if (!body) return new Response("not found", { status: 400 });
    if (opts.corruptExisting && key.includes(opts.corruptExisting)) body = Buffer.concat([body, Buffer.from("x")]);
    const md5 = createHash("md5").update(body).digest("hex");
    return new Response(new Uint8Array(body.subarray(0, 1)), {
      status: 206,
      headers: {
        "content-range": `bytes 0-0/${body.byteLength}`,
        etag: `"${md5}"`,
        "cache-control": "public, max-age=31536000",
        "x-robots-tag": "all",
      },
    });
  }) as unknown as typeof fetch;
  return { objects, uploads, registryCalls, deps: { storage: storage as never, registry: registry as never, fetchImpl } };
}

async function storeAndRegister() {
  console.log("store, verify, register");
  const src = await photo(2400, 3200);
  const key = "products/abc123-v1.jpg";

  const w = fakeWorld();
  const r1 = await makeAndStoreDerivatives(key, src, w.deps);
  check("both tiers ready → complete + registered", r1.status === "complete" && r1.registered, JSON.stringify(r1.tiers));
  check("two new objects under derived/", [...w.objects.keys()].every((k) => k.startsWith("derived/")) && w.objects.size === 2);
  check("uploads are upsert:false with a year's cache and robots all",
    w.uploads.every((u) => u.options.upsert === false && u.options.cacheControl === "31536000" &&
      (u.options.headers as Record<string, string>)["x-robots-tag"] === "all" &&
      (u.options.headers as Record<string, string>)["cache-control"] === "max-age=31536000"));
  check("content type is image/jpeg", w.uploads.every((u) => u.options.contentType === "image/jpeg"));
  const rows = w.registryCalls[0]?.rows as Record<string, unknown>[];
  check("registry rows: 2, recipe, ready, source bytes",
    rows?.length === 2 && rows.every((x) => x.recipe === DERIVATIVE_RECIPE && x.status === "ready" && x.source_bytes === src.byteLength));
  check("registry insert is ON CONFLICT DO NOTHING",
    JSON.stringify(w.registryCalls[0]?.options) === JSON.stringify({ onConflict: "source_path,tier,recipe", ignoreDuplicates: true }));
  check("master never uploaded or touched", w.uploads.every((u) => u.key !== key));

  // RETRY: same source again → duplicates proven by MD5, no new objects, same rows.
  const r2 = await makeAndStoreDerivatives(key, src, w.deps);
  check("retry → complete, every tier a verified duplicate",
    r2.status === "complete" && r2.tiers.every((t) => t.status === "ready" && t.duplicate), JSON.stringify(r2.tiers));
  check("retry created no new objects", w.objects.size === 2);
  check("retry registry rows identical", JSON.stringify(w.registryCalls[1].rows) === JSON.stringify(w.registryCalls[0].rows));

  // An existing object that is NOT these bytes is never accepted.
  const bad = fakeWorld({ corruptExisting: "w1080" });
  await makeAndStoreDerivatives(key, src, bad.deps); // first run creates (verification sees corrupt length → fails)
  const r3 = await makeAndStoreDerivatives(key, src, bad.deps);
  const t1080 = r3.tiers.find((t) => t.tier === "w1080");
  check("mismatched existing object → that tier failed", t1080?.status === "failed", JSON.stringify(t1080));
  check("…and is not registered", !(bad.registryCalls.at(-1)?.rows as Record<string, unknown>[]).some((x) => x.tier === "w1080"));

  // One tier's upload failing never stops the other.
  const half = fakeWorld({ failUploadFor: "w1920" });
  const r4 = await makeAndStoreDerivatives(key, src, half.deps);
  check("one upload fails → partial", r4.status === "partial");
  check("the good tier is still stored and registered",
    half.objects.size === 1 && (half.registryCalls[0].rows as Record<string, unknown>[]).map((x) => x.tier).join() === "w1080");

  // Registry failure is reported, not thrown; objects remain for the backfill to register.
  const noReg = fakeWorld({ registryError: 'relation "public.image_derivatives" does not exist' });
  const r5 = await makeAndStoreDerivatives(key, src, noReg.deps);
  check("registry failure → registered:false with reason, objects kept",
    r5.status === "complete" && !r5.registered && /does not exist/.test(r5.registryError ?? "") && noReg.objects.size === 2);

  // Narrow source: nothing uploaded, but the decision is registered so it is never re-made.
  const nw = fakeWorld();
  const r6 = await makeAndStoreDerivatives("products/small.jpg", await photo(800, 1000), nw.deps);
  check("narrow source → complete, no uploads, not_needed rows",
    r6.status === "complete" && nw.uploads.length === 0 &&
    (nw.registryCalls[0].rows as Record<string, unknown>[]).every((x) => x.status === "not_needed" && x.derived_path === null));

  // An undecodable source fails cleanly, touching nothing.
  const junk = fakeWorld();
  const r7 = await makeAndStoreDerivatives(key, Buffer.from("not an image"), junk.deps);
  check("undecodable source → failed, nothing stored", r7.status === "failed" && junk.objects.size === 0);
}

/* ───────────── backfill planning ───────────── */
async function backfill() {
  console.log("backfill planning");
  const objects = [
    { key: "products/a-v1.jpg", bytes: 3_000_000, mime: "image/jpeg" },
    { key: "products/b-v1.jpg", bytes: 4_000_000, mime: "image/jpeg" },
    { key: "products/c.heic", bytes: 3_500_000, mime: "image/heic" },
    { key: "products/d-v1.jpg", bytes: 2_000_000, mime: "image/jpeg" },
  ];
  const urls = [
    `${BASE}products/a-v1.jpg`, `${BASE}products/a-v1.jpg`, `${BASE}products/b-v1.jpg`,
    `${BASE}products/c.heic`, `${BASE}products/gone.jpg`, `${BASE}products/d-v1.jpg`,
    "https://placehold.co/600x800",
  ];
  const registry = [
    { source_path: "products/a-v1.jpg", tier: "w1080" as const, recipe: DERIVATIVE_RECIPE, status: "ready" as const },
    { source_path: "products/a-v1.jpg", tier: "w1920" as const, recipe: DERIVATIVE_RECIPE, status: "not_needed" as const },
    { source_path: "products/b-v1.jpg", tier: "w1080" as const, recipe: DERIVATIVE_RECIPE, status: "ready" as const },
    // An OLD recipe's rows do not count as done.
    { source_path: "products/d-v1.jpg", tier: "w1080" as const, recipe: DERIVATIVE_RECIPE + 1, status: "ready" as const },
  ];
  const plan = planBackfill({ referencedUrls: urls, objects, registry });
  const by = Object.fromEntries(plan.items.map((i) => [i.sourceKey, i]));
  check("fully registered source → done (no download)", by["products/a-v1.jpg"].action === "done");
  check("half registered → build, only the missing tier", by["products/b-v1.jpg"].action === "build" && by["products/b-v1.jpg"].pendingTiers.join() === "w1920");
  check("other recipe's rows ignored", by["products/d-v1.jpg"].pendingTiers.length === 2);
  check("HEIC → unsupported", by["products/c.heic"]?.action === "unsupported" || !by["products/c.heic"]);
  check("referenced but absent → missing_source", by["products/gone.jpg"].action === "missing_source");
  check("foreign URL listed as unrecognised", plan.unrecognised.includes("https://placehold.co/600x800"));
  check("reference counts", by["products/a-v1.jpg"].references === 2);
  check("download estimate = selected sources", plan.downloadBytes === 4_000_000 + 2_000_000);
  check("limit bounds the batch", planBackfill({ referencedUrls: urls, objects, registry, limit: 1 }).selected.length === 1);
  check("--only narrows", planBackfill({ referencedUrls: urls, objects, registry, only: ["products/d-v1.jpg"] }).selected.map((i) => i.sourceKey).join() === "products/d-v1.jpg");
  check("--only a done source selects nothing", planBackfill({ referencedUrls: urls, objects, registry, only: ["products/a-v1.jpg"] }).selected.length === 0);
  check("--only an unknown source refuses", (await throws(() => planBackfill({ referencedUrls: urls, objects, registry, only: ["products/nope.jpg"] }))) !== "");
  check("parseLimit default 10", parseLimit(undefined) === 10);
  for (const bad of ["0", "-1", "1.5", "x", String(MAX_BATCH + 1)]) {
    check(`parseLimit refuses ${bad}`, (await throws(() => parseLimit(bad))) !== "");
  }
  // Second run after everything is registered: nothing selected.
  const all = urls.filter((u) => u.includes("/products/") && !u.includes("gone") && !u.includes("heic"))
    .map((u) => u.replace(BASE, ""));
  const fullRegistry = [...new Set(all)].flatMap((k) => (["w1080", "w1920"] as const).map((tier) => ({ source_path: k, tier, recipe: DERIVATIVE_RECIPE, status: "ready" as const })));
  check("resumed run with everything registered selects nothing", planBackfill({ referencedUrls: urls, objects, registry: fullRegistry }).selected.length === 0);
}

/* ───────────── cleanup tooling never deletes copies ───────────── */
function cleanupSafety() {
  console.log("cleanup tooling");
  const cls = classifyObject({
    object: { key: "derived/products-abc-v1-w1080-r1.jpg", bytes: 500_000, mime: "image/jpeg", createdAt: "2020-01-01T00:00:00Z" } as never,
    liveReferences: 0,
    historicalReferences: 0,
    graphIsComplete: true,
  });
  check("unreferenced derived copy → DERIVED_DELIVERY_COPY", cls === "DERIVED_DELIVERY_COPY", cls);
  check("…never deletion-eligible", !isDeletionEligible(cls, 0));
}

/* ───────────── wiring (source) ───────────── */
function wiring() {
  console.log("wiring");
  const src = (p: string) => readFileSync(p, "utf8");
  const card = src("components/shop/ProductCard.tsx");
  const gallery = src("components/product/ImageGallery.tsx");
  const viewer = src("components/product/ImageViewer.tsx");
  const detail = src("components/product/ProductDetail.tsx");
  const cartItem = src("components/cart/CartItem.tsx");
  const deliver = src("components/ui/DeliveryImage.tsx");
  const noBareImage = (s: string) => !/<Image\s/.test(s) && !/from "next\/image"/.test(s);

  check("card: no bare next/image", noBareImage(card));
  check("card: every photo is use=card with the product's map", (card.match(/use="card"/g) ?? []).length === 2 && (card.match(/variants=\{product\.imageVariants\}/g) ?? []).length === 2);
  check("card: CARD_SIZES unchanged", card.includes('"(max-width: 639px) 50vw, (max-width: 1023px) 33vw, (max-width: 1279px) 25vw, 272px"'));
  check("card: extra photos still mount on demand (hover stays lazy)", card.includes("images.slice(1, mounted + 1)"));
  check("card: first photo keeps fold priority/eager rules", card.includes('priority={fold === "priority"}') && card.includes('loading={fold === "visible" ? "eager" : undefined}'));
  check("gallery: no bare next/image", noBareImage(gallery));
  check("gallery frame use=detail, thumbnails use=card", /use="detail"[\s\S]*sizes=\{PDP_FRAME_SIZES\}/.test(gallery) && /use="card"[\s\S]*sizes="120px"/.test(gallery));
  check("gallery: cover alone is priority", gallery.includes("priority={i === 0}"));
  check("gallery passes the map to the viewer", /baseSizes=\{PDP_FRAME_SIZES\}\s*variants=\{variants\}/.test(gallery));
  check("viewer: no bare next/image; both layers use=detail", noBareImage(viewer) && (viewer.match(/use="detail"/g) ?? []).length === 2);
  check("viewer: zoom layer keeps viewerSizes and onLoad", viewer.includes("sizes={viewerSizes()}") && viewer.includes("naturalWidth"));
  check("JSON-LD names the detail file", detail.includes('productImageUrl(imageFor(src, "detail", product.imageVariants), "jsonLd")'));
  check("gallery gets the product's map", detail.includes("variants={product.imageVariants}"));
  for (const p of ["app/(storefront)/in/product/[slug]/page.tsx", "app/(storefront)/in/[slug]/[child]/[product]/page.tsx"]) {
    check(`og:image uses the detail file (${p.split("/").slice(-2).join("/")})`, src(p).includes('productImageUrl(imageFor(product.image_url, "detail", product.imageVariants), "openGraph")'));
  }
  check("cart keeps the stored master (orders/emails unaffected)", !cartItem.includes("imageFor") && !cartItem.includes("DeliveryImage"));
  check("DeliveryImage falls back to the master on error", deliver.includes("failedFor === src ? src : preferred") && deliver.includes("onError"));
  check("DeliveryImage passes sizes/priority/loading through untouched", deliver.includes("{...rest}"));
  check("imageVariants is client-safe (no sharp, no supabase)", !/sharp|supabase-js|node:/.test(src("lib/imageVariants.ts").replace(/\/\*[\s\S]*?\*\//g, "")));
  const products = src("lib/products.ts");
  check("data layer attaches variants in finish and finishListing", (products.match(/attachImageVariants\(/g) ?? []).length === 3);
  check("listing type carries imageVariants", src("lib/types.ts").includes('| "imageVariants"'));
  const route = src("app/api/admin/images/normalize/route.ts");
  check("upload route: derivatives after the master is proven, before staged removal",
    route.indexOf("verifyMasterDelivery(publicUrl") < route.indexOf("makeAndStoreDerivatives(") &&
    route.indexOf("makeAndStoreDerivatives(") < route.indexOf(".remove([staged])"));
  check("upload route: uses the admin session, never the service role", !route.includes("SERVICE_ROLE") && route.includes("storage: supabase") && route.includes("registry: supabase"));
  check("upload route: reports derivatives in the response", route.includes("derivatives: {"));
  check("admin shows an incomplete-copies note", src("components/admin/ProductModal.tsx").includes("smaller display copies"));
}

/* ───────────── 0071 on Postgres ───────────── */
async function database() {
  console.log("0071 on Postgres");
  if (!process.env.PG_HARNESS_DIR) {
    console.log("  SKIPPED — PG_HARNESS_DIR not set");
    return;
  }
  const { startEngine, asRoot, asUser, asAdmin, asService, makeAdmin, failure } = await import("./pg-world");
  const engine = await startEngine();
  if (!engine) {
    console.log("  SKIPPED — embedded-postgres not loadable");
    return;
  }
  console.log(`  (${engine.version.split(",")[0]})`);
  try {
    await engine.database("deriv");
    const c = await engine.connect("deriv");
    const adminId = await makeAdmin(c);
    await asRoot(c);
    const customerId = (await c.query("insert into auth.users (email) values ('c@example.test') returning id")).rows[0].id as string;
    const row = (tier: string, path: string | null) =>
      path
        ? [`products/abc-v1.jpg`, tier, 1, "ready", path, 1080, 1440, 500000, "0".repeat(32), 3000000]
        : [`products/abc-v1.jpg`, tier, 1, "not_needed", null, null, null, null, null, 3000000];
    const insert = (vals: unknown[]) =>
      c.query(
        `insert into public.image_derivatives (source_path, tier, recipe, status, derived_path, width, height, bytes, md5, source_bytes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, vals);

    await c.query("set role anon");
    check("anon cannot insert", (await failure(() => insert(row("w1080", "derived/products-abc-v1-w1080-r1.jpg")))) !== "");
    await asUser(c, customerId, "aal1");
    check("a customer cannot insert", (await failure(() => insert(row("w1080", "derived/products-abc-v1-w1080-r1.jpg")))) !== "");
    await asAdmin(c, adminId);
    check("an admin (aal2, live session) can insert", (await failure(() => insert(row("w1080", "derived/products-abc-v1-w1080-r1.jpg")))) === "");
    check("admin cannot update", (await failure(() => c.query("update public.image_derivatives set bytes = 1"))) !== "");
    check("admin cannot delete", (await failure(() => c.query("delete from public.image_derivatives"))) !== "");
    check("duplicate key + ON CONFLICT DO NOTHING is fine",
      (await failure(() => c.query(`insert into public.image_derivatives (source_path, tier, recipe, status, derived_path, width, height, bytes, md5, source_bytes)
        values ('products/abc-v1.jpg','w1080',1,'ready','derived/products-abc-v1-w1080-r1.jpg',1080,1440,500000,'${"0".repeat(32)}',3000000)
        on conflict (source_path, tier, recipe) do nothing`))) === "");
    await asService(c);
    check("service role can insert (backfill)", (await failure(() => insert(row("w1920", null)))) === "");
    check("service role cannot update", (await failure(() => c.query("update public.image_derivatives set bytes = 1"))) !== "");
    await c.query("set role anon");
    const visible = (await c.query("select tier, status from public.image_derivatives order by tier")).rows;
    check("anon reads the registry", visible.length === 2, JSON.stringify(visible));
    await asRoot(c);
    check("ready without file refused", (await failure(() => insert(["products/x.jpg", "w1080", 1, "ready", null, null, null, null, null, 1]))) !== "");
    check("not_needed with file refused", (await failure(() => insert(["products/x.jpg", "w1080", 1, "not_needed", "derived/products-x-w1080-r1.jpg", 1, 1, 1, "0".repeat(32), 1]))) !== "");
    check("bad tier refused", (await failure(() => insert(["products/x.jpg", "w640", 1, "not_needed", null, null, null, null, null, 1]))) !== "");
    check("traversal source refused", (await failure(() => insert(["products/../x.jpg", "w1080", 1, "not_needed", null, null, null, null, null, 1]))) !== "");
    check("derived path outside derived/ refused", (await failure(() => insert(["products/y.jpg", "w1080", 1, "ready", "products/y-w1080-r1.jpg", 1, 1, 1, "0".repeat(32), 1]))) !== "");
    const rls = (await c.query("select relrowsecurity from pg_class where oid = 'public.image_derivatives'::regclass")).rows[0].relrowsecurity;
    check("RLS on", rls === true);
    await c.end();
  } finally {
    await engine.stop();
  }
}

(async () => {
  selection();
  await keys();
  await registry();
  await encoder();
  await storeAndRegister();
  await backfill();
  cleanupSafety();
  wiring();
  await database();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
