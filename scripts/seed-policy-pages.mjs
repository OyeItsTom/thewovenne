/**
 * Fill in the body blocks for the three policy pages, through the CMS.
 *
 *   node scripts/seed-policy-pages.mjs            # dry run, writes nothing
 *   node scripts/seed-policy-pages.mjs --apply    # commits the DRAFTS
 *
 * Reads .env.local from the working directory, or --env <path> when it lives
 * elsewhere — this file is on a branch in a git worktree, and .env.local is not
 * checked in, so the two are not always in the same folder.
 *
 * WHY THIS EXISTS. Contact, Shipping & Delivery and Returns & Exchanges were
 * created with a title, a slug, an intro and a meta description, and no body.
 * Filling them by hand means adding forty blocks one at a time through a form,
 * which has now been attempted three times and produced three empty pages. This
 * does the same thing the form does, in one pass, with the text under review in
 * git rather than retyped.
 *
 * ── IT IS NOT A BACK DOOR ──
 *
 * It writes to DRAFTS ONLY, through ensure_page_draft() — the same SECURITY
 * DEFINER function Admin → Pages calls, which forks the published row
 * copy-on-write and refuses anyone who is not an admin. Nothing here publishes.
 * Nothing here can touch a published row: the id it updates is the one that RPC
 * returned, and its state is asserted to be 'draft' before a single write.
 *
 * So the flow is exactly the normal one, with the typing automated:
 *
 *     this script  →  drafts  →  you read them in Admin  →  Review & Publish
 *
 * is_admin() reads auth.uid(), so an anon or service-role connection cannot
 * call those RPCs at all. The claim is borrowed for the transaction the same
 * way scripts/cancel-guard.verify.mjs does it — the only way to exercise an
 * is_admin()-gated function from a script.
 *
 * EVERYTHING RUNS IN ONE TRANSACTION, and it is ROLLED BACK unless --apply is
 * given. That is what makes the dry run honest: it really calls the RPCs, really
 * writes the drafts, really reads them back, and then undoes all of it — so what
 * you see in a dry run is what --apply will leave behind, not a prediction.
 */
import fs from "node:fs";
import pg from "pg";

const APPLY = process.argv.includes("--apply");

/** The only pages this script may touch. FAQ is correct and is not here. */
const TARGET_SLUGS = ["contact", "shipping-delivery", "returns-exchanges"];
/** Legal pages whose customer-facing email is corrected, text untouched otherwise. */
const EMAIL_FIX_SLUGS = ["policies", "privacy-policy"];
const OLD_EMAIL = "admin@thewovenne.com";
const NEW_EMAIL = "hello@thewovenne.com";
/** This project, and no other. */
const EXPECTED_PROJECT_REF = "wxumlixnmwgeqswknhpw";

const h = (text) => ({ type: "heading", text });
const p = (text) => ({ type: "paragraph", text });

