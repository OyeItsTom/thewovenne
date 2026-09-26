/**
 * SEO-6B-2: product masters are uploaded with X-Robots-Tag: all and a real
 * Cache-Control, and the route checks how the public URL is actually served.
 *
 *   npx --cache <dir> --yes tsx@4.19.2 scripts/image-delivery.test.ts
 *
 * Three layers, and what each one proves:
 *
 *   1. PURE — the header values, and assessMasterDelivery against the exact
 *      responses recorded from the hosted service on 26 September 2026 (the
 *      SEO-6B Stage 2/3 test objects and a live pre-fix master).
 *   2. THE REAL SDK — @supabase/storage-js builds the upload request from the
 *      route's own options, and the request it would put on the wire is read
 *      back. No hand-written copy of the SDK's behaviour is trusted.
 *   3. THE REAL ROUTE — POST is executed with the real SDK talking to an
 *      in-memory storage server that behaves like the hosted one (duplicates
 *      answer 400/"409", Cache-Control stored verbatim, X-Robots-Tag defaulting
 *      to `none`, MD5 ETags), and every outcome A–E is driven through it.
 *
 * Nothing here touches the network or a real bucket.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import sharp from "sharp";
import { StorageClient } from "@supabase/storage-js";
import {
  assessMasterDelivery,
  robotsForbidIndexing,
  verifyMasterDelivery,
  type ExpectedMaster,
} from "../lib/imageDelivery";
import {
  MASTER_CACHE_CONTROL,
  MASTER_CACHE_CONTROL_HEADER,
  MASTER_ROBOTS_TAG,
  STAGING_CACHE_CONTROL,
  masterUploadHeaders,
  masterUploadOptions,
} from "../lib/imageNormalize";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else {
    fail++;
    if (detail !== undefined) console.log(`        ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const YEAR = Number(MASTER_CACHE_CONTROL);

/* ───────────────────────────── 1. pure ─────────────────────────────────── */

