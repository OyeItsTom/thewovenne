/**
 * Customer style photographs: private until approved (0073).
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/style-photo-storage.test.ts
 *
 * Three halves:
 *
 *   A. THE BYTES (real sharp, real files). normalizeStylePhoto accepts a real
 *      JPEG and returns a fresh one without its EXIF or anything appended;
 *      refuses PNG, GIF, SVG, HTML and random bytes however they are labelled,
 *      a truncated JPEG, an empty or oversized file, and a pixel bomb.
 *   B. THE SOURCE. The browser never writes to storage; /api/style/submit is the
 *      only writer and checks session → purchase → bytes → private store →
 *      save-with-the-customer's-session → removes its file on failure. Every
 *      route checks origin or admin; withdrawal, rejection, take-off, admin
 *      delete and account deletion each remove their files; the admin queue
 *      shows originals by signed URL, unoptimised; still no cron.
 *   C. THE DATABASE. Every migration replayed, unmodified, acting through the
 *      real policies as anonymous, a non-buyer, two buyers of one piece, an aal2
 *      admin and the service role. storage.objects has Supabase's own grants
 *      to the API roles, so a refusal below is a POLICY refusing.
 *
 * Without embedded-postgres the database half is skipped and the run exits
 * non-zero rather than passing.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  STYLE_GALLERY_BUCKET,
  STYLE_PHOTO_BUCKET,
  STYLE_PHOTO_MAX_BYTES,
  isUuid,
  selectForRemoval,
  styleGalleryName,
  stylePhotoPath,
} from "../lib/stylePhotoStorage";
import { normalizeStylePhoto, StylePhotoRejected } from "../lib/stylePhotoValidate";
import { asAdmin, asRoot, asService, asUser, failure, makeAdmin, startEngine } from "./pg-world";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const GALLERY = "https://wxumlixnmwgeqswknhpw.supabase.co/storage/v1/object/public/style-gallery/";
const uuid = () => crypto.randomUUID();

(async () => {
  // ══ A. The bytes ══════════════════════════════
  console.log("\nA. what counts as a photograph (real sharp)");
  const refused = async (bytes: Uint8Array) => {
    try {
      await normalizeStylePhoto(bytes);
      return false;
    } catch (e) {
      return e instanceof StylePhotoRejected;
    }
  };
  const photo = await sharp({ create: { width: 1200, height: 1500, channels: 3, background: { r: 150, g: 40, b: 30 } } })
    .jpeg({ quality: 80 })
    .withExif({ IFD0: { Artist: "secret-artist-tag" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "9/1 58/1 0/1" } })
    .toBuffer();
  t("the test photograph really carries EXIF", Boolean((await sharp(photo).metadata()).exif) && photo.includes("secret-artist-tag"));
  const ok = await normalizeStylePhoto(new Uint8Array(photo));
  t("a real JPEG is accepted and re-encoded as JPEG", ok.jpeg[0] === 0xff && ok.jpeg[1] === 0xd8 && (await sharp(ok.jpeg).metadata()).format === "jpeg");
  t("its real dimensions are reported (1200×1500)", ok.width === 1200 && ok.height === 1500);
  t("EXIF — camera details, GPS position — is gone from what is stored",
    !(await sharp(ok.jpeg).metadata()).exif && !ok.jpeg.includes("secret-artist-tag"));

  const payload = Buffer.from("<script>alert(document.cookie)</script><html><body>x</body></html>");
  const polyglot = await normalizeStylePhoto(new Uint8Array(Buffer.concat([photo, payload])));
  t("a script appended after the image does not survive re-encoding", !polyglot.jpeg.includes("<script>") && !polyglot.jpeg.includes("<html>"));
  // A COM segment (FF FE) carrying HTML, inserted straight after SOI.
  const comment = Buffer.from("<svg onload=alert(1)>");
  const com = Buffer.concat([photo.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, comment.length + 2]), comment, photo.subarray(2)]);
  const fromCom = await normalizeStylePhoto(new Uint8Array(com));
  t("HTML hidden in a JPEG comment does not survive either", !fromCom.jpeg.includes("onload"));

  const big = await sharp({ create: { width: 3000, height: 4500, channels: 3, background: "#777" } }).jpeg().toBuffer();
  const shrunk = await normalizeStylePhoto(new Uint8Array(big));
  t("an over-wide photograph is brought within 2000px wide", shrunk.width === 2000 && shrunk.height === 3000);

  const png = await sharp(photo).png().toBuffer();
  const gif = await sharp(photo).gif().toBuffer();
  const webp = await sharp(photo).webp().toBuffer();
  t("PNG bytes are refused, whatever they are called", await refused(new Uint8Array(png)));
  t("GIF bytes are refused", await refused(new Uint8Array(gif)));
  t("WebP bytes are refused (the browser always sends JPEG)", await refused(new Uint8Array(webp)));
  t("SVG is refused", await refused(new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'))));
  t("HTML is refused", await refused(new Uint8Array(Buffer.from("<!doctype html><html><script>alert(1)</script></html>"))));
  t("a JPEG signature followed by junk is refused (it must decode)",
    await refused(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5000)]))));
  t("a truncated JPEG is refused", await refused(new Uint8Array(photo.subarray(0, Math.floor(photo.length / 2)))));
  t("an empty file is refused", await refused(new Uint8Array(0)));
  t("a file over 4 MiB is refused before decoding",
    await refused(new Uint8Array(Buffer.concat([photo, Buffer.alloc(STYLE_PHOTO_MAX_BYTES)]))));
  const bomb = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: "#fff" } }).jpeg({ quality: 10 }).toBuffer();
  t(`a small file that decodes to 49 megapixels is refused (${Math.round(bomb.length / 1024)} KB on disk)`, await refused(new Uint8Array(bomb)));

  // ── Pure: names and what a cleanup may touch ──
  console.log("\nnames, and what one cleanup may touch");
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const Pp = "33333333-3333-4333-8333-333333333333";
  const F = "44444444-4444-4444-8444-444444444444";
  const S1 = "55555555-5555-4555-8555-555555555555";
  const S2 = "66666666-6666-4666-8666-666666666666";
  const rows = [
    { bucket: STYLE_PHOTO_BUCKET, name: `${A}/${Pp}/${F}.jpg`, reason: "owner gone" },
    { bucket: STYLE_PHOTO_BUCKET, name: `${B}/${Pp}/${F}.jpg`, reason: "unused" },
    { bucket: STYLE_PHOTO_BUCKET, name: `${A}/../${B}/${F}.jpg`, reason: "unused" },
    { bucket: STYLE_PHOTO_BUCKET, name: `${A}/${Pp}/${F}.jpg.html`, reason: "unused" },
    { bucket: STYLE_GALLERY_BUCKET, name: `${S1}/${F}.jpg`, reason: "submission gone" },
    { bucket: STYLE_GALLERY_BUCKET, name: `${S2}/${F}.jpg`, reason: "not published" },
    { bucket: STYLE_GALLERY_BUCKET, name: `${S1}/../${F}.jpg`, reason: "not published" },
    { bucket: "product-images", name: `${A}/${Pp}/${F}.jpg`, reason: "unused" },
  ];
  const mineOnly = selectForRemoval(rows, { ownerId: A, submissionIds: [S1] });
  t("one customer's cleanup: their originals and their submissions' copies only",
    JSON.stringify(mineOnly) === JSON.stringify({ originals: [`${A}/${Pp}/${F}.jpg`], copies: [`${S1}/${F}.jpg`] }));
  t("…case-insensitively", selectForRemoval(rows, { ownerId: A.toUpperCase(), submissionIds: [S1.toUpperCase()] }).copies.length === 1);
  const all = selectForRemoval(rows);
  t("the admin sweep takes every well-formed name in the two style buckets, nothing else",
    all.originals.length === 2 && all.copies.length === 2 && !JSON.stringify(all).includes(".."));
  t("stylePhotoPath is <owner>/<product>/<id>.jpg", stylePhotoPath(A, Pp, F) === `${A}/${Pp}/${F}.jpg`);
  t("styleGalleryName is <submission>/<id>.jpg", styleGalleryName(S1, F) === `${S1}/${F}.jpg`);
  const L = "abcdef01-2345-4789-8abc-def012345678";
  t("isUuid refuses anything but a lowercase uuid", isUuid(L) && !isUuid(L.toUpperCase()) && !isUuid(`${L}/x`) && !isUuid(42));

  // ══ B. Source ═════════════════════════════════
  console.log("\nB. source: who writes, who removes");
  const form = read("components/style/StyleSubmissionForm.tsx");
  const share = read("components/style/ShareYourStyle.tsx");
  const manager = read("components/admin/StyleManager.tsx");
  const submit = read("app/api/style/submit/route.ts");
  const withdraw = read("app/api/style/withdraw/route.ts");
  const delRoute = read("app/api/account/delete/route.ts");
  const moderate = read("app/api/admin/style/moderate/route.ts");
  const adminDelete = read("app/api/admin/style/delete/route.ts");
  const reject = read("app/api/admin/style/reject/route.ts");
  const sweepRoute = read("app/api/admin/style/sweep/route.ts");
  const danger = read("components/account/DangerZone.tsx");
  const sameOrigin = /isSameOrigin\(request\)/;
  const adminGate = /await adminApiGate\(request\)[\s\S]*rpc\("is_admin"\)[\s\S]*isAdmin !== true/;

  const componentFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) componentFiles.push(p);
    }
  };
  walk("components");
  t("no component writes to storage or holds the service key",
    componentFiles.every((f) => { const s = fs.readFileSync(f, "utf8"); return !/\.upload\(/.test(s) && !/createServiceClient/.test(s); }));
  t("the form posts everything to /api/style/submit and touches no storage itself",
    /fetch\("\/api\/style\/submit", \{ method: "POST", body \}\)/.test(form) && !/\.storage\b/.test(form) && !/from\("style_submissions"\)/.test(form));

  t("submit: same-origin, the user from the session", sameOrigin.test(submit) && /auth\.getUser\(\)/.test(submit) && !/form\.get\("user_id"\)/.test(submit));
  const order = ["auth.getUser()", 'rpc("style_photo_upload_allowed"', "normalizeStylePhoto(", ".upload(path", 'from("style_submissions")'];
  const at = order.map((s) => submit.indexOf(s));
  t("submit: session → purchase check → bytes → private store → save, in that order",
    at.every((i) => i > 0) && at.every((i, k) => k === 0 || i > at[k - 1]), JSON.stringify(at));
  t("submit: the size is checked before the bytes are read", submit.indexOf("photo.size > STYLE_PHOTO_MAX_BYTES") < submit.indexOf("photo.arrayBuffer()"));
  t("submit: stores only in the PRIVATE bucket, at a name it makes, never upsert",
    /storage\.from\(STYLE_PHOTO_BUCKET\)\.upload\(path, normalized\.jpeg/.test(submit) && /stylePhotoPath\(user\.id, productId, randomUUID\(\)\)/.test(submit)
    && /upsert: false/.test(submit) && /contentType: "image\/jpeg"/.test(submit) && !/STYLE_GALLERY_BUCKET/.test(submit));
  t("submit: the submission is saved with the CUSTOMER'S session (RLS + trigger judge it)",
    /await supabase\s*\.from\("style_submissions"\)\s*\.insert/.test(submit) && /supabase\.rpc\("resubmit_style"/.test(submit));
  t("submit: a failed save removes the file it stored before replying",
    /catch \(e\) \{\s*\/\/ Saved nothing, so keep nothing\.\s*if \(stored\) await service\.storage\.from\(STYLE_PHOTO_BUCKET\)\.remove\(\[stored\.path\]\)/.test(submit));
  t("submit: a resubmission removes the previous original, only inside the customer's folder",
    /previousPath\.startsWith\(`\$\{user\.id\}\/`\)[\s\S]*remove\(\[previousPath\]\)/.test(submit));

  t("withdraw: same-origin, session, the customer's own row, then their files before replying",
    sameOrigin.test(withdraw) && /auth\.getUser\(\)/.test(withdraw) && /\.update\(\{ withdrawn_at:[\s\S]*\.eq\("user_id", user\.id\)/.test(withdraw)
    && /sweepStylePhotos\(createServiceClient\(\), \{ ownerId: user\.id, submissionIds: \[id\] \}\)/.test(withdraw));
  t("taking it down from the site goes through that route", /fetch\("\/api\/style\/withdraw"/.test(share) && !/\.update\(/.test(share));

  t("Delete Account posts to /api/account/delete", /fetch\("\/api\/account\/delete", \{ method: "POST" \}\)/.test(danger) && !/rpc\(/.test(danger));
  t("account delete: same-origin, session, ids noted BEFORE delete_my_account, files AFTER it",
    sameOrigin.test(delRoute) && /auth\.getUser\(\)/.test(delRoute)
    && delRoute.indexOf('from("style_submissions").select("id")') < delRoute.indexOf('rpc("delete_my_account")')
    && delRoute.indexOf('rpc("delete_my_account")') < delRoute.indexOf("sweepStylePhotos(") && /if \(!result\?\.ok\) return/.test(delRoute));
  t("account delete: scoped to that customer, nothing read from the request",
    /sweepStylePhotos\(createServiceClient\(\), \{ ownerId: user\.id, submissionIds \}\)/.test(delRoute) && !/request\.json\(\)|searchParams|formData/.test(delRoute));

  t("moderate: admin-gated", adminGate.test(moderate));
  t("approve: original read privately, copy written to the PUBLIC bucket, recorded with the ADMIN'S session",
    /storage\.from\(STYLE_PHOTO_BUCKET\)\.download\(row\.photo_path\)/.test(moderate) && /storage\.from\(STYLE_GALLERY_BUCKET\)\.upload\(copy!\.name/.test(moderate)
    && /supabase\.rpc\("approve_style", \{ p_id: id, p_public_name: copy\.name \}\)/.test(moderate));
  t("approve: if recording fails the copy is removed; if a sweep raced it, it is made again",
    /if \(rpcError\) \{\s*await service\.storage\.from\(STYLE_GALLERY_BUCKET\)\.remove\(\[copy\.name\]\)/.test(moderate) && /exists\(copy\.name\)[\s\S]*if \(!there\) await put\(\)/.test(moderate));
  t("take off / silent reject: moderate_style with the admin's session, then the sweep",
    /supabase\.rpc\("moderate_style"/.test(moderate) && /sweepStylePhotos\(service\)/.test(moderate));
  t("reject with a reason also takes the public copy down", adminGate.test(reject) && reject.indexOf('rpc("moderate_style"') < reject.indexOf("sweepStylePhotos(createServiceClient())"));
  t("admin delete: admin-gated, row deleted with the admin's session, original removed by name, then the sweep",
    adminGate.test(adminDelete) && /await supabase\s*\.from\("style_submissions"\)\s*\.delete\(\)/.test(adminDelete)
    && /storage\.from\(STYLE_PHOTO_BUCKET\)\.remove\(\[original\]\)/.test(adminDelete) && /sweepStylePhotos\(service\)/.test(adminDelete));
  t("the sweep route is admin-gated", adminGate.test(sweepRoute) && /sweepStylePhotos\(createServiceClient\(\)\)/.test(sweepRoute));
  t("the admin queue: actions through the routes, never the RPC or table from the browser",
    /fetch\("\/api\/admin\/style\/moderate"/.test(manager) && /fetch\("\/api\/admin\/style\/delete"/.test(manager)
    && !/rpc\("moderate_style"/.test(manager) && !/\.delete\(\)/.test(manager));
  t("the admin queue shows originals by 10-minute signed URL, unoptimised",
    /createSignedUrls\(paths, 600\)/.test(manager) && /src=\{previews\[row\.photo_path\]\}[\s\S]{0,200}unoptimized/.test(manager));
  t("opening the admin queue runs the backstop sweep", /fetch\("\/api\/admin\/style\/sweep", \{ method: "POST" \}\)/.test(manager));
  t("the old browser cleanup route is gone", !fs.existsSync("app/api/style/cleanup"));
  t("still no Vercel cron (the project keeps none)", !fs.existsSync("vercel.json") && !fs.existsSync("app/api/cron"));
  t("the gallery still renders the public photo_url through next/image",
    /<Image\s+src=\{item\.photoUrl\}/.test(read("components/style/StyleCard.tsx")) && /hostname: "\*\.supabase\.co"/.test(read("next.config.mjs")));
  t("delete_my_account itself is untouched by 0073", !/delete_my_account/.test(read("supabase/migrations/0073_style_photo_storage_security.sql").replace(/^--.*$/gm, "")));

  // ══ C. The database ════════════════════════════
  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database half — embedded-postgres not found (set PG_HARNESS_DIR)");
    console.log(`\n${pass} passed, ${fail} failed (DB SKIPPED)\n`);
    process.exit(fail ? 1 : 2);
  }
  try {
    await engine.database("w");
    const c = await engine.connect("w");
    await asRoot(c);
    // Supabase grants these on storage.objects; RLS is what limits them.
    await c.query("grant select, insert, update, delete on storage.objects to anon, authenticated, service_role");

    const P1 = (await c.query("insert into products (name, slug, price_inr) values ('Kasavu saree', 'kasavu-saree', 1000) returning id")).rows[0].id as string;
    const P2 = (await c.query("insert into products (name, slug, price_inr) values ('Linen dhoti', 'linen-dhoti', 1000) returning id")).rows[0].id as string;

    const users: Record<string, string> = {};
    const customer = async (key: string) => {
      await asRoot(c);
      const email = `${key}@example.test`;
      const id = (await c.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id as string;
      await c.query("insert into profiles (id, email, full_name) values ($1, $2, $3) on conflict (id) do update set full_name = $3", [id, email, key]);
      users[key] = id;
    };
    const delivered = async (key: string, product: string) => {
      await asRoot(c);
      await c.query("insert into orders (customer_email, total_inr, items, payment_status, status) values ($1, 1000, $2::jsonb, 'paid', 'delivered')",
        [`${key}@example.test`, JSON.stringify([{ id: product, name: "x", quantity: 1, price_inr: 1000 }])]);
    };
    const as = async (key: string) => {
      await asUser(c, users[key], "aal1");
      await c.query("select set_config('request.jwt.claim.email', $1, false)", [`${key}@example.test`]);
    };
    const asAnon = async () => {
      await asRoot(c);
      await c.query("select set_config('request.jwt.claim.email', '', false)");
      await c.query("set role anon");
      await c.query("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', false)");
    };
    /** What the service key does in /api/style/submit and /api/admin/style/moderate. */
    const store = async (bucket: string, name: string, age = "0 seconds") => {
      await asRoot(c);
      await c.query("insert into storage.objects (bucket_id, name, created_at) values ($1, $2, now() - $3::interval)", [bucket, name, age]);
    };
    const put = (bucket: string, name: string) => failure(() => c.query("insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, name]));
    const list = async (bucket: string) => (await c.query("select name from storage.objects where bucket_id = $1", [bucket])).rows.map((r) => r.name as string);
    const del = async (bucket: string, name: string) => (await c.query("delete from storage.objects where bucket_id = $1 and name = $2", [bucket, name]).catch(() => ({ rowCount: 0 }))).rowCount ?? 0;
    const upd = async (bucket: string, name: string) => (await c.query("update storage.objects set name = name where bucket_id = $1 and name = $2", [bucket, name]).catch(() => ({ rowCount: 0 }))).rowCount ?? 0;
    const allowed = async (product: string) => (await c.query("select style_photo_upload_allowed($1) a", [product]).catch(() => ({ rows: [{ a: false }] }))).rows[0].a === true;
    const row = async (id: string) => { await asRoot(c); return (await c.query("select * from style_submissions where id = $1", [id])).rows[0]; };
    const garbage = async (grace = "1 hour") => {
      await asService(c);
      return (await c.query("select bucket, name, reason from style_photo_garbage($1::interval)", [grace])).rows as { bucket: string; name: string; reason: string }[];
    };
    const named = (g: { bucket: string; name: string; reason: string }[], bucket: string, name: string, reason?: string) =>
      g.some((r) => r.bucket === bucket && r.name === name && (!reason || r.reason === reason));

    await customer("buyer");    // delivered P1
    await customer("buyer2");   // delivered P1 too
    await customer("stranger"); // nothing
    await delivered("buyer", P1);
    await delivered("buyer2", P1);
    const admin = await makeAdmin(c, "admin@example.test");

    console.log("\nC1. the buckets");
    await asRoot(c);
    const bucket = async (id: string) => (await c.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1", [id])).rows[0];
    const orig = await bucket("style-photos");
    const gal = await bucket("style-gallery");
    t("style-photos (what customers send) is PRIVATE", orig.public === false);
    t("style-gallery (approved copies) is public", gal?.public === true);
    t("both: 4 MiB, image/jpeg only",
      [orig, gal].every((b) => Number(b.file_size_limit) === 4 * 1024 * 1024 && JSON.stringify(b.allowed_mime_types) === JSON.stringify(["image/jpeg"])));
    t("product-images is untouched", (await c.query("select file_size_limit, allowed_mime_types from storage.buckets where id = 'product-images'")).rows.every((r) => r.file_size_limit === null));
    const policies = (await c.query("select policyname, cmd from pg_policies where schemaname='storage' and tablename='objects' and (qual like '%style-%' or with_check like '%style-%')")).rows;
    t("exactly one storage policy names a style bucket: admins may READ originals",
      policies.length === 1 && policies[0].policyname === "Admins read style submissions" && policies[0].cmd === "SELECT", JSON.stringify(policies));

    console.log("\nC2. nobody writes to storage directly");
    const buyerFile = `${users.buyer}/${P1}/${uuid()}.jpg`;
    for (const [who, enter] of [["anonymous", asAnon], ["a non-buyer", () => as("stranger")], ["a buyer", () => as("buyer")], ["an aal2 admin", () => asAdmin(c, admin)]] as const) {
      await enter();
      const r1 = await put("style-photos", who === "a buyer" ? buyerFile : `${users.stranger}/${P1}/${uuid()}.jpg`);
      const r2 = await put("style-gallery", `${uuid()}/${uuid()}.jpg`);
      t(`${who}: direct upload refused in both buckets`, r1 !== "" && r2 !== "");
    }
    await as("buyer");
    t("a customer still cannot write to product-images", (await put("product-images", `${users.buyer}/${uuid()}.jpg`)) !== "");

    console.log("\nC3. may this customer send one? (style_photo_upload_allowed)");
    await asAnon();
    t("anonymous: no", !(await allowed(P1)));
    await as("stranger");
    t("signed in, bought nothing: no", !(await allowed(P1)));
    await as("buyer");
    t("a delivered buyer, for that piece: yes", await allowed(P1));
    t("…for a piece they did not buy: no", !(await allowed(P2)));
    for (let i = 0; i < 5; i++) await store("style-photos", `${users.buyer}/${P1}/${uuid()}.jpg`);
    await as("buyer");
    t("five files for one piece, then no", !(await allowed(P1)));
    await asRoot(c);
    await c.query("delete from storage.objects where bucket_id = 'style-photos'");

    console.log("\nC4. a pending photograph is private");
    const mine = `${users.buyer}/${P1}/${uuid()}.jpg`;
    const theirs = `${users.buyer2}/${P1}/${uuid()}.jpg`;
    await store("style-photos", mine);
    await store("style-photos", theirs);
    await asAnon();
    t("anonymous sees no original (cannot list or sign one)", (await list("style-photos")).length === 0);
    await as("buyer2");
    t("another customer cannot see the buyer's original", !(await list("style-photos")).includes(mine));
    await as("buyer");
    t("…and the owner does not need to: no customer reads originals", (await list("style-photos")).length === 0);
    await asAdmin(c, admin);
    t("an admin can read originals, to review them", (await list("style-photos")).length === 2);
    t("nobody lists the public gallery bucket, not even an admin", (await list("style-gallery")).length === 0);
    for (const [who, enter] of [["another customer", () => as("buyer2")], ["the owner", () => as("buyer")], ["an admin", () => asAdmin(c, admin)]] as const) {
      await enter();
      t(`${who} cannot delete or overwrite an original directly`, (await del("style-photos", mine)) === 0 && (await upd("style-photos", mine)) === 0);
    }

    console.log("\nC5. a submission names only its owner's own original");
    await as("buyer");
    const insert = (photoPath: string | null, product = P1, extra: Record<string, unknown> = {}) =>
      failure(() => c.query(
        `insert into style_submissions (product_id, user_id, photo_path, photo_url, video_platform, video_url, consented_at)
         values ($1, $2, $3, $4, $5, $6, now())`,
        [product, users.buyer, photoPath, extra.photo_url ?? null, extra.video ? "youtube" : null, extra.video ?? null]));
    t("a path that does not exist refused", /did not upload properly/.test(await insert(`${users.buyer}/${P1}/${uuid()}.jpg`)));
    t("ANOTHER customer's original refused", /did not upload properly/.test(await insert(theirs)));
    t("their own original under another piece refused", (await insert(mine, P2)) !== "");
    t("a malformed path refused", /did not upload properly/.test(await insert(`${users.buyer}/${P1}/../${mine}`)));
    t("neither a photograph nor a link refused", (await insert(null)) !== "");
    t("their own existing original accepted", (await insert(mine, P1, { photo_url: `${GALLERY}x/y.jpg` })) === "");
    await asRoot(c);
    const sid = (await c.query("select id from style_submissions where user_id = $1", [users.buyer])).rows[0].id as string;
    t("…and a public address smuggled into the insert is dropped (pending has none)", (await row(sid)).photo_url === null);
    await as("buyer");
    t("a customer cannot change photo_path or photo_url themselves",
      (await failure(() => c.query("update style_submissions set photo_path = $1 where id = $2", [theirs, sid]))) !== ""
      && (await failure(() => c.query("update style_submissions set photo_url = $1 where id = $2", [`${GALLERY}${sid}/${uuid()}.jpg`, sid]))) !== "");
    await as("buyer2");
    const sid2 = (await c.query(
      "insert into style_submissions (product_id, user_id, photo_path, photo_width, photo_height, consented_at) values ($1, $2, $3, 1200, 1500, now()) returning id",
      [P1, users.buyer2, theirs])).rows[0].id as string;
    await as("buyer");
    t("a customer cannot read another customer's submission row", (await c.query("select 1 from style_submissions where id = $1", [sid2])).rowCount === 0);

    console.log("\nC6. the shop is told there is a photograph");
    await as("buyer");
    const claim = (await c.query("select claim_style_notification($1) n", [sid])).rows[0].n as { has_photo: boolean };
    t("claim_style_notification still says has_photo for a private original", claim?.has_photo === true);
    await asAdmin(c, admin);
    const queue = (await c.query("select admin_style_submissions() q")).rows[0].q as Array<{ id: string; photo_path: string; photo_url: string | null }>;
    t("the admin queue carries photo_path (to sign) and no public address yet",
      queue.some((r) => r.id === sid && r.photo_path === mine && r.photo_url === null));

    console.log("\nC7. approval publishes a COPY, and only approval does");
    await asAdmin(c, admin);
    t("moderate_style cannot approve a photograph (no public copy)", /approve_style/.test(await failure(() => c.query("select moderate_style($1, 'approved')", [sid]))));
    t("approve_style without a copy name refused", /not made/.test(await failure(() => c.query("select approve_style($1, null)", [sid]))));
    t("approve_style with a name whose file does not exist refused", (await failure(() => c.query("select approve_style($1, $2)", [sid, styleGalleryName(sid, uuid())]))) !== "");
    const elsewhere = styleGalleryName(sid2, uuid());
    await store("style-gallery", elsewhere);
    await asAdmin(c, admin);
    t("approve_style with ANOTHER submission's copy refused", /not made/.test(await failure(() => c.query("select approve_style($1, $2)", [sid, elsewhere]))));
    const copy1 = styleGalleryName(sid, uuid());
    await store("style-gallery", copy1);
    await as("buyer");
    t("a customer cannot approve their own", /Only admins/.test(await failure(() => c.query("select approve_style($1, $2)", [sid, copy1]))));
    await asAdmin(c, admin);
    t("an admin approves with the copy", (await failure(() => c.query("select approve_style($1, $2)", [sid, copy1]))) === "");
    t("photo_url is exactly the public copy's address", (await row(sid)).photo_url === `${GALLERY}${copy1}` && (await row(sid)).reviewed_by === admin);
    await asAnon();
    t("anonymous sees it in the public view", (await c.query("select photo_url from public_style_submissions")).rows.some((r) => r.photo_url === `${GALLERY}${copy1}`));
    t("…and the view still shows nothing pending", (await c.query("select 1 from public_style_submissions where id = $1", [sid2])).rowCount === 0);
    await asAdmin(c, admin);
    t("an admin cannot point photo_url anywhere else by hand",
      (await failure(() => c.query("update style_submissions set photo_url = 'https://evil.example/x.jpg' where id = $1", [sid]))) !== ""
      && (await failure(() => c.query("update style_submissions set photo_url = $1 where id = $2", [`${GALLERY}${elsewhere}`, sid]))) !== "");
    let g = await garbage();
    t("the published copy and its original are never named", !named(g, "style-gallery", copy1) && !named(g, "style-photos", mine));
    t("a copy no published row uses is named at once ('not published')", named(g, "style-gallery", elsewhere, "not published"));

    console.log("\nC8. taken off, rejected, withdrawn: the public copy goes");
    await asAdmin(c, admin);
    await c.query("select moderate_style($1, 'pending')", [sid]);
    t("taking it off clears photo_url", (await row(sid)).photo_url === null);
    g = await garbage();
    t("…and names the copy at once", named(g, "style-gallery", copy1, "not published"));
    const copy2 = styleGalleryName(sid, uuid());
    await store("style-gallery", copy2);
    await asAdmin(c, admin);
    await c.query("select approve_style($1, $2)", [sid, copy2]);
    g = await garbage();
    t("re-approval publishes a NEW copy; the old one stays named", named(g, "style-gallery", copy1) && !named(g, "style-gallery", copy2));
    await asAdmin(c, admin);
    await c.query("select moderate_style($1, 'rejected', 'blurry')", [sid]);
    t("rejecting clears photo_url", (await row(sid)).photo_url === null);
    g = await garbage();
    t("…and names the copy at once; the private original is kept for the customer's resubmission",
      named(g, "style-gallery", copy2, "not published") && !named(g, "style-photos", mine));

    await as("buyer");
    t("resubmit with another customer's original refused", /did not upload properly/.test(await failure(() => c.query("select resubmit_style($1, $2, 1200, 1500)", [sid, theirs]))));
    const second = `${users.buyer}/${P1}/${uuid()}.jpg`;
    await store("style-photos", second);
    await as("buyer");
    t("resubmit with their own new original accepted", (await failure(() => c.query("select resubmit_style($1, $2, 1200, 1500)", [sid, second]))) === "");
    await store("style-photos", `${users.buyer}/${P1}/${uuid()}.jpg`, "2 hours");
    g = await garbage();
    t("the replaced original is unused (the route removes it at once; the sweep after an hour)",
      !named(g, "style-photos", mine) && (await garbage("0 seconds")).some((r) => r.name === mine && r.reason === "unused"));
    t("an unused original older than an hour is named (a request that died mid-save)",
      g.some((r) => r.bucket === "style-photos" && r.reason === "unused" && r.name !== mine));

    const copy3 = styleGalleryName(sid, uuid());
    await store("style-gallery", copy3);
    await asAdmin(c, admin);
    await c.query("select approve_style($1, $2)", [sid, copy3]);
    await as("buyer");
    await c.query("update style_submissions set withdrawn_at = now() where id = $1", [sid]);
    t("withdrawing (the customer's own update) clears photo_url in the same statement", (await row(sid)).photo_url === null);
    await asAnon();
    t("…and it is out of the public view", (await c.query("select 1 from public_style_submissions where id = $1", [sid])).rowCount === 0);
    g = await garbage();
    t("the withdrawn copy is named at once", named(g, "style-gallery", copy3, "not published"));
    t("the withdrawn original is named at once", named(g, "style-photos", second, "consent withdrawn"));
    const r1 = selectForRemoval(g, { ownerId: users.buyer, submissionIds: [sid] });
    t("the withdraw route's scoped cleanup takes both", r1.copies.includes(copy3) && r1.originals.includes(second));
    const r2 = selectForRemoval(g, { ownerId: users.buyer2, submissionIds: [sid2] });
    t("another customer's scoped cleanup could not reach them", !r2.copies.includes(copy3) && !r2.originals.includes(second));
    await asAdmin(c, admin);
    t("a withdrawn submission cannot be approved again", /withdrawn/.test(await failure(() => c.query("select approve_style($1, $2)", [sid, copy3]))));

    console.log("\nC9. who may run the sweep");
    for (const [who, enter] of [["a customer", () => as("buyer")], ["an admin's own session", () => asAdmin(c, admin)], ["anonymous", asAnon]] as const) {
      await enter();
      t(`${who} cannot call style_photo_garbage`, (await failure(() => c.query("select * from style_photo_garbage()"))) !== "");
    }

    console.log("\nC10. admin delete");
    const copyB2 = styleGalleryName(sid2, uuid());
    await store("style-gallery", copyB2);
    await asAdmin(c, admin);
    await c.query("select approve_style($1, $2)", [sid2, copyB2]);
    await asAdmin(c, admin);
    const gone = (await c.query("delete from style_submissions where id = $1 returning photo_path", [sid2])).rows[0];
    t("an admin deletes the row and learns its original (the route removes it by name)", gone?.photo_path === theirs);
    g = await garbage();
    t("its public copies are named at once ('submission gone')", named(g, "style-gallery", copyB2, "submission gone") && named(g, "style-gallery", elsewhere, "submission gone"));
    await asAnon();
    t("…and it left the public view with the row", (await c.query("select 1 from public_style_submissions where id = $1", [sid2])).rowCount === 0);

    console.log("\nC11. account deletion");
    await asRoot(c);
    await c.query("delete from storage.objects");
    await c.query("delete from style_submissions");
    const live = `${users.buyer}/${P1}/${uuid()}.jpg`;
    const other = `${users.buyer2}/${P1}/${uuid()}.jpg`;
    await store("style-photos", live);
    await store("style-photos", other);
    await as("buyer");
    const sidA = (await c.query("insert into style_submissions (product_id, user_id, photo_path, consented_at) values ($1, $2, $3, now()) returning id", [P1, users.buyer, live])).rows[0].id as string;
    await as("buyer2");
    const sidB = (await c.query("insert into style_submissions (product_id, user_id, photo_path, consented_at) values ($1, $2, $3, now()) returning id", [P1, users.buyer2, other])).rows[0].id as string;
    const pubA = styleGalleryName(sidA, uuid());
    const pubB = styleGalleryName(sidB, uuid());
    await store("style-gallery", pubA);
    await store("style-gallery", pubB);
    await asAdmin(c, admin);
    await c.query("select approve_style($1, $2)", [sidA, pubA]);
    await asAdmin(c, admin);
    await c.query("select approve_style($1, $2)", [sidB, pubB]);
    await asRoot(c);
    await c.query("insert into orders (customer_email, customer_name, total_inr, items, payment_status, status) values ('buyer@example.test', 'Buyer', 500, '[]'::jsonb, 'paid', 'delivered')");
    await as("buyer");
    const ids = (await c.query("select id from style_submissions where user_id = $1", [users.buyer])).rows.map((r) => r.id as string);
    t("the route can read the customer's submission ids first", JSON.stringify(ids) === JSON.stringify([sidA]));
    const res = (await c.query("select delete_my_account() r")).rows[0].r as { ok: boolean; orders_anonymised: number };
    t("delete_my_account still succeeds and anonymises orders", res.ok === true && res.orders_anonymised === 2, JSON.stringify(res));
    g = await garbage();
    t("their original is named ('owner gone') and their public copy ('submission gone')",
      named(g, "style-photos", live, "owner gone") && named(g, "style-gallery", pubA, "submission gone"));
    await asAnon();
    t("their photograph left the public view at once", !(await c.query("select photo_url from public_style_submissions")).rows.some((r) => r.photo_url === `${GALLERY}${pubA}`));
    const scoped = selectForRemoval(g, { ownerId: users.buyer, submissionIds: ids });
    t("the route's scoped cleanup takes exactly those two", JSON.stringify(scoped) === JSON.stringify({ originals: [live], copies: [pubA] }));
    t("the other buyer's published photograph is untouched", !named(g, "style-photos", other) && !named(g, "style-gallery", pubB));

    await c.end();
  } finally {
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