const BODIES = {
  contact: [
    h("Email"),
    p("hello@thewovenne.com — the best way to reach us about an order, a product or a return."),
    h("Phone and WhatsApp"),
    p("+91 7736749305. You can call this number or message it on WhatsApp."),
    h("Our address"),
    p("THE WOVENNE, Anns Building, Kidangara, Kerala 686102, India."),
    h("What to include"),
    p("If you are writing about an order, please include your order number and the email address you used at checkout. If something has arrived damaged or incorrect, please also see our Returns & Exchanges page before you write — it explains what we will ask for."),
  ],
  "shipping-delivery": [
    h("Where we deliver"),
    p("We currently deliver within India only. We are not shipping to other countries at this stage."),
    h("What delivery costs"),
    p("On orders below ₹3,000, delivery is ₹99 within Kerala and ₹129 elsewhere in India."),
    p("On orders of ₹3,000 or more, delivery is free anywhere in India."),
    h("When your order is dispatched"),
    p("Orders are usually dispatched within 1–3 business days of successful payment and order confirmation."),
    h("How long delivery takes"),
    p("Delivery usually takes around 4–10 working days from order to arrival."),
    p("These are estimates, not guarantees. Delivery can take longer because of the courier, the destination, weather, public holidays, or other circumstances outside our reasonable control."),
    h("Tracking"),
    p("Where tracking information is provided to us for your shipment, we will pass it on to you. We cannot promise tracking on every shipment."),
    h("If something goes wrong"),
    p("If your parcel arrives damaged, incomplete or incorrect, please see our Returns & Exchanges page and contact us within 7 days of delivery."),
  ],
  "returns-exchanges": [
    h("Change of mind"),
    p("We do not accept general returns or refunds for a change of mind. Please choose carefully, and contact us before ordering if you are unsure about a product."),
    h("If your item is damaged, faulty or incorrect"),
    p("Please contact us within 7 days of delivery at hello@thewovenne.com or on +91 7736749305 and tell us what has happened."),
    p("Please keep the product, its tags where applicable, and the original packaging where reasonably possible until we have finished looking into it. Photographs or video of the problem can help us investigate."),
    h("Recording an unboxing video"),
    p("We strongly recommend recording one continuous video as you open your parcel, starting before you open it and continuing until the product is fully unpacked."),
    p("An unboxing video can help us investigate damage in transit, missing items, incorrect products or parcel tampering more quickly."),
    p("An unboxing video is a recommendation, not a condition. If you do not have one, please still contact us. Nothing here limits any rights you have under applicable consumer law."),
    h("Size exchanges"),
    p("If a product is sold with a selectable size option, you may request a size exchange within 7 days of delivery, provided the replacement size is available, the item is unused and unworn apart from reasonable trying on, tags and packaging have been kept where applicable, and the item is otherwise eligible."),
    p("Products that are not sold with a size option, including sarees and other unsized pieces, cannot be size exchanged because there is no alternative size to exchange into."),
    h("Customised and personalised items"),
    p("Items made or personalised to your request cannot be returned or exchanged in the ordinary way. This does not affect the position where a customised item arrives genuinely damaged, faulty or incorrect."),
    h("Refunds"),
    p("Where a refund is approved, we will confirm the amount, method and applicable timing while resolving your case."),
    h("How to reach us"),
    p("Email hello@thewovenne.com or call/WhatsApp +91 7736749305."),
  ],
};