function headerGeneration() {
  console.log("\n=== header generation ===");
  const h = masterUploadHeaders();
  check("cache-control is a real directive: max-age=31536000", h["cache-control"] === "max-age=31536000");
  check("the header constant is the number with its directive name",
    MASTER_CACHE_CONTROL_HEADER === `max-age=${MASTER_CACHE_CONTROL}`);
  check("x-robots-tag is all", h["x-robots-tag"] === "all" && MASTER_ROBOTS_TAG === "all");
  check("exactly those two headers, nothing else rides along", Object.keys(h).sort().join() === "cache-control,x-robots-tag");
  check("each call returns a fresh object (a caller cannot mutate the rule)",
    masterUploadHeaders() !== masterUploadHeaders());

  // The storage server accepts only these simple rules (supabase/storage
  // src/storage/validators/x-robots-tag.ts); anything else fails the upload.
  const SIMPLE = ["all", "noindex", "nofollow", "none", "nosnippet", "indexifembedded", "notranslate", "noimageindex"];
  check("the value passes the storage server's validator", SIMPLE.includes(MASTER_ROBOTS_TAG));

  // Next's optimizer reads upstream max-age like this (image-optimizer getMaxAge).
  const nextMaxAge = (v: string) => {
    const m = /(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?(\d+)/i.exec(v);
    return m ? Number(m[1]) : 0;
  };
  check("Next reads the new header as a year", nextMaxAge(MASTER_CACHE_CONTROL_HEADER) === YEAR);
  check("and the bare number the scripts used to send as 0 (the defect)", nextMaxAge(MASTER_CACHE_CONTROL) === 0);

  const o = masterUploadOptions("image/jpeg");
  check("SDK options keep upsert:false", o.upsert === false);
  check("SDK options keep the content type", o.contentType === "image/jpeg");
  check("SDK options carry the shared headers", JSON.stringify(o.headers) === JSON.stringify(h));
  check("staging keeps its own short, non-indexable life", STAGING_CACHE_CONTROL === "60");
}

/** Recorded on the hosted service, SEO-6B Stages 1–3. */
const STAGE2_MD5 = "3a5582f97d6c68532c8854750fa7065d";
const STAGE2: ExpectedMaster = { byteLength: 15263, md5: STAGE2_MD5, maxAge: YEAR };
const H = (o: Record<string, string>) => new Headers(o);

function assessment() {
  console.log("\n=== assessMasterDelivery, against recorded hosted responses ===");

  const good = assessMasterDelivery(206, H({
    "content-range": "bytes 0-0/15263", "content-length": "1", etag: `"${STAGE2_MD5}"`,
    "x-robots-tag": "all", "cache-control": "public, max-age=31536000, immutable",
  }), STAGE2);
  check("Stage 2 test object (all, a year, MD5 ETag) is verified",
    good.ok && good.delivery.status === "verified" && good.delivery.identity === "md5" && good.delivery.rangeHonoured, good);

  const stage3 = assessMasterDelivery(206, H({
    "content-range": "bytes 0-0/15263", etag: `"${STAGE2_MD5}"`,
    "x-robots-tag": "none", "cache-control": "public, max-age=31536000, immutable",
  }), STAGE2);
  check("Stage 3's stale `none` is NOT verified: not_indexable",
    stage3.ok && stage3.delivery.status === "warning" && !stage3.delivery.indexable
      && stage3.delivery.warnings.join() === "not_indexable", stage3);

  const legacy = assessMasterDelivery(206, H({
    "content-range": "bytes 0-0/15263", etag: `"${STAGE2_MD5}"`,
    "x-robots-tag": "none", "cache-control": "31536000",
  }), STAGE2);
  check("a pre-fix master (bare 31536000, none) warns on both headers",
    legacy.ok && legacy.delivery.warnings.join() === "not_indexable,cache_control_unexpected", legacy);

  const cf = assessMasterDelivery(206, H({
    "content-range": "bytes 0-0/15263", etag: `"${STAGE2_MD5}"`, "x-robots-tag": "all", "cache-control": "public, max-age=31536000",
  }), STAGE2);
  check("a CDN-added `public` directive is fine", cf.ok && cf.delivery.status === "verified");

  const wrongAge = assessMasterDelivery(206, H({
    "content-range": "bytes 0-0/15263", etag: `"${STAGE2_MD5}"`, "x-robots-tag": "all", "cache-control": "max-age=3600",
  }), STAGE2);
  check("a different max-age warns", wrongAge.ok && wrongAge.delivery.warnings.join() === "cache_control_unexpected");
  const noCc = assessMasterDelivery(206, H({ "content-range": "bytes 0-0/15263", etag: `"${STAGE2_MD5}"`, "x-robots-tag": "all" }), STAGE2);
  check("a missing Cache-Control warns", noCc.ok && noCc.delivery.warnings.join() === "cache_control_unexpected");
  const noCache = assessMasterDelivery(206, H({
    "content-range": "bytes 0-0/15263", etag: `"${STAGE2_MD5}"`, "x-robots-tag": "all", "cache-control": "no-cache",
  }), STAGE2);
  check("`no-cache` (what hosted HEAD says) warns rather than passing", noCache.ok && noCache.delivery.status === "warning");

  // ── identity ──
  const base = { "content-range": "bytes 0-0/15263", "x-robots-tag": "all", "cache-control": "max-age=31536000" };
  const multi = assessMasterDelivery(206, H({ ...base, etag: '"764ec3e88623f82f25bd988acb1a466a-2"' }), STAGE2);
  check("a multipart ETag is unverified, not a mismatch",
    multi.ok && multi.delivery.identity === "unverified" && multi.delivery.warnings.join() === "identity_unverified", multi);
  const none = assessMasterDelivery(206, H(base), STAGE2);
  check("a missing ETag is unverified", none.ok && none.delivery.warnings.join() === "identity_unverified");
  const weak = assessMasterDelivery(206, H({ ...base, etag: `W/"${STAGE2_MD5}"` }), STAGE2);
  check("a weak ETag is unverified, even when its value matches", weak.ok && weak.delivery.identity === "unverified");
  const odd = assessMasterDelivery(206, H({ ...base, etag: '"abc123"' }), STAGE2);
  check("a non-MD5-shaped ETag is unverified", odd.ok && odd.delivery.identity === "unverified");
  const upper = assessMasterDelivery(206, H({ ...base, etag: `"${STAGE2_MD5.toUpperCase()}"` }), STAGE2);
  check("an upper-case MD5 ETag still matches", upper.ok && upper.delivery.identity === "md5");
  const other = assessMasterDelivery(206, H({ ...base, etag: `"${"0".repeat(32)}"` }), STAGE2);
  check("a different MD5 is a failure: identity_mismatch", !other.ok && other.failure === "identity_mismatch", other);

  // ── length ──
  const longer = assessMasterDelivery(206, H({ ...base, "content-range": "bytes 0-0/15264", etag: `"${STAGE2_MD5}"` }), STAGE2);
  check("a different Content-Range total is a failure: length_mismatch", !longer.ok && longer.failure === "length_mismatch");
  const ignored = assessMasterDelivery(200, H({ ...base, "content-range": "", "content-length": "15263", etag: `"${STAGE2_MD5}"` }), STAGE2);
  check("Range ignored (200 + Content-Length) still verifies, and says so",
    ignored.ok && ignored.delivery.status === "verified" && !ignored.delivery.rangeHonoured, ignored);
  const ignoredWrong = assessMasterDelivery(200, H({ ...base, "content-length": "999", etag: `"${STAGE2_MD5}"` }), STAGE2);
  check("Range ignored with a different length fails", !ignoredWrong.ok && ignoredWrong.failure === "length_mismatch");
  const unknown = assessMasterDelivery(200, H({ "x-robots-tag": "all", "cache-control": "max-age=31536000", etag: `"${STAGE2_MD5}"` }), STAGE2);
  check("no length at all warns length_unknown rather than guessing",
    unknown.ok && unknown.delivery.warnings.join() === "length_unknown", unknown);
  const badRange = assessMasterDelivery(206, H({ ...base, "content-range": "bytes */15263", etag: `"${STAGE2_MD5}"` }), STAGE2);
  check("an unparseable Content-Range is unknown, not trusted", badRange.ok && badRange.delivery.warnings.includes("length_unknown"));

  // ── readability ──
  for (const status of [400, 404, 416, 500, 304]) {
    const r = assessMasterDelivery(status, H(base), STAGE2);
    check(`status ${status} is unreadable`, !r.ok && r.failure === "unreadable" && r.httpStatus === status);
  }

  // ── robots parsing ──
  console.log("\n=== X-Robots-Tag parsing ===");
  const forbids: [string | null, boolean][] = [
    ["all", false], [null, false], ["none", true], ["noindex", true], ["NoIndex", true],
    ["noimageindex", true], ["nofollow", false], ["nosnippet, notranslate", false],
    ["googlebot: noindex", true], ["otherbot: all, noindex", true],
    ["max-image-preview: none", false], ["max-image-preview:none", false],
    ["googlebot: max-image-preview: none", false], ["max-snippet: 0, noimageindex", true],
    ["unavailable_after: 25 Jun 2030 15:00:00 PST", false],
  ];
  for (const [value, expected] of forbids) {
    check(`${JSON.stringify(value)} ${expected ? "forbids" : "allows"} indexing`, robotsForbidIndexing(value) === expected);
  }
}

/* ─────────────────────── the verifier's own request ───────────────────── */

interface Seen { url: string; method: string; headers: Headers; bodyRead: boolean; cancelled: boolean }

function streamBody(bytes: Uint8Array, seen: Seen) {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.bodyRead = true;
      controller.enqueue(bytes);
      controller.close();
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 });
}

