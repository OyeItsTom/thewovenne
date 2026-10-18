/**
 * Customer style photographs at the storage boundary (0073).
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/style-photo-storage.test.ts
 *
 * The database half replays every migration, unmodified, and acts through the
 * real policies as each role: anonymous, a signed-in non-buyer, two buyers of
 * the same piece, and an aal2 admin. storage.objects is given Supabase's own
 * grants to the API roles, so a refusal below is a POLICY refusing, not a
 * missing grant.
 *
 * What is proven:
 *   1. Upload: anonymous and non-buyers refused; a buyer may write only
 *      <own id>/<bought product>/<uuid>.jpg, at most five per piece; every
 *      path trick refused; nobody overwrites.
 *   2. Reading records: no listing for anonymous or another customer; owner
 *      and admin see theirs/all.
 *   3. Removing: another customer cannot; the owner only an unused file; the
 *      admin can.
 *   4. photo_url must be this bucket's address for an existing object in the
 *      submitter's own folder for the same piece — on insert and resubmit.
 *   5. style_photo_garbage: owner gone, consent withdrawn, unused after a day;
 *      never a used file; service role only. Account deletion makes exactly
 *      that account's files removable, and selectForRemoval never reaches
 *      another folder.
 *   6. The bucket: public, 8 MiB, image/jpeg only. Admin queue and moderation
 *      still work; delete_my_account still anonymises orders.
 *   7. Source: the form uploads to the 0073 path as image/jpeg and cleans up
 *      after a failed save; Delete Account goes through the route; withdrawal
 *      and admin delete remove the file; the admin queue runs the backstop
 *      sweep; every route checks origin or admin; still no cron.
 *
 * Without embedded-postgres the database half is skipped and the run exits
 * non-zero rather than passing.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { selectForRemoval, stylePhotoNameFromUrl, stylePhotoPath } from "../lib/stylePhotoStorage";
import { asAdmin, asRoot, asService, asUser, failure, makeAdmin, startEngine, type Client } from "./pg-world";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const BASE = "https://wxumlixnmwgeqswknhpw.supabase.co/storage/v1/object/public/style-photos/";
const uuid = () => crypto.randomUUID();

// ── Pure: what a cleanup may touch ───────────
console.log("\nselectForRemoval — a second lock on what gets deleted");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const F = "44444444-4444-4444-8444-444444444444";
const rows = [
  { name: `${A}/${P}/${F}.jpg`, reason: "owner gone" },
  { name: `${B}/${P}/${F}.jpg`, reason: "unused" },
  { name: `${A}/../${B}/${F}.jpg`, reason: "unused" },
  { name: `${A}/${P}/${F}.jpg.html`, reason: "unused" },
  { name: `${A}/${F}.jpg`, reason: "unused" },
];
t("one account's cleanup reaches only that account's folder", JSON.stringify(selectForRemoval(rows, A)) === JSON.stringify([`${A}/${P}/${F}.jpg`]));
t("…case-insensitively on the id it is given", selectForRemoval(rows, A.toUpperCase()).length === 1);
t("the daily sweep takes every well-formed name and no malformed one", JSON.stringify(selectForRemoval(rows)) === JSON.stringify([`${A}/${P}/${F}.jpg`, `${B}/${P}/${F}.jpg`]));
t("stylePhotoPath is <owner>/<product>/<id>.jpg", stylePhotoPath(A, P, F) === `${A}/${P}/${F}.jpg`);
const SB = "https://wxumlixnmwgeqswknhpw.supabase.co";
t("stylePhotoNameFromUrl reads our own address back to its key", stylePhotoNameFromUrl(`${SB}/storage/v1/object/public/style-photos/${A}/${P}/${F}.jpg`, SB) === `${A}/${P}/${F}.jpg`);
t("…and refuses anyone else's address, another bucket, or a malformed key",
  [`https://other.supabase.co/storage/v1/object/public/style-photos/${A}/${P}/${F}.jpg`, `${SB}/storage/v1/object/public/product-images/${A}/${P}/${F}.jpg`, `${SB}/storage/v1/object/public/style-photos/${A}/../${F}.jpg`, null]
    .every((u) => stylePhotoNameFromUrl(u, SB) === null));

// ── Source rules ─────────────────────────────
console.log("\nsource: the browser, the routes, the schedule");
const form = read("components/style/StyleSubmissionForm.tsx");
const danger = read("components/account/DangerZone.tsx");
const delRoute = read("app/api/account/delete/route.ts");
const cleanup = read("app/api/style/cleanup/route.ts");
const sweepRoute = read("app/api/admin/style/sweep/route.ts");
const manager = read("components/admin/StyleManager.tsx");
const share = read("components/style/ShareYourStyle.tsx");
t("the form uploads to stylePhotoPath(user, product, uuid) as image/jpeg, never upsert",
  /stylePhotoPath\(user\.id, productId, crypto\.randomUUID\(\)\)/.test(form) && /contentType: "image\/jpeg"/.test(form) && /upsert: false/.test(form));
t("a failed save removes the photograph it just uploaded", /catch \(e\) \{[\s\S]*if \(uploadedPath\) \{[\s\S]*\.remove\(\[uploadedPath\]\)/.test(form));
t("Delete Account posts to /api/account/delete and no longer calls the RPC from the browser",
  /fetch\("\/api\/account\/delete", \{ method: "POST" \}\)/.test(danger) && !/rpc\(/.test(danger));
t("the delete route: same-origin only, the user from the session, delete_my_account BEFORE any file is touched",
  /new URL\(origin\)\.host === new URL\(request\.url\)\.host/.test(delRoute) && /auth\.getUser\(\)/.test(delRoute)
  && delRoute.indexOf('rpc("delete_my_account")') < delRoute.indexOf("sweepStylePhotos(") && /if \(!result\?\.ok\) return/.test(delRoute));
t("the delete route sweeps only that user's folder", /sweepStylePhotos\(createServiceClient\(\), \{ onlyOwnerId: user\.id \}\)/.test(delRoute));
t("the delete route reads no account id from the request body", !/request\.json\(\)|searchParams/.test(delRoute));
t("the customer cleanup route: same-origin, the session's own folder only, nothing read from the request",
  /new URL\(origin\)\.host === new URL\(request\.url\)\.host/.test(cleanup) && /onlyOwnerId: user\.id/.test(cleanup) && !/request\.json\(\)|searchParams/.test(cleanup));
t("withdrawing consent asks for the file to be taken down", /withdrawn_at[\s\S]*setWithdrawn\(true\);[\s\S]*fetch\("\/api\/style\/cleanup", \{ method: "POST" \}\)/.test(share));
t("the admin sweep route is behind adminApiGate and is_admin", /await adminApiGate\(request\)/.test(sweepRoute) && /rpc\("is_admin"\)[\s\S]*isAdmin !== true/.test(sweepRoute) && /sweepStylePhotos\(createServiceClient\(\)\)/.test(sweepRoute));
t("opening the admin queue runs the backstop sweep", /fetch\("\/api\/admin\/style\/sweep", \{ method: "POST" \}\)/.test(manager));
t("an admin delete removes the submission's file too", /\.from\("style_submissions"\)\s*\.delete\(\)[\s\S]*stylePhotoNameFromUrl\(row\.photo_url, SUPABASE_URL\)[\s\S]*\.remove\(\[file\]\)/.test(manager));
t("still no Vercel cron (the project keeps none)", !fs.existsSync("vercel.json") && !fs.existsSync("app/api/cron"));
t("delete_my_account itself is untouched by 0073", !/delete_my_account/.test(read("supabase/migrations/0073_style_photo_storage_security.sql").replace(/^--.*$/gm, "")));

(async () => {
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
    const put = (name: string) => c.query("insert into storage.objects (bucket_id, name) values ('style-photos', $1)", [name]);
    const sel = async () => (await c.query("select name from storage.objects where bucket_id = 'style-photos'")).rows.map((r) => r.name as string);
    const del = async (name: string) => (await c.query("delete from storage.objects where bucket_id = 'style-photos' and name = $1", [name])).rowCount ?? 0;
    const okPut = async (name: string) => (await failure(() => put(name))) === "";
    const exists = async (name: string) => { await asRoot(c); return (await c.query("select 1 from storage.objects where bucket_id='style-photos' and name=$1", [name])).rowCount === 1; };

    await customer("buyer");    // delivered P1
    await customer("buyer2");   // delivered P1 too
    await customer("stranger"); // nothing
    await delivered("buyer", P1);
    await delivered("buyer2", P1);
    const admin = await makeAdmin(c, "admin@example.test");

    // ── 6. The bucket ──
    console.log("\nthe bucket");
    await asRoot(c);
    const bucket = (await c.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'style-photos'")).rows[0];
    t("still public (approved photographs are served by URL)", bucket.public === true);
    t("8 MiB limit (PHOTO_GUIDANCE.maxBytes)", Number(bucket.file_size_limit) === 8 * 1024 * 1024);
    t("image/jpeg only", JSON.stringify(bucket.allowed_mime_types) === JSON.stringify(["image/jpeg"]));
    t("product-images is untouched", (await c.query("select file_size_limit, allowed_mime_types from storage.buckets where id = 'product-images'")).rows.every((r) => r.file_size_limit === null));

    // ── 1. Upload ──
    console.log("\nupload: who, where, how many");
    const mine = `${users.buyer}/${P1}/${uuid()}.jpg`;
    await asAnon();
    t("anonymous upload refused", !(await okPut(`${users.buyer}/${P1}/${uuid()}.jpg`)));
    await as("stranger");
    t("signed-in NON-buyer refused, even in their own folder", !(await okPut(`${users.stranger}/${P1}/${uuid()}.jpg`)));
    await as("buyer");
    t("buyer uploads <own id>/<bought product>/<uuid>.jpg", await okPut(mine));
    t("buyer refused for a product they did not buy", !(await okPut(`${users.buyer}/${P2}/${uuid()}.jpg`)));
    t("buyer refused in another buyer's folder", !(await okPut(`${users.buyer2}/${P1}/${uuid()}.jpg`)));
    const tricks = [
      `${users.buyer}/${P1}/../${uuid()}.jpg`,
      `${users.buyer}/${P1}/${uuid()}.png`,
      `${users.buyer}/${P1}/${uuid()}.jpg.html`,
      `${users.buyer}/${P1}/${uuid()}.JPG`,
      `${users.buyer}/${P1}/${uuid().toUpperCase()}.jpg`,
      `${users.buyer}/${P1}/sub/${uuid()}.jpg`,
      `${users.buyer}/${P1}//${uuid()}.jpg`,
      `/${users.buyer}/${P1}/${uuid()}.jpg`,
      `${users.buyer}/${uuid()}.jpg`,
      `${users.buyer}/${P1}/photo.jpg`,
      `${users.buyer}/not-a-uuid/${uuid()}.jpg`,
      `${users.buyer}/${P1}/${uuid()}.jpg\n`,
      `${users.buyer}/${P1}/${uuid()}.jpg/x`,
      "",
    ];
    const accepted: string[] = [];
    for (const name of tricks) if (await okPut(name)) accepted.push(JSON.stringify(name));
    t(`every path trick refused (${tricks.length} shapes)`, accepted.length === 0, accepted.join(", "));
    const wrongBucket = await failure(() => c.query("insert into storage.objects (bucket_id, name) values ('product-images', $1)", [`${users.buyer}/${P1}/${uuid()}.jpg`]));
    t("a customer still cannot write to product-images", wrongBucket !== "");
    for (let i = 0; i < 4; i++) await put(`${users.buyer}/${P1}/${uuid()}.jpg`);
    t("five per piece, then refused", !(await okPut(`${users.buyer}/${P1}/${uuid()}.jpg`)));
    const overwrite = await c.query("update storage.objects set name = name where name = $1", [mine]).then((r) => r.rowCount ?? 0).catch(() => 0);
    t("nobody overwrites a photograph (no UPDATE policy)", overwrite === 0);

    // ── 2. Reading records ──
    console.log("\nwho can see the records");
    await asAnon();
    t("anonymous cannot list the bucket", (await sel()).length === 0);
    await as("buyer2");
    const theirs = `${users.buyer2}/${P1}/${uuid()}.jpg`;
    await put(theirs);
    t("another customer sees only their own", JSON.stringify(await sel()) === JSON.stringify([theirs]));
    await as("buyer");
    t("the owner sees their five", (await sel()).length === 5 && !(await sel()).includes(theirs));
    await asAdmin(c, admin);
    t("an admin sees all six", (await sel()).length === 6);

    // ── 4. photo_url ──
    console.log("\nphoto_url must be ours, theirs, for this piece");
    await as("buyer");
    const submit = (url: string | null, product = P1, video: string | null = null) =>
      failure(() => c.query(
        `insert into style_submissions (product_id, user_id, photo_url, video_platform, video_url, consented_at)
         values ($1, $2, $3, $4, $5, now())`, [product, users.buyer, url, video ? "youtube" : null, video]));
    t("an outside address refused", (await submit("https://evil.example/x.jpg")) !== "");
    t("another Supabase project's address refused", (await submit(`https://other.supabase.co/storage/v1/object/public/style-photos/${mine}`)) !== "");
    t("our address for a file that does not exist refused", (await submit(`${BASE}${users.buyer}/${P1}/${uuid()}.jpg`)) !== "");
    t("our address for ANOTHER customer's file refused", (await submit(`${BASE}${theirs}`)) !== "");
    t("a file of the right owner but another product refused", (await submit(`${BASE}${mine}`, P2)) !== "");
    t("a suffix after a real address refused", (await submit(`${BASE}${mine}?x=1`)) !== "");
    t("our address for their own existing file accepted", (await submit(`${BASE}${mine}`)) === "");
    await asRoot(c);
    const sid = (await c.query("select id from style_submissions where user_id = $1", [users.buyer])).rows[0].id as string;
    await c.query("update style_submissions set status = 'rejected', reject_reason = 'blurry' where id = $1", [sid]);
    await as("buyer");
    const resub = (url: string) => failure(() => c.query("select resubmit_style($1, $2, 1200, 1500)", [sid, url]));
    t("resubmit with an outside address refused", /did not upload properly/.test(await resub("https://evil.example/y.jpg")));
    t("resubmit with another customer's file refused", /did not upload properly/.test(await resub(`${BASE}${theirs}`)));
    const second = `${users.buyer}/${P1}/${uuid()}.jpg`;
    await asRoot(c);
    await c.query("delete from storage.objects where name like $1 and name <> $2", [`${users.buyer}/${P1}/%`, mine]);
    await as("buyer");
    await put(second);
    t("resubmit with their own new file accepted", (await resub(`${BASE}${second}`)) === "");

    // ── 3. Removing ──
    console.log("\nwho can remove a file");
    await as("buyer2");
    t("another customer cannot remove the buyer's file", (await del(second)) === 0 && (await exists(second)));
    await as("buyer");
    t("the owner cannot remove a file a submission uses", (await del(second)) === 0 && (await exists(second)));
    t("the owner CAN remove their own unused file (failed-save cleanup)", (await del(mine)) === 1 && !(await exists(mine)));
    await asAdmin(c, admin);
    const extra = `${users.buyer2}/${P1}/${uuid()}.jpg`;
    await asRoot(c); await c.query("insert into storage.objects (bucket_id, name) values ('style-photos', $1)", [extra]);
    await asAdmin(c, admin);
    t("an admin can remove any style photo", (await del(extra)) === 1);

    // ── 5. Garbage ──
    console.log("\nwhat the sweep may remove");
    const garbage = async (grace = "24 hours") => {
      await asService(c);
      return (await c.query("select name, reason from style_photo_garbage($1::interval)", [grace])).rows as { name: string; reason: string }[];
    };
    await asRoot(c);
    const stale = `${users.buyer2}/${P1}/${uuid()}.jpg`;
    await c.query("insert into storage.objects (bucket_id, name, created_at) values ('style-photos', $1, now() - interval '2 days')", [stale]);
    let g = await garbage();
    t("a fresh unused file is left alone (an upload may be mid-save)", !g.some((r) => r.name === theirs));
    t("an unused file older than a day is named", g.some((r) => r.name === stale && r.reason === "unused"));
    t("a file a submission uses is never named", !g.some((r) => r.name === second));
    await as("buyer");
    await c.query("update style_submissions set withdrawn_at = now() where id = $1", [sid]);
    g = await garbage();
    t("a withdrawn submission's file is named at once", g.some((r) => r.name === second && r.reason === "consent withdrawn"));
    await as("buyer");
    t("customers cannot call it", (await failure(() => c.query("select * from style_photo_garbage()"))) !== "");
    await asAnon();
    t("anonymous cannot call it", (await failure(() => c.query("select * from style_photo_garbage()"))) !== "");

    // ── Account deletion ──
    console.log("\naccount deletion");
    await asRoot(c);
    await c.query("update style_submissions set withdrawn_at = null where id = $1", [sid]);
    await c.query("insert into orders (customer_email, customer_name, total_inr, items, payment_status, status) values ('buyer@example.test', 'Buyer', 500, '[]'::jsonb, 'paid', 'delivered')");
    const buyerFiles = (await c.query("select name from storage.objects where name like $1", [`${users.buyer}/%`])).rows.map((r) => r.name as string);
    await as("buyer");
    const res = (await c.query("select delete_my_account() r")).rows[0].r as { ok: boolean; orders_anonymised: number };
    t("delete_my_account still succeeds and anonymises orders", res.ok === true && res.orders_anonymised === 2, JSON.stringify(res));
    g = await garbage();
    const removable = selectForRemoval(g, users.buyer);
    t("every one of that account's files becomes removable ('owner gone')", buyerFiles.length > 0 && buyerFiles.every((f) => removable.includes(f)) && g.filter((r) => buyerFiles.includes(r.name)).every((r) => r.reason === "owner gone"));
    t("the per-account cleanup touches no other customer's file", removable.every((n) => n.startsWith(`${users.buyer}/`)) && !removable.includes(theirs));
    t("the other buyer's in-use or fresh files are not garbage", !g.some((r) => r.name === theirs));

    // ── Admin flow ──
    console.log("\nadmin flow still works");
    await asRoot(c);
    const okFile = `${users.buyer2}/${P1}/${uuid()}.jpg`;
    await c.query("insert into storage.objects (bucket_id, name) values ('style-photos', $1)", [okFile]);
    await as("buyer2");
    await c.query("insert into style_submissions (product_id, user_id, photo_url, photo_width, photo_height, consented_at) values ($1, $2, $3, 1200, 1500, now())", [P1, users.buyer2, `${BASE}${okFile}`]);
    await asAdmin(c, admin);
    const queue = (await c.query("select admin_style_submissions() q")).rows[0].q as Array<{ id: string; photo_url: string }>;
    t("the admin queue lists it with its photo_url", queue.some((r) => r.photo_url === `${BASE}${okFile}`));
    const sub2 = queue.find((r) => r.photo_url === `${BASE}${okFile}`)!.id;
    t("the admin can approve it", (await failure(() => c.query("select moderate_style($1, 'approved')", [sub2]))) === "");
    await asAnon();
    t("approved → in the public view, with its URL", (await c.query("select photo_url from public_style_submissions")).rows.some((r) => r.photo_url === `${BASE}${okFile}`));

    await c.end();
  } finally {
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