// ── env ──────────────────────────────────────
const envFlag = process.argv.indexOf("--env");
const ENV_PATH = envFlag !== -1 ? process.argv[envFlag + 1] : ".env.local";
if (!fs.existsSync(ENV_PATH)) {
  console.error(`\n  ERROR: no env file at ${ENV_PATH}. Pass --env <path/to/.env.local>\n`);
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

let failed = 0;
const fail = (msg) => { console.error(`\n  REFUSING: ${msg}\n`); failed++; };

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

/**
 * Compare two JSON values regardless of key order.
 *
 * Postgres jsonb does NOT preserve the key order it was given — it stores keys
 * sorted by length then bytewise, so a block written as {type, text} reads back
 * as {text, type}. JSON.stringify is order-sensitive, so comparing with it made
 * every read-back look like a MISMATCH when the content was byte-identical.
 * Canonicalising both sides first is the actual question being asked: is this
 * the same data?
 */
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function main() {
  // ── guard: the right project ───────────────
  const projectUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!projectUrl.includes(EXPECTED_PROJECT_REF)) {
    throw new Error(
      `this is not the Wovenne project — NEXT_PUBLIC_SUPABASE_URL does not contain ${EXPECTED_PROJECT_REF}`
    );
  }
  if (!env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is not set in .env.local");

  await client.connect();
  await client.query("begin");

  console.log(`\n  MODE: ${APPLY ? "APPLY — drafts will be COMMITTED" : "DRY RUN — everything is rolled back"}`);
  console.log(`  project: ${EXPECTED_PROJECT_REF}`);
  console.log(`  env    : ${ENV_PATH}\n`);

  // ── borrow an admin claim, exactly as cancel-guard.verify.mjs does ──
  const { rows: admins } = await client.query(
    "select id from profiles where is_admin = true order by created_at limit 1"
  );
  if (admins.length === 0) throw new Error("no admin profile to borrow — the CMS RPCs are unreachable");
  await client.query(
    "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
    [admins[0].id]
  );
  const { rows: who } = await client.query("select public.is_admin() as ok");
  if (who[0].ok !== true) throw new Error("the borrowed claim does not read as an admin");
  console.log("  session reads as admin: yes");

  // ══ 1. BODY BLOCKS ════════════════════════
  console.log("\n══ BODY BLOCKS ══");
  for (const slug of TARGET_SLUGS) {
    if (slug === "faq") { fail("faq is not a permitted target"); continue; }

    const { rows: pub } = await client.query(
      `select id, page_id, title, slug, intro, meta_description, in_footer, body
         from site_page_versions where slug = $1 and state = 'published'`,
      [slug]
    );
    if (pub.length === 0) { fail(`no published page for slug "${slug}"`); continue; }
    if (pub.length > 1) { fail(`duplicate published slug "${slug}" (${pub.length} rows)`); continue; }
    const page = pub[0];

    const { rows: existingDraft } = await client.query(
      "select id, body from site_page_versions where page_id = $1 and state = 'draft'",
      [page.page_id]
    );

    const target = BODIES[slug];
    const currentBlocks = Array.isArray(page.body) ? page.body.length : 0;

    console.log(`\n  /in/${slug}`);
    console.log(`    page id            : ${page.page_id}`);
    console.log(`    published version  : ${page.id}`);
    console.log(`    existing draft     : ${existingDraft[0]?.id ?? "(none)"}`);
    console.log(`    title              : ${page.title}`);
    console.log(`    intro              : ${page.intro ?? "(none)"}`);
    console.log(`    meta description   : ${page.meta_description ?? "(none)"}`);
    console.log(`    in_footer          : ${page.in_footer}`);
    console.log(`    body blocks now    : ${currentBlocks}`);
    console.log(`    body blocks after  : ${target.length}`);

    // Idempotency: nothing to do if the draft (or the published row) already says this.
    if (same(existingDraft[0]?.body, target) || same(page.body, target)) {
      console.log("    -> already correct, skipping");
      continue;
    }
    if (currentBlocks > 0 && !same(page.body, target)) {
      fail(`"${slug}" already has ${currentBlocks} body blocks that differ from the intended text — refusing to overwrite hand-written content`);
      continue;
    }

    // The same RPC the admin form calls: forks published → draft, admin-gated.
    const { rows: d } = await client.query("select public.ensure_page_draft($1) as id", [page.page_id]);
    const draftId = d[0].id;

    const { rows: check } = await client.query(
      "select state from site_page_versions where id = $1", [draftId]
    );
    if (check[0]?.state !== "draft") {
      fail(`ensure_page_draft returned a row in state "${check[0]?.state}" — refusing to write`);
      continue;
    }

    // ONLY body. title, slug, intro, meta_description, in_footer and sort_order
    // came across in the fork and are deliberately not named here.
    await client.query(
      "update site_page_versions set body = $1::jsonb where id = $2 and state = 'draft'",
      [JSON.stringify(target), draftId]
    );
    await client.query("select public.settle_draft('page', $1)", [draftId]);

    const { rows: back } = await client.query(
      "select body, title, slug, intro, meta_description, in_footer from site_page_versions where id = $1",
      [draftId]
    );
    const wrote = back[0];
    const okBody = same(wrote.body, target);
    const okRest =
      wrote.title === page.title && wrote.slug === page.slug &&
      wrote.intro === page.intro && wrote.meta_description === page.meta_description &&
      wrote.in_footer === page.in_footer;
    console.log(`    -> draft ${draftId}`);
    console.log(`       body written & read back : ${okBody ? "OK" : "MISMATCH"} (${wrote.body.length} blocks)`);
    console.log(`       title/slug/intro/meta/footer preserved : ${okRest ? "OK" : "CHANGED"}`);
    if (!okBody || !okRest) fail(`verification failed for "${slug}"`);
  }

  // ══ 2. CUSTOMER-FACING EMAIL IN THE LEGAL PAGES ══
  console.log("\n══ CUSTOMER-FACING EMAIL ══");
  for (const slug of EMAIL_FIX_SLUGS) {
    const { rows: pub } = await client.query(
      `select id, page_id, body from site_page_versions where slug = $1 and state = 'published'`,
      [slug]
    );
    if (pub.length !== 1) { fail(`expected exactly one published "${slug}", found ${pub.length}`); continue; }
    const page = pub[0];
    const body = Array.isArray(page.body) ? page.body : [];

    const hits = [];
    const next = body.map((b, i) => {
      const out = { ...b };
      for (const key of ["text", "question", "answer"]) {
        if (typeof out[key] === "string" && out[key].includes(OLD_EMAIL)) {
          hits.push({ i, key, before: out[key] });
          out[key] = out[key].split(OLD_EMAIL).join(NEW_EMAIL);
        }
      }
      return out;
    });

    console.log(`\n  /in/${slug}  — ${hits.length} occurrence(s) of ${OLD_EMAIL}`);
    for (const hit of hits) {
      console.log(`    block ${hit.i} .${hit.key}`);
      console.log(`      before: …${hit.before.slice(Math.max(0, hit.before.indexOf(OLD_EMAIL) - 90), hit.before.indexOf(OLD_EMAIL) + OLD_EMAIL.length + 40)}…`);
      const after = hit.before.split(OLD_EMAIL).join(NEW_EMAIL);
      console.log(`      after : …${after.slice(Math.max(0, after.indexOf(NEW_EMAIL) - 90), after.indexOf(NEW_EMAIL) + NEW_EMAIL.length + 40)}…`);
    }
    if (hits.length === 0) { console.log("    -> nothing to change, skipping"); continue; }

    // ONLY the address changes. Checked BLOCK BY BLOCK rather than by reversing
    // the substitution across the whole document: these pages already contain
    // hello@thewovenne.com elsewhere (clause 18 of the Terms, clause 13 of the
    // Privacy Policy, both corrected earlier by hand), so reversing every
    // hello@ back to admin@ rewrote those too and made an honest edit look like
    // a dangerous one. The invariant that actually matters is narrower: an
    // untouched block is identical, and a touched field is exactly its original
    // with the address swapped.
    if (next.length !== body.length) { fail(`block count changed for "${slug}"`); continue; }
    const touched = new Set(hits.map((x) => x.i));
    let onlyEmailChanged = true;
    for (let i = 0; i < body.length && onlyEmailChanged; i++) {
      if (!touched.has(i)) { onlyEmailChanged = same(next[i], body[i]); continue; }
      const before = body[i], after = next[i];
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const bv = before[k], av = after[k];
        const ok =
          typeof bv === "string" && typeof av === "string"
            ? bv.split(OLD_EMAIL).join(NEW_EMAIL) === av
            : same(bv, av);
        if (!ok) { onlyEmailChanged = false; break; }
      }
    }
    if (!onlyEmailChanged) { fail(`more than the email address would change in "${slug}" — refusing`); continue; }
    console.log(`    -> only the address differs; all other wording byte-identical: OK`);

    const { rows: d } = await client.query("select public.ensure_page_draft($1) as id", [page.page_id]);
    const draftId = d[0].id;
    const { rows: check } = await client.query("select state from site_page_versions where id = $1", [draftId]);
    if (check[0]?.state !== "draft") { fail(`"${slug}" draft is in state "${check[0]?.state}"`); continue; }

    await client.query(
      "update site_page_versions set body = $1::jsonb where id = $2 and state = 'draft'",
      [JSON.stringify(next), draftId]
    );
    await client.query("select public.settle_draft('page', $1)", [draftId]);

    const { rows: back } = await client.query("select body from site_page_versions where id = $1", [draftId]);
    const remaining = JSON.stringify(back[0].body).includes(OLD_EMAIL);
    console.log(`    -> draft ${draftId}   ${OLD_EMAIL} remaining: ${remaining ? "YES — FAILED" : "none"}`);
    if (remaining) fail(`"${slug}" still contains ${OLD_EMAIL}`);
  }

  // ══ 3. NOTHING ELSE MAY BE QUEUED ═════════
  // pending_queue() RETURNS JSONB — one array, not a table. `select kind, ...
  // from pending_queue()` therefore fails with `column "kind" does not exist`.
  const { rows: qr } = await client.query("select public.pending_queue() as q");
  const q = Array.isArray(qr[0]?.q) ? qr[0].q : [];
  console.log("\n══ PENDING PUBLISH QUEUE (what you would review) ══");
  if (q.length === 0) console.log("  (empty)");
  for (const row of q) {
    console.log(`  ${String(row.kind).padEnd(9)} ${String(row.slug ?? row.label ?? "")}${row.is_new ? "  [new]" : ""}`);
  }
  const unexpected = q.filter(
    (r) => r.kind !== "page" || ![...TARGET_SLUGS, ...EMAIL_FIX_SLUGS].includes(r.slug)
  );
  if (unexpected.length) {
    console.log(`\n  NOTE: ${unexpected.length} unrelated item(s) are also pending — they were already there, and`);
    console.log("        publishing from Admin would include them. Review before you publish.");
  }

  if (failed > 0) {
    await client.query("rollback");
    console.error(`\n  ${failed} problem(s) — ROLLED BACK, nothing written.\n`);
    process.exitCode = 1;
    return;
  }

  if (APPLY) {
    await client.query("commit");
    console.log("\n  COMMITTED. The drafts now exist. Nothing is live yet —");
    console.log("  open Admin → Review & Publish to see and publish them.\n");
  } else {
    await client.query("rollback");
    console.log("\n  DRY RUN — rolled back, nothing written.");
    console.log("  Re-run with --apply to keep these drafts.\n");
  }
}

main()
  .catch(async (e) => {
    try { await client.query("rollback"); } catch {}
    console.error(`\n  ERROR: ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => { try { await client.end(); } catch {} });