async function verifierRequest() {
  console.log("\n=== verifyMasterDelivery's request ===");
  const seen: Seen = { url: "", method: "", headers: new Headers(), bodyRead: false, cancelled: false };
  const full = new Uint8Array(15263);
  const fake: typeof fetch = async (input, init) => {
    seen.url = String(input);
    seen.method = init?.method ?? "GET";
    seen.headers = new Headers(init?.headers);
    // A server that IGNORES Range: 200 and the whole object.
    return new Response(streamBody(full, seen), {
      status: 200,
      headers: { "content-length": "15263", etag: `"${STAGE2_MD5}"`, "x-robots-tag": "all", "cache-control": "max-age=31536000" },
    });
  };
  const url = "https://x.supabase.co/storage/v1/object/public/product-images/products/a-v1.jpg";
  const result = await verifyMasterDelivery(url, STAGE2, fake);
  check("it asks for exactly the URL it was given", seen.url === url);
  check("with GET, never HEAD", seen.method === "GET");
  check("for one byte", seen.headers.get("range") === "bytes=0-0");
  check("a server ignoring Range does not get its body read", !seen.bodyRead);
  check("the body is cancelled instead", seen.cancelled);
  check("and the result is still judged from the headers", result.ok && result.delivery.status === "verified" && !result.delivery.rangeHonoured, result);

  const thrown = await verifyMasterDelivery(url, STAGE2, async () => { throw new TypeError("fetch failed"); });
  check("a network error is unreadable, with no status", !thrown.ok && thrown.failure === "unreadable" && thrown.httpStatus === null);
  const bodyless = await verifyMasterDelivery(url, STAGE2, async () => new Response(null, {
    status: 206, headers: { "content-range": "bytes 0-0/15263", etag: `"${STAGE2_MD5}"`, "x-robots-tag": "all", "cache-control": "max-age=31536000" },
  }));
  check("a response with no body is fine", bodyless.ok && bodyless.delivery.status === "verified");
}

