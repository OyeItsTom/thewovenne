/**
 * The product-image normalization pipeline.
 *
 * Three kinds of check, and they are not equally strong — worth saying which is
 * which. The RULES are executed: every limit, every path defence and every
 * dimension decision is a pure function and is called here with real inputs.
 * The IMAGE CORRECTNESS checks are executed too, against fixtures built with
 * sharp so they need no network and no bucket: orientation, colour, dimensions
 * and alpha are measured on actual encoded bytes. The TRANSACTION ORDER is a
 * source contract — the route's storage and database calls cannot be driven
 * from here without a session and a bucket, so what is guarded is the ordering
 * that makes the pipeline safe, because that is the line an edit would move.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  ImageRejected,
  JPEG_MASTER,
  MASTER_CACHE_CONTROL,
  MAX_INPUT_BYTES,
  MAX_INPUT_PIXELS,
  MAX_LONG_EDGE,
  MIN_EDGE,
  NORMALIZER_VERSION,
  STAGING_CACHE_CONTROL,
  TARGET_SHORT_EDGE,
  assertAcceptedFormat,
  assertUsableBytes,
  assertUsableSource,
  masterEncoding,
  masterKey,
  needsResize,
  sniffFormat,
  stagingKey,
  targetSize,
} from "../lib/imageNormalize";

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
function refuses(name: string, fn: () => unknown, reason?: string) {
  try {
    fn();
    check(name, false, "it was accepted");
  } catch (e) {
    const ok = e instanceof ImageRejected && (!reason || e.reason === reason);
    check(name, ok, e instanceof ImageRejected ? `reason=${e.reason}` : String(e));
  }
}

const route = readFileSync("app/api/admin/images/normalize/route.ts", "utf8");
const storage = readFileSync("lib/storage.ts", "utf8");
const modal = readFileSync("components/admin/ProductModal.tsx", "utf8");
const nextConfig = readFileSync("next.config.mjs", "utf8");

async function main() {
  console.log("\n=== authorisation ===");
  check("admin is checked with the project's own is_admin()", route.includes('supabase.rpc("is_admin")'));
  check("a non-admin gets 404, not 403", route.includes('isAdmin !== true) return new NextResponse("Not found", { status: 404 })'));
  check("the check runs BEFORE the body is read",
    route.indexOf('rpc("is_admin")') < route.indexOf("request.json()"));
  check("and before any object is downloaded",
    route.indexOf('rpc("is_admin")') < route.indexOf(".download("));
  check("and before sharp decodes anything",
    route.indexOf('rpc("is_admin")') < route.indexOf("sharp("));
  check("the session comes from the server, not the caller", route.includes("createRSCClient()"));
  check("no client-supplied user id is trusted", !/userId|user_id|isAdmin\s*[:=]\s*body/.test(route));
  check("the route is Node runtime", route.includes('export const runtime = "nodejs"'));

  console.log("\n=== staging path security ===");
  const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  check("a valid id and extension build a staging key", stagingKey(id, "jpg") === `staging/${id}.jpg`);
  check("the extension is lower-cased", stagingKey(id, "JPG") === `staging/${id}.jpg`);
  check("a leading dot is tolerated", stagingKey(id, ".png") === `staging/${id}.png`);
  refuses("traversal in the id is refused", () => stagingKey("../products/secret", "jpg"), "bad_staging_id");
  refuses("encoded traversal is refused", () => stagingKey("%2e%2e%2fproducts", "jpg"), "bad_staging_id");
  refuses("an absolute path is refused", () => stagingKey("/etc/passwd", "jpg"), "bad_staging_id");
  refuses("a master key is refused", () => stagingKey("products/abc", "jpg"), "bad_staging_id");
  refuses("another prefix is refused", () => stagingKey("style-photos/x", "jpg"), "bad_staging_id");
  refuses("an external URL is refused", () => stagingKey("https://evil.test/x.jpg", "jpg"), "bad_staging_id");
  refuses("traversal in the extension is refused", () => stagingKey(id, "../jpg"), "bad_staging_ext");
  refuses("an unknown extension is refused", () => stagingKey(id, "svg"), "bad_staging_ext");
  refuses("an empty id is refused", () => stagingKey("", "jpg"), "bad_staging_id");
  check("every key produced starts with the staging prefix",
    ["jpg", "jpeg", "png", "webp", "avif", "gif"].every((e) => stagingKey(id, e).startsWith("staging/")));
  check("the route never concatenates a caller path", !/body\.(path|key|url)/.test(route));
  check("the route never fetches a caller-supplied URL",
    !/fetch\(\s*body|fetch\(\s*[a-zA-Z]*[uU]rl\b/.test(route) || route.includes("verifyReadable(publicUrl)"));
  check("only stagingId and ext are accepted from the caller",
    route.includes("stagingId?: string") && route.includes("ext?: string"));

  console.log("\n=== container sniffing, not extensions ===");
  const jpeg = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#c2714f" } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 300, height: 400, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  const webp = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#1c1f3b" } }).webp().toBuffer();
  check("JPEG bytes are recognised", sniffFormat(jpeg) === "jpeg");
  check("PNG bytes are recognised", sniffFormat(png) === "png");
  check("WebP bytes are recognised", sniffFormat(webp) === "webp");
  check("HEIC is recognised specifically, so it can be explained",
    sniffFormat(Buffer.from("000000206674797068656963000000006865696300000000", "hex")) === "heif");
  check("AVIF is not mistaken for HEIC",
    sniffFormat(Buffer.from("0000002066747970617669660000000061766966", "hex")) === "avif");
  check("random bytes are not an image", sniffFormat(Buffer.from("not an image at all!!")) === null);
  check("a truncated header is not an image", sniffFormat(Buffer.from([0xff, 0xd8])) === null);
  refuses("HEIC is refused with a message about the phone", () => assertAcceptedFormat(
    Buffer.from("000000206674797068656963000000006865696300000000", "hex")), "heif_not_supported");
  refuses("an unknown container is refused", () => assertAcceptedFormat(Buffer.from("hello world xx")), "unknown_container");
  check("a JPEG renamed .png still sniffs as JPEG", sniffFormat(jpeg) === "jpeg");
  check("the route sniffs before decoding",
    route.indexOf("assertAcceptedFormat") < route.indexOf("sharp(source"));

  console.log("\n=== input limits ===");
  check("the byte ceiling is 40MB", Number(MAX_INPUT_BYTES) === 40 * 1024 * 1024);
  check("the pixel ceiling is 80MP", Number(MAX_INPUT_PIXELS) === 80_000_000);
  refuses("an empty file is refused", () => assertUsableBytes(0), "empty");
  refuses("an oversized file is refused", () => assertUsableBytes(MAX_INPUT_BYTES + 1), "too_many_bytes");
  check("a 27MB camera original is accepted", (() => { assertUsableBytes(27 * 1048576); return true; })());
  refuses("too many pixels is refused", () => assertUsableSource({ width: 12000, height: 9000 }), "too_many_pixels");
  check("a 50MP original is accepted", (() => { assertUsableSource({ width: 8160, height: 6120 }); return true; })());
  refuses("a tiny image is refused", () => assertUsableSource({ width: 120, height: 400 }), "too_small");
  check(`the floor is ${MIN_EDGE}px on the short side`, Number(MIN_EDGE) === 200);
  check("sharp is given the same pixel limit", route.includes("limitInputPixels: MAX_INPUT_PIXELS"));
  check("and told to fail on a malformed file", route.includes('failOn: "error"'));
  check("the browser refuses the obviously-too-large before uploading", storage.includes("MAX_UPLOAD_BYTES"));

  console.log("\n=== resize rules: the SHORT edge governs ===");
  check("the target short edge is 2400", Number(TARGET_SHORT_EDGE) === 2400);
  check("above the 1920 optimizer ceiling, with headroom", Number(TARGET_SHORT_EDGE) > 1920);
  const portrait = targetSize({ width: 6120, height: 8160 });
  check("a 50MP portrait becomes 2400x3200", portrait.width === 2400 && portrait.height === 3200, JSON.stringify(portrait));
  const landscape = targetSize({ width: 8160, height: 6120 });
  check("a 50MP landscape becomes 3200x2400", landscape.width === 3200 && landscape.height === 2400, JSON.stringify(landscape));
  const square = targetSize({ width: 6112, height: 6112 });
  check("a square becomes 2400x2400", square.width === 2400 && square.height === 2400);
  check("every resized master clears the 1920 ceiling on its short edge",
    [portrait, landscape, square].every((d) => Math.min(d.width, d.height) >= 1920));
  const panorama = targetSize({ width: 1848, height: 4000 });
  check("a tall panorama is left alone rather than cut down to its long edge",
    panorama.width === 1848 && panorama.height === 4000, JSON.stringify(panorama));
  check("the long-edge rail still bounds an extreme aspect",
    Math.max(...Object.values(targetSize({ width: 2400, height: 20000 }))) <= MAX_LONG_EDGE);
  const small = targetSize({ width: 1122, height: 1402 });
  check("a 1122px original is NEVER enlarged", small.width === 1122 && small.height === 1402);
  const small2 = targetSize({ width: 1448, height: 1086 });
  check("nor is a 1448x1086 one", small2.width === 1448 && small2.height === 1086);
  check("needsResize is honest about the big one", needsResize({ width: 6120, height: 8160 }));
  check("and about the small one", !needsResize({ width: 1122, height: 1402 }));
  refuses("a zero dimension is refused", () => targetSize({ width: 0, height: 10 }), "zero_dimension");

  console.log("\n=== the master's identity ===");
  const hashA = "a".repeat(64);
  check("the key is content-addressed", masterKey(hashA, "jpg") === `products/${"a".repeat(32)}-v${NORMALIZER_VERSION}.jpg`);
  check("the same source yields the same key — a retry is free",
    masterKey(hashA, "jpg") === masterKey(hashA, "jpg"));
  check("a different source yields a different key",
    masterKey(hashA, "jpg") !== masterKey("b".repeat(64), "jpg"));
  check("the pipeline version is in the name", masterKey(hashA, "jpg").includes(`-v${NORMALIZER_VERSION}.`));
  check("masters live under products/", masterKey(hashA, "jpg").startsWith("products/"));
  refuses("a bogus hash cannot name a master", () => masterKey("../evil", "jpg"), "bad_hash");
  check("the route derives the key from the SOURCE bytes", route.includes('createHash("sha256").update(source)'));
  check("upsert stays false", route.includes("upsert: false"));
  check("and a duplicate is treated as success, not an error", route.includes("!isDuplicate(uploadError)"));

  console.log("\n=== format: JPEG for photographs, lossless only for real alpha ===");
  check("no alpha means JPEG", masterEncoding(false).ext === "jpg");
  check("real alpha means lossless WebP, never a flatten", masterEncoding(true).ext === "webp");
  check("content types match", masterEncoding(false).contentType === "image/jpeg" && masterEncoding(true).contentType === "image/webp");
  check("quality is 92", Number(JPEG_MASTER.quality) === 92);
  check("chroma is 4:4:4 — the reason this is not done in the browser", String(JPEG_MASTER.chromaSubsampling) === "4:4:4");
  check("progressive", JPEG_MASTER.progressive === true);
  check("alpha is judged by USE, not by the channel existing", route.includes("usesAlpha"));
  check("and an unreadable alpha check keeps the lossless path", route.includes("return true;"));

  console.log("\n=== image correctness, measured on real encoded bytes ===");
  // withMetadata({orientation}), NOT withExif({IFD0:{Orientation}}) — the latter
  // writes nothing, so the fixture came back as orientation 1 and these
  // assertions passed vacuously. Orientation 3 is here because the existing
  // catalogue contains two photographs that use it.
  for (const orientation of [1, 3, 6, 8] as const) {
    const wide = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a2b2b" } })
      .withMetadata({ orientation })
      .jpeg()
      .toBuffer();
    const meta = await sharp(wide).metadata();
    check(`EXIF ${orientation}: the fixture really carries it`, meta.orientation === orientation,
      `got ${meta.orientation}`);
    const rotated = (meta.orientation ?? 1) >= 5;
    const display = { width: rotated ? meta.height! : meta.width!, height: rotated ? meta.width! : meta.height! };
    const out = await sharp(wide).rotate().toColourspace("srgb").withIccProfile("srgb")
      .resize({ ...targetSize(display), fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .jpeg({ ...JPEG_MASTER }).toBuffer();
    const after = await sharp(out).metadata();
    const expected = targetSize(display);
    check(`EXIF ${orientation}: baked to ${expected.width}x${expected.height}`,
      after.width === expected.width && after.height === expected.height,
      `got ${after.width}x${after.height}`);
    check(`EXIF ${orientation}: output no longer depends on EXIF`,
      (after.orientation ?? 1) === 1, `orientation=${after.orientation}`);
  }
  const opaquePng = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer();
  const opaqueStats = await sharp(opaquePng).ensureAlpha().stats();
  check("a PNG whose alpha is fully opaque is treated as a photograph",
    opaqueStats.channels[opaqueStats.channels.length - 1].min === 255);
  const clearPng = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.4 } } }).png().toBuffer();
  const clearStats = await sharp(clearPng).ensureAlpha().stats();
  check("a genuinely transparent PNG is detected",
    clearStats.channels[clearStats.channels.length - 1].min < 255);
  const losslessOut = await sharp(clearPng).webp({ lossless: true }).toBuffer();
  check("and survives the lossless path with its alpha",
    (await sharp(losslessOut).metadata()).hasAlpha === true);

  console.log("\n=== colour is converted, never merely stripped ===");
  check("the route converts to sRGB", route.includes('.toColourspace("srgb")'));
  check("and tags what it produced", route.includes('.withIccProfile("srgb")'));
  check("conversion happens before the resize",
    route.indexOf('toColourspace("srgb")') < route.indexOf(".resize({"));
  check("orientation is baked before both", route.indexOf(".rotate()") < route.indexOf('toColourspace("srgb")'));
  const tagged = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#c8102e" } })
    .toColourspace("srgb").withIccProfile("srgb").jpeg({ ...JPEG_MASTER }).toBuffer();
  const taggedMeta = await sharp(tagged).metadata();
  check("the encoded master carries an sRGB profile", Boolean(taggedMeta.icc), "no icc on output");

  // A WIDE-GAMUT source, because the checks above cannot fail without one.
  //
  // Every photograph in this catalogue is tagged "DCI-P3 D65 Gamut with sRGB
  // Transfer". Converting P3 to sRGB is what keeps a saturated colour looking
  // the same in a browser, and it changes the numbers to do it — a lime that
  // is (157,249,78) in P3 is (124,252,9) in sRGB. Both describe one colour.
  //
  // The fixtures above are built without a profile, so a route that tagged its
  // output sRGB WITHOUT converting would still satisfy them. That is the exact
  // regression this section now rules out: keepIccProfile() leaves P3 numbers
  // in place and attaches a profile, which looks correct until something
  // downstream drops the tag and renders wide-gamut numbers as sRGB.
  //
  // Nothing here is compared across colour spaces. The reference is the fixture
  // rendered THROUGH its own profile into sRGB — what a colour-managed viewer
  // shows — and the route's output is measured against that, in sRGB.
  const wideGamut = await sharp({
    create: { width: 240, height: 240, channels: 3, background: "#7CFC00" },
  })
    .composite([
      { input: { create: { width: 120, height: 120, channels: 3, background: "#FF00AA" } }, left: 0, top: 0 },
      { input: { create: { width: 120, height: 120, channels: 3, background: "#00E5FF" } }, left: 120, top: 120 },
    ])
    .withIccProfile("p3")
    .jpeg({ quality: 100 })
    .toBuffer();

  const channelMeans = async (buffer: Buffer) =>
    (await sharp(buffer).stats()).channels.slice(0, 3).map((c) => c.mean);
  const widestChannelGap = (a: number[], b: number[]) =>
    Math.max(...a.map((v, i) => Math.abs(v - b[i])));

  // .stats() reads stored numbers and does NOT apply the profile; the encode
  // path does. That asymmetry is why the fixture has to be proven wide-gamut
  // here, or every assertion below could pass on a source that never needed
  // converting.
  const storedNumbers = await channelMeans(wideGamut);
  const managed = await sharp(wideGamut).toColourspace("srgb").withIccProfile("srgb")
    .jpeg({ ...JPEG_MASTER }).toBuffer();
  const managedNumbers = await channelMeans(managed);
  check("the wide-gamut fixture really carries a profile",
    Boolean((await sharp(wideGamut).metadata()).icc));
  check("and its stored numbers really differ from its sRGB rendering",
    widestChannelGap(storedNumbers, managedNumbers) > 10,
    `gap ${widestChannelGap(storedNumbers, managedNumbers).toFixed(1)} — fixture is not wide-gamut, assertions below would be vacuous`);

  const display = { width: 240, height: 240 };
  const encode = (pipeline: ReturnType<typeof sharp>) =>
    pipeline
      .resize({ ...targetSize(display), fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .jpeg({ ...JPEG_MASTER })
      .toBuffer();

  const converted = await encode(
    sharp(wideGamut).rotate().toColourspace("srgb").withIccProfile("srgb"));
  const bypassed = await encode(sharp(wideGamut).rotate().keepIccProfile());
  const convertedNumbers = await channelMeans(converted);
  const bypassedNumbers = await channelMeans(bypassed);

  // The reference points are measurements this pipeline did not produce:
  // `storedNumbers` are the fixture's own P3 values and `managedNumbers` its
  // colour-managed sRGB rendering. Asserting against those, rather than against
  // a second copy of the same call chain, is what makes these fail for a real
  // reason rather than only when sharp is nondeterministic.
  //
  // Tolerance: resize and re-encode at the shared quality move a channel mean
  // by well under a unit. Measured against production masters the widest gap
  // from colour-managed truth was 0.27/255; 1.0 absorbs encoder drift while a
  // missed conversion moves a channel by more than ten times that.
  check("normalizing a wide-gamut source lands on its colour-managed sRGB values",
    widestChannelGap(convertedNumbers, managedNumbers) <= 1.0,
    `widest channel gap ${widestChannelGap(convertedNumbers, managedNumbers).toFixed(2)}/255`);
  check("and moves them off the source's stored P3 values",
    widestChannelGap(convertedNumbers, storedNumbers) > 10,
    `only moved ${widestChannelGap(convertedNumbers, storedNumbers).toFixed(2)}/255 — the conversion did not happen`);
  check("skipping the conversion ships the stored P3 values instead",
    widestChannelGap(bypassedNumbers, storedNumbers) <= 1.0
      && widestChannelGap(bypassedNumbers, managedNumbers) > 10,
    "a bypassed pipeline is indistinguishable here, so the checks above have no teeth");

  // Compared by bytes, not by length: sharp's built-in sRGB and P3 profiles are
  // both 480 bytes, so a length check cannot tell them apart.
  const p3Profile = (await sharp(wideGamut).metadata()).icc!;
  const convertedProfile = (await sharp(converted).metadata()).icc;
  check("the wide-gamut master is tagged sRGB, not left tagged P3",
    Boolean(convertedProfile) && !convertedProfile!.equals(p3Profile),
    "output still carries the source's P3 profile");

  console.log("\n=== transaction order (source contract) ===");
  const iVerifyOut = route.indexOf("VERIFY THE OUTPUT BEFORE ANYTHING IS WRITTEN");
  const iUpload = route.indexOf(".upload(masterPath");
  const iVerifyMaster = route.indexOf("verifyReadable(publicUrl)");
  const iRemove = route.indexOf(".remove([staged])");
  check("the encoded output is verified before it is uploaded", iVerifyOut > 0 && iVerifyOut < iUpload);
  check("the master is uploaded before it is verified", iUpload < iVerifyMaster);
  check("the master is verified before the original is deleted", iVerifyMaster < iRemove);
  check("deleting the original is the LAST destructive act",
    iRemove > iUpload && iRemove > iVerifyMaster && route.lastIndexOf(".remove(") === iRemove);
  check("a processing failure leaves the staged original intact",
    route.includes("NOTHING HAS BEEN DELETED"));
  check("a failed master upload returns before any delete",
    route.indexOf("could not be saved") < iRemove);
  check("a failed verification returns before any delete",
    route.indexOf("could not be verified") < iRemove);
  check("cleanup failure is reported, not thrown", route.includes("stagedRemoved = false") && route.includes("console.warn"));
  check("the response tells the caller whether cleanup happened", route.includes("stagedRemoved,"));
  check("the route writes no product row, so it cannot orphan one",
    !/\.from\("product_images"\)|\.from\("products"\)/.test(route));

  console.log("\n=== cache control ===");
  check("masters are immutable for a year", String(MASTER_CACHE_CONTROL) === "31536000");
  check("the route uses it", route.includes("cacheControl: MASTER_CACHE_CONTROL"));
  check("staging is NOT given the same long life", String(STAGING_CACHE_CONTROL) !== String(MASTER_CACHE_CONTROL));
  check("staging expires in a minute", String(STAGING_CACHE_CONTROL) === "60");
  check("the browser stages with the short value", storage.includes("cacheControl: STAGING_CACHE_CONTROL"));
  check("a year is safe only because names are content-addressed",
    masterKey("c".repeat(64), "jpg") !== masterKey("d".repeat(64), "jpg"));

  console.log("\n=== scope: nothing else was changed ===");
  check("uploadImage still exists for the other surfaces", storage.includes("export async function uploadImage("));
  check("journal, pages, campaigns and lookbook still call it",
    ["JournalManager", "PagesManager", "ContentEditor", "LookbookEditor"].every((f) =>
      readFileSync(`components/admin/${f}.tsx`, "utf8").includes("uploadImage(")));
  check("only the product editor uses the new path", modal.includes("uploadProductImage("));
  check("and it no longer calls the old one", !modal.includes("uploadImage("));
  check("#132's ceiling is untouched", nextConfig.includes("deviceSizes: [640, 750, 828, 1080, 1200, 1920]"));
  check("no 2048/3840 crept back", !/deviceSizes[^\]]*(2048|3840)/.test(nextConfig));
  const rules = readFileSync("lib/imageNormalize.ts", "utf8");
  check("HEIC is still refused, by the sniffer and by the browser",
    rules.includes("heif_not_supported") && storage.includes("REJECTED_EXTENSIONS"));
  check("and refused for what it IS, so the message can name the phone setting",
    rules.includes("Most Compatible"));
  check("no migration is introduced by this pipeline",
    !route.includes("alter table") && !storage.includes("alter table"));

  console.log("\n=== admin UX ===");
  check("the admin is told it is uploading", modal.includes("`Uploading${of}…`"));
  check("and then that it is processing", modal.includes("`Processing${of}…`"));
  check("the stage clears when the batch ends", modal.includes("setStage(null);"));
  check("failures are collected per file, not dropped", modal.includes("failures.push("));
  check("a rejected file does not discard the rest", modal.includes("if (uploaded.length) setImages("));
  check("only successful uploads become thumbnails", modal.includes("uploaded.push(prepared.url)"));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