/* ─────────────────────────── 2. the real SDK ───────────────────────────── */

async function sdkRequest() {
  console.log("\n=== the real storage SDK, with the route's options ===");
  let captured: { url: string; method: string; headers: Headers; body: unknown } | null = null;
  const fake: typeof fetch = async (input, init) => {
    captured = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body };
    return new Response(JSON.stringify({ Key: "product-images/products/a-v1.jpg", Id: "1" }), { status: 200 });
  };
  const client = new StorageClient("https://x.supabase.co/storage/v1", {}, fake);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const { error } = await client.from("product-images").upload("products/a-v1.jpg", bytes, masterUploadOptions("image/jpeg"));
  const c = captured as unknown as { url: string; method: string; headers: Headers; body: unknown };
  check("the upload succeeds against the fake", !error, error);
  check("POST to the object route", c.method === "POST" && c.url.endsWith("/object/product-images/products/a-v1.jpg"));
  check("wire cache-control is max-age=31536000", c.headers.get("cache-control") === "max-age=31536000", c.headers.get("cache-control"));
  check("wire x-robots-tag is all", c.headers.get("x-robots-tag") === "all");
  check("wire x-upsert is false", c.headers.get("x-upsert") === "false");
  check("wire content-type is the master's", c.headers.get("content-type") === "image/jpeg");
  check("the body is the master itself, not a form", c.body === bytes);

  // What a raw REST script puts on the wire, built the way the scripts build it.
  const rest = new Headers({ apikey: "k", Authorization: "Bearer k", "Content-Type": "image/jpeg", ...masterUploadHeaders(), "x-upsert": "false" });
  check("a raw REST upload carries the identical two headers",
    rest.get("cache-control") === c.headers.get("cache-control") && rest.get("x-robots-tag") === c.headers.get("x-robots-tag"));
}

/* ─────────────────────────── 3. the real route ─────────────────────────── */

interface StoredObject { bytes: Buffer; cacheControl: string; robots: string | null; contentType: string }

interface Scenario {
  isAdmin?: boolean;
  uploadStatus?: number;
  publicStatus?: number;
  publicThrows?: boolean;
  etag?: "md5" | "multipart" | "missing" | "wrong";
  ignoreRange?: boolean;
  robotsOverride?: string;
  lengthOverride?: number;
  removeFails?: boolean;
}

const BASE = "https://proj.supabase.co";
const store = new Map<string, StoredObject>();
const calls: { method: string; path: string; headers: Headers }[] = [];
let scenario: Scenario = {};
let publicBodyRead = false;

function objectPath(url: string) {
  const u = new URL(url);
  const m = /^\/storage\/v1\/object\/(?:(public|authenticated)\/)?product-images\/(.+)$/.exec(u.pathname);
  return m ? { visibility: m[1] ?? "", key: decodeURIComponent(m[2]) } : null;
}

const storageServer: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const u = new URL(url);
  calls.push({ method, path: u.pathname, headers });

  if (method === "DELETE" && u.pathname === "/storage/v1/object/product-images") {
    if (scenario.removeFails) return new Response(JSON.stringify({ statusCode: "500", error: "x", message: "boom" }), { status: 500 });
    const { prefixes } = JSON.parse(String(init?.body)) as { prefixes: string[] };
    for (const p of prefixes) store.delete(p);
    return new Response(JSON.stringify(prefixes.map((name) => ({ name }))), { status: 200 });
  }

  const target = objectPath(url);
  if (!target) return new Response("no route", { status: 404 });

  if (method === "POST" && target.visibility === "") {
    if (scenario.uploadStatus) {
      return new Response(JSON.stringify({ statusCode: String(scenario.uploadStatus), error: "x", message: "storage down" }), { status: scenario.uploadStatus });
    }
    if (store.has(target.key)) {
      // What the hosted service answers for x-upsert:false on an existing key.
      return new Response(JSON.stringify({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }), { status: 400 });
    }
    const body = init?.body as Buffer;
    store.set(target.key, {
      bytes: Buffer.from(body),
      cacheControl: headers.get("cache-control") ?? "no-cache", // stored verbatim, as uploader.ts does
      robots: headers.get("x-robots-tag"),
      contentType: headers.get("content-type") ?? "application/octet-stream",
    });
    return new Response(JSON.stringify({ Key: `product-images/${target.key}`, Id: randomUUID() }), { status: 200 });
  }

  if (method === "GET" && target.visibility !== "public") {
    const obj = store.get(target.key);
    return obj ? new Response(new Uint8Array(obj.bytes), { status: 200 }) : new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: 400 });
  }

  if (method === "GET" && target.visibility === "public") {
    if (scenario.publicThrows) throw new TypeError("fetch failed");
    const obj = store.get(target.key);
    if (!obj || scenario.publicStatus) {
      return new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: scenario.publicStatus ?? 400 });
    }
    const length = scenario.lengthOverride ?? obj.bytes.length;
    const etag = {
      md5: `"${md5(obj.bytes)}"`, multipart: `"${md5(obj.bytes)}-2"`, missing: null, wrong: `"${"f".repeat(32)}"`,
    }[scenario.etag ?? "md5"];
    const out = new Headers({
      "content-type": obj.contentType,
      "cache-control": obj.cacheControl,
      "x-robots-tag": scenario.robotsOverride ?? obj.robots ?? "none", // renderer.ts default
    });
    if (etag) out.set("etag", etag);
    const ranged = headers.get("range") === "bytes=0-0" && !scenario.ignoreRange;
    if (ranged) {
      out.set("content-range", `bytes 0-0/${length}`);
      out.set("content-length", "1");
      return new Response(new Uint8Array(obj.bytes.subarray(0, 1)), { status: 206, headers: out });
    }
    out.set("content-length", String(length));
    const whole = new ReadableStream<Uint8Array>({
      pull(controller) { publicBodyRead = true; controller.enqueue(obj.bytes); controller.close(); },
    }, { highWaterMark: 0 });
    return new Response(whole, { status: 200, headers: out });
  }

  return new Response("unexpected", { status: 500 });
};

// ── the route, loaded with its Supabase client replaced ──
//
// Seeded into the module cache BEFORE the route is required, so the route's own
// `import { createRSCClient } from "@/lib/supabaseRSC"` resolves to this. Its
// `storage` is the REAL StorageClient; only the network under it is fake.
const rscPath = require.resolve("../lib/supabaseRSC");
const fakeRsc = new Module(rscPath);
fakeRsc.filename = rscPath;
fakeRsc.loaded = true;
fakeRsc.exports = {
  createRSCClient: () => ({
    rpc: async (fn: string) => {
      calls.push({ method: "RPC", path: fn, headers: new Headers() });
      return { data: fn === "is_admin" ? scenario.isAdmin ?? true : null, error: null };
    },
    storage: new StorageClient(`${BASE}/storage/v1`, {}, storageServer),
  }),
};
require.cache[rscPath] = fakeRsc;
globalThis.fetch = storageServer; // the route's delivery GET uses the global fetch

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require("../app/api/admin/images/normalize/route") as typeof import("../app/api/admin/images/normalize/route");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NextRequest } = require("next/server") as typeof import("next/server");

async function photo(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 120 + seed, g: 40, b: 60 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function stage(source: Buffer): Promise<string> {
  const id = randomUUID();
  store.set(`staging/${id}.jpg`, { bytes: source, cacheControl: "max-age=60", robots: null, contentType: "image/jpeg" });
  return id;
}

async function run(id: string, s: Scenario = {}) {
  scenario = s;
  calls.length = 0;
  publicBodyRead = false;
  const response = await POST(new NextRequest("http://localhost/api/admin/images/normalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stagingId: id, ext: "jpg" }),
  }));
  const body = (await response.json().catch(() => null)) as Record<string, any> | null;
  return { status: response.status, body };
}

const masters = () => [...store.keys()].filter((k) => k.startsWith("products/"));
const masterUploads = () => calls.filter((c) => c.method === "POST" && c.path.includes("/products/"));
const deletes = () => calls.filter((c) => c.method === "DELETE");
const originalLog = { warn: console.warn, error: console.error };
const logged: string[] = [];
console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };

async function routeBehaviour() {
  originalLog.warn("\n=== the route, end to end (real SDK, fake storage server) ===");
  const log = (m: string) => process.stdout.write(`${m}\n`);

  // ── authentication ──
  store.clear();
  const idA = await stage(await photo(1));
  const denied = await run(idA, { isAdmin: false });
  check("a non-admin gets the same 404 as before", denied.status === 404);
  check("and not one storage request was made", calls.every((c) => c.method === "RPC"));
  check("the staged original is untouched", store.has(`staging/${idA}.jpg`));

  // ── a new upload ──
  const sourceA = store.get(`staging/${idA}.jpg`)!.bytes;
  logged.length = 0;
  const fresh = await run(idA);
  const [key] = masters();
  check("a new upload succeeds", fresh.status === 200, fresh.body);
  check("exactly one master was written", masters().length === 1 && masterUploads().length === 1);
  check("under its content-addressed name", key === `products/${sha256(sourceA).slice(0, 32)}-v1.jpg`, key);
  const up = masterUploads()[0].headers;
  check("the master went up with cache-control max-age=31536000", up.get("cache-control") === "max-age=31536000", up.get("cache-control"));
  check("and x-robots-tag all", up.get("x-robots-tag") === "all");
  check("and x-upsert false", up.get("x-upsert") === "false");
  check("stored verbatim as the valid header", store.get(key)!.cacheControl === "max-age=31536000");
  const gets = calls.filter((c) => c.path.startsWith("/storage/v1/object/public/"));
  check("delivery was checked with exactly one public GET", gets.length === 1 && gets[0].method === "GET");
  check("a ranged one", gets[0].headers.get("range") === "bytes=0-0");
  check("no HEAD request was made anywhere", calls.every((c) => c.method !== "HEAD"));
  check("the response says verified", fresh.body?.delivery?.status === "verified" && fresh.body?.duplicate === false, fresh.body);
  check("with MD5 identity and indexable", fresh.body?.delivery?.identity === "md5" && fresh.body?.delivery?.indexable === true);
  check("the staged original was cleaned up", !store.has(`staging/${idA}.jpg`) && fresh.body?.stagedRemoved === true);
  check("the only delete was the staged original",
    deletes().length === 1 && !calls.some((c) => c.method === "DELETE" && c.path.includes("products/")));
  check("nothing was logged for a clean upload", logged.length === 0, logged);
  check("the response shape the admin reads is unchanged",
    typeof fresh.body?.url === "string" && typeof fresh.body?.width === "number" && typeof fresh.body?.height === "number" && typeof fresh.body?.bytes === "number");
  const masterMeta = await sharp(store.get(key)!.bytes).metadata();
  check("normalisation is unchanged: JPEG, 4:4:4, sRGB", masterMeta.format === "jpeg" && masterMeta.chromaSubsampling === "4:4:4" && masterMeta.space === "srgb");

  // ── B. an existing duplicate, same bytes ──
  const before = Buffer.from(store.get(key)!.bytes);
  const idDup = await stage(sourceA);
  logged.length = 0;
  const dup = await run(idDup);
  check("re-uploading the same photograph succeeds", dup.status === 200, dup.body);
  check("reported as a duplicate, verified", dup.body?.duplicate === true && dup.body?.delivery?.status === "verified");
  check("it resolves to the same URL", dup.body?.url === fresh.body?.url);
  check("the existing master was not replaced", store.get(key)!.bytes.equals(before) && masters().length === 1);
  check("no PUT (overwrite) was ever attempted", calls.every((c) => c.method !== "PUT"));
  check("its staged copy was cleaned up", !store.has(`staging/${idDup}.jpg`));

  // ── B'. a duplicate of a pre-fix master: readable, same bytes, wrong headers ──
  store.set(key, { ...store.get(key)!, cacheControl: "31536000", robots: null });
  const idLegacy = await stage(sourceA);
  logged.length = 0;
  const legacy = await run(idLegacy);
  check("a duplicate of a pre-fix master still succeeds", legacy.status === 200);
  check("but is NOT reported as verified",
    legacy.body?.delivery?.status === "warning" && legacy.body?.delivery?.warnings?.join() === "not_indexable,cache_control_unexpected", legacy.body);
  check("and it is logged for an operator",
    logged.some((l) => l.includes("delivery-warning") && l.includes("not_indexable") && l.includes("duplicate=true")), logged);
  check("the pre-fix master is left exactly as it was",
    store.get(key)!.cacheControl === "31536000" && store.get(key)!.robots === null && store.get(key)!.bytes.equals(before));

  // ── a duplicate whose stored bytes are demonstrably different ──
  store.set(key, { bytes: await photo(99), cacheControl: "max-age=31536000", robots: "all", contentType: "image/jpeg" });
  const tampered = Buffer.from(store.get(key)!.bytes);
  const idDiff = await stage(sourceA);
  logged.length = 0;
  const diff = await run(idDiff);
  check("a duplicate with different bytes is refused", diff.status === 409, diff);
  check("with a message that says not to retry", /does not match/.test(String(diff.body?.error)));
  check("it is not returned as a usable URL", diff.body?.url === undefined);
  check("the existing object is not touched", store.get(key)!.bytes.equals(tampered));
  check("the staged original is kept", store.has(`staging/${idDiff}.jpg`));
  check("and it is logged as a failure", logged.some((l) => l.includes("delivery-failed") && l.includes("duplicate=true")), logged);
  check("no delete happened at all", deletes().length === 0);

  // ── A. upload failed ──
  store.clear();
  const idFail = await stage(await photo(2));
  const failed = await run(idFail, { uploadStatus: 500 });
  check("a failed upload is a 502 'could not be saved'", failed.status === 502 && /could not be saved/.test(String(failed.body?.error)));
  check("nothing was verified or deleted", deletes().length === 0 && !calls.some((c) => c.path.includes("/public/")));
  check("the staged original is kept", store.has(`staging/${idFail}.jpg`));

  // ── C. unreadable ──
  for (const [label, s] of [["a 404", { publicStatus: 404 }], ["a network error", { publicThrows: true }]] as const) {
    store.clear();
    const id = await stage(await photo(3));
    const r = await run(id, s);
    check(`${label} on the public GET is a 502 'could not be verified'`, r.status === 502 && /could not be verified/.test(String(r.body?.error)), r);
    check(`  the master is NOT deleted (${label})`, masters().length === 1);
    check(`  the staged original is kept (${label})`, store.has(`staging/${id}.jpg`) && deletes().length === 0);
  }

  // ── a new upload that is served with other bytes ──
  for (const [label, s] of [["a wrong MD5 ETag", { etag: "wrong" }], ["a different length", { lengthOverride: 12 }]] as const) {
    store.clear();
    const id = await stage(await photo(4));
    const r = await run(id, s);
    check(`a new upload served with ${label} fails 502, not 409`, r.status === 502, r);
    check(`  and keeps both the master and the staged original (${label})`, masters().length === 1 && store.has(`staging/${id}.jpg`));
  }

  // ── D. identity cannot be verified ──
  for (const mode of ["multipart", "missing"] as const) {
    store.clear();
    const id = await stage(await photo(5));
    logged.length = 0;
    const r = await run(id, { etag: mode });
    check(`a ${mode} ETag: the upload stands`, r.status === 200 && typeof r.body?.url === "string");
    check(`  but identity is reported unverified (${mode})`,
      r.body?.delivery?.status === "warning" && r.body?.delivery?.identity === "unverified" && r.body?.delivery?.warnings?.join() === "identity_unverified", r.body);
    check(`  and logged (${mode})`, logged.some((l) => l.includes("identity_unverified")));
  }

  // ── Range ignored by the server ──
  store.clear();
  const idRange = await stage(await photo(6));
  const ranged = await run(idRange, { ignoreRange: true });
  check("a server that ignores Range still verifies", ranged.status === 200 && ranged.body?.delivery?.status === "verified", ranged.body);
  check("and says the range was not honoured", ranged.body?.delivery?.rangeHonoured === false);
  check("without the route reading the whole master", !publicBodyRead);

  // ── E. the public header is wrong on a NEW upload (a hosted regression) ──
  store.clear();
  const idNone = await stage(await photo(7));
  logged.length = 0;
  const regressed = await run(idNone, { robotsOverride: "none" });
  check("served `none` despite the header: the upload stands", regressed.status === 200);
  check("  reported not indexable, not verified",
    regressed.body?.delivery?.status === "warning" && regressed.body?.delivery?.indexable === false, regressed.body);
  check("  and logged with the served value", logged.some((l) => l.includes("not_indexable") && l.includes("x-robots-tag=none")));
  check("  and nothing was deleted but the staged original", deletes().length === 1 && masters().length === 1);

  // ── staging cleanup failing is still reported, not thrown ──
  store.clear();
  const idKeep = await stage(await photo(8));
  const kept = await run(idKeep, { removeFails: true });
  check("a failed staging cleanup still returns the photograph", kept.status === 200 && kept.body?.stagedRemoved === false);
  log("");
}

/* ─────────────────────── source contracts and scope ───────────────────── */

function contracts() {
  console.log("\n=== source contracts ===");
  const route = readFileSync("app/api/admin/images/normalize/route.ts", "utf8");
  const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("the route uploads with the shared options", code.includes(".upload(masterPath, master, masterUploadOptions(encoding.contentType))"));
  check("the route no longer spells cacheControl itself", !code.includes("cacheControl:"));
  check("no HEAD request remains in the route", !/method:\s*["']HEAD["']/.test(code));
  check("delivery is checked on the URL the route built, never the caller's",
    code.includes("getPublicUrl(masterPath)") && code.includes("verifyMasterDelivery(publicUrl,"));
  check("the only .remove( is the staged original", (code.match(/\.remove\(/g) ?? []).length === 1 && code.includes(".remove([staged])"));
  check("every failed check returns before that remove",
    code.indexOf("if (!served.ok)") > 0 && code.indexOf("if (!served.ok)") < code.indexOf(".remove([staged])"));
  check("the admin check still comes first", code.indexOf('rpc("is_admin")') < code.indexOf("request.json()"));

  for (const file of ["scripts/backfill-execute.ts", "scripts/c6-normalize-execute.ts"]) {
    const src = readFileSync(file, "utf8");
    check(`${file} sends the shared headers`, src.includes("...masterUploadHeaders()"));
    check(`${file} no longer sends the bare number`, !/["']cache-control["']\s*:\s*MASTER_CACHE_CONTROL\b/.test(src));
    check(`${file} still refuses to overwrite`, src.includes('"x-upsert": "false"') && !src.includes('"x-upsert": "true"'));
    check(`${file} gains no PUT`, !/method:\s*["']PUT["']/.test(src));
  }

  // No cache-control header value anywhere that is only digits.
  const everywhere = ["app/api/admin/images/normalize/route.ts", "scripts/backfill-execute.ts", "scripts/c6-normalize-execute.ts", "lib/storage.ts"]
    .map((f) => readFileSync(f, "utf8")).join("\n");
  check("no raw cache-control header is a bare number", !/["']cache-control["']\s*:\s*["']\d+["']/i.test(everywhere));

  console.log("\n=== scope: what must not change ===");
  const storage = readFileSync("lib/storage.ts", "utf8");
  const style = readFileSync("components/style/StyleSubmissionForm.tsx", "utf8");
  check("customer style photos are not made indexable", !/robots/i.test(style));
  check("the journal/pages uploader is not made indexable", !/robots/i.test(storage.replace(/\/\*\*[\s\S]*?\*\//g, "")));
  check("staging still uses its own short value", storage.includes("cacheControl: STAGING_CACHE_CONTROL"));
  check("the general uploader keeps its hour", storage.includes('.upload(path, file, { cacheControl: "3600", upsert: false })'));
  check("robots.txt is not touched by this change", !route.includes("robots.txt"));
  check("SEO-6A's productImageUrl is untouched", readFileSync("lib/seo.ts", "utf8").includes("export function productImageUrl("));
}

async function main() {
  headerGeneration();
  assessment();
  await verifierRequest();
  await sdkRequest();
  await routeBehaviour();
  console.warn = originalLog.warn;
  console.error = originalLog.error;
  contracts();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
