/**
 * SEO-5E — content truthfulness, as CMS DRAFTS. Site content and pages only.
 *
 *   node scripts/seo-5e-drafts.mjs --as <your admin email>            # dry run
 *   node scripts/seo-5e-drafts.mjs --as <your admin email> --apply    # keeps drafts
 *
 * --as IS REQUIRED. The audit log records whoever the claim names as the
 * author of every draft, so it must be the person running this — never
 * "whichever admin happens to be first".
 *
 * The code defaults were corrected in the same change; this is the live half.
 * Every write goes through the same draft machinery Admin uses, so the flow is
 *
 *     this script  →  drafts  →  you read them in Admin  →  Review & Publish
 *
 *   site_content  draft_value only. `value` — what the storefront reads — is
 *                 never named in an UPDATE here.
 *   pages         ensure_page_draft(), then the returned draft row only.
 *
 * NO PRODUCTS, BY CONSTRUCTION. There is no product code path here — not a
 * flag, not a skip. Unsized stock lives on the version row: a sale decrements
 * the PUBLISHED row, and publishing a draft copies the draft's stock over it,
 * so a product draft opened on a qty-1 piece can resurrect it after it sells.
 * Until that is fixed (wovenne_project_status_log.md, "Deferred: a product
 * draft can overwrite newer stock"), this change opens no product drafts, and
 * the audited whitespace in four product rows waits for that fix.
 *
 * is_admin() reads auth.uid(), so the admin claim is borrowed for the
 * transaction exactly as scripts/seed-policy-pages.mjs does. EVERYTHING RUNS IN
 * ONE TRANSACTION and is ROLLED BACK unless --apply is given. A dry run
 * therefore really WRITES the drafts, reads them back, and then undoes it — it
 * is not a read-only operation, and needs the same authority as --apply.
 *
 * IT REFUSES TO START IF ANYTHING IS ALREADY PENDING, and refuses to commit if
 * the queue afterwards holds anything but what it wrote. Nothing here publishes.
 *
 * The planners below are pure and exported, so scripts/content-truthfulness
 * .test.ts can check exactly what would be written without a database.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";

/** This project, and no other. */
const EXPECTED_PROJECT_REF = "wxumlixnmwgeqswknhpw";

// ── Approved copy (owner sign-off, SEO-5E) ──────────────────────────
export const STRAPLINE = "Chosen piece by piece.";
const OLD_STRAPLINE = /Woven in India|Worn for life/i;

export const HERO = {
  eyebrow: STRAPLINE,
  heading: "THE WOVENNE",
  subheading: "A considered selection of clothing, sarees and jewellery.",
};

export const WHY_US_TITLE = "Why Us";
export const WHY_US_CARDS = [
  {
    title: "Chosen piece by piece",
    text: "Every product is reviewed and chosen before it reaches the shop. Many designs are carried in very small quantities, often just one or two pieces.",
  },
  {
    title: "Natural fabrics first",
    text: "Our clothing range is centred on natural fibres. Today that means cotton, including handloom mul cotton and tissue cotton, with linen becoming a key material as the collection grows.",
  },
  {
    title: "Chosen to be worn again",
    text: "We look for pieces with the fabric, feel and design to earn repeat wear — for an occasion, an ordinary day, or somewhere in between.",
  },
];

export const SHIPPING_NOTE =
  "₹99 in Kerala, ₹129 elsewhere in India, free on orders of ₹3,000 or more.";

export const FOOTER_DESCRIPTION =
  "Chosen piece by piece. A considered selection of clothing, sarees and jewellery, shipped across India.";

/**
 * The lookbook image's link, as production actually stores it (verified on the
 * live homepage after #154): the ABSOLUTE https://www.thewovenne.com/in/women/
 * sarees/mul-cotton, which redirects to the parrot-green saree. The audit had
 * recorded it as a relative /mul-cotton, which matched nothing, so the planner
 * refused and the whole run rolled back.
 *
 * The replacement is relative on purpose so adminHref adds /in.
 */
export const SITE_ORIGIN = "https://www.thewovenne.com";
export const LOOKBOOK_OLD_PATH = "/women/sarees/mul-cotton";
export const LOOKBOOK_HREF = "/women/sarees/parrot-green-mul-cotton-saree";
export const LOOKBOOK_ALT = "Parrot green handloom mul cotton saree";

export const ABOUT = {
  slug: "about",
  meta_description:
    "Discover THE WOVENNE, a curated clothing and saree label focused on natural fabrics, with a small selected jewellery range alongside.",
  intro:
    "A considered selection of clothing, sarees and jewellery, chosen piece by piece rather than stocked for volume.",
  opening:
    "THE WOVENNE is based in Kerala, India and built around a considered approach to what we stock. We focus on clothing and sarees in natural fabrics, alongside a small selected jewellery range.",
};

export const PRIVACY = {
  slug: "privacy-policy",
  meta_description:
    "How THE WOVENNE collects, uses and protects your personal information when you shop with us, and the choices available to you.",
};

/** Every site_content key this script may write. The audit saw all but the footer. */
export const CONTENT_KEYS = ["home_hero", "why_linen", "lookbook", "shipping", "footer"];
const OPTIONAL_CONTENT_KEYS = new Set(["footer"]);

/** Every page slug this script may write. */
export const PAGE_SLUGS = [ABOUT.slug, PRIVACY.slug];

// ── Pure planners ───────────────────────────────────────────────────
// Each takes the published value and returns { next, notes }, null for
// "already clean", or throws when the data is not what was audited.

export function planHero(current) {
  const next = { ...current, ...HERO };
  return { next, notes: ["eyebrow/heading/subheading replaced; CTA untouched"] };
}

export function planWhyUs(current) {
  // The approved title and cards, exactly. The CMS key keeps its old name.
  const next = { ...current, title: WHY_US_TITLE, cards: WHY_US_CARDS };
  return {
    next,
    notes: [`title ${JSON.stringify(current.title)} → ${JSON.stringify(WHY_US_TITLE)}`, "cards replaced with the approved three"],
  };
}

/**
 * A stored link reduced to its market-free path on this site, or null.
 *
 * Only a site-relative path or this exact production origin qualifies: any
 * other host, a protocol-relative "//host", a lookalike such as
 * www.thewovenne.com.example, or a link carrying a query or fragment returns
 * null and so matches nothing — an unexpected link is a refusal, never a guess.
 * The /in market prefix and a trailing slash are dropped, so the absolute and
 * relative spellings of one link compare equal.
 */
export function lookbookPath(href) {
  const raw = String(href ?? "").trim();
  const relative = raw.startsWith("/") && !raw.startsWith("//");
  if (!relative && !raw.startsWith(`${SITE_ORIGIN}/`)) return null;
  let url;
  try { url = new URL(raw, SITE_ORIGIN); } catch { return null; }
  if (url.origin !== SITE_ORIGIN || url.search || url.hash) return null;
  return url.pathname.replace(/^\/in(?=\/)/, "").replace(/\/+$/, "");
}

export function planLookbook(current) {
  const sections = Array.isArray(current.sections) ? current.sections : [];
  const hits = [];
  const next = {
    ...current,
    sections: sections.map((section, si) => ({
      ...section,
      images: (section.images ?? []).map((image, ii) => {
        if (lookbookPath(image.href) !== LOOKBOOK_OLD_PATH) return image;
        hits.push({ si, ii, before: image });
        return { ...image, href: LOOKBOOK_HREF, alt: LOOKBOOK_ALT };
      }),
    })),
  };
  if (hits.length !== 1) {
    throw new Error(`expected exactly one lookbook image linking ${LOOKBOOK_OLD_PATH}, found ${hits.length}`);
  }
  const h = hits[0];
  return {
    next,
    notes: [
      `section ${h.si} image ${h.ii}: href ${JSON.stringify(h.before.href)} → ${JSON.stringify(LOOKBOOK_HREF)}`,
      `alt ${JSON.stringify(h.before.alt)} → ${JSON.stringify(LOOKBOOK_ALT)}`,
    ],
  };
}

export function planShipping(current) {
  // Only the note. Rates, regions and the threshold are pricing, and pricing
  // is not this change.
  return { next: { ...current, note: SHIPPING_NOTE }, notes: [`note ${JSON.stringify(current.note)} → approved`] };
}

/** null when the footer already carries no stale claim — nothing to draft. */
export function planFooter(current) {
  const d = String(current.brand_description ?? "");
  if (!OLD_STRAPLINE.test(d) && !/linen|\bUK\b|direct from the source/i.test(d)) return null;
  return {
    next: { ...current, brand_description: FOOTER_DESCRIPTION },
    notes: [`brand_description ${JSON.stringify(d)} → ${JSON.stringify(FOOTER_DESCRIPTION)}`],
  };
}

/** The opening paragraph is replaced only if it is the Kerala-artisan claim. */
const KERALA_ARTISAN = (t) => /kerala/i.test(t) && /artisan|weaver|loom|woven/i.test(t);

export function planAbout(page) {
  const body = Array.isArray(page.body) ? page.body : [];
  const first = body.findIndex((b) => b.type === "paragraph");
  if (first === -1) throw new Error("about has no paragraph block to replace");
  if (!KERALA_ARTISAN(String(body[first].text ?? ""))) {
    throw new Error(`about's opening paragraph is not the Kerala-artisan claim: ${JSON.stringify(body[first].text)}`);
  }
  const nextBody = body.map((b, i) => (i === first ? { ...b, text: ABOUT.opening } : b));
  // Reported, never rewritten: later paragraphs are not in the approved copy.
  const residual = body
    .map((b, i) => ({ b, i }))
    .filter(({ b, i }) => i !== first && KERALA_ARTISAN(String(b.text ?? b.answer ?? "")))
    .map(({ i }) => i);
  return {
    next: { meta_description: ABOUT.meta_description, intro: ABOUT.intro, body: nextBody },
    notes: [
      `opening paragraph (block ${first}) replaced`,
      residual.length
        ? `WARNING: blocks ${residual.join(", ")} also make a Kerala-artisan claim — NOT changed`
        : "no other block makes a Kerala-artisan claim",
    ],
  };
}

export function planPrivacy() {
  return { next: { meta_description: PRIVACY.meta_description }, notes: ["meta_description only; legal body untouched"] };
}

// ── The database run ────────────────────────────────────────────────
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const CONTENT_PLANS = { home_hero: planHero, why_linen: planWhyUs, lookbook: planLookbook, shipping: planShipping, footer: planFooter };
const PAGE_PLANS = { [ABOUT.slug]: planAbout, [PRIVACY.slug]: planPrivacy };
/** Columns a page plan may name. Interpolated into SQL, so it is a fixed list. */
const PAGE_COLUMNS = new Set(["meta_description", "intro", "body"]);

async function main() {
  const APPLY = process.argv.includes("--apply");
  const asFlag = process.argv.indexOf("--as");
  const AS_EMAIL = asFlag !== -1 ? process.argv[asFlag + 1] : "";
  if (!AS_EMAIL || AS_EMAIL.startsWith("--")) throw new Error("pass --as <your admin email>");
  const envFlag = process.argv.indexOf("--env");
  const ENV_PATH = envFlag !== -1 ? process.argv[envFlag + 1] : ".env.local";
  if (!fs.existsSync(ENV_PATH)) throw new Error(`no env file at ${ENV_PATH}. Pass --env <path>`);
  const env = Object.fromEntries(
    fs.readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
  if (!(env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(EXPECTED_PROJECT_REF)) {
    throw new Error(`this is not the Wovenne project (${EXPECTED_PROJECT_REF})`);
  }
  if (!env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is not set");

  const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  let failed = 0;
  const fail = (msg) => { console.error(`\n  REFUSING: ${msg}`); failed++; };

  await client.connect();
  try {
    await client.query("begin");
    console.log(`\n  MODE: ${APPLY ? "APPLY — drafts will be COMMITTED (nothing published)" : "DRY RUN — writes, reads back, then rolls back"}`);

    // Row locks are held until commit/rollback; never wait on a busy admin.
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '30s'");

    const { rows: admins } = await client.query(
      `select p.id from profiles p join auth.users u on u.id = p.id
        where p.is_admin = true and lower(u.email) = lower($1)`,
      [AS_EMAIL]
    );
    if (admins.length !== 1) throw new Error("--as does not name exactly one admin account");
    await client.query(
      "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
      [admins[0].id]
    );
    if (!(await client.query("select public.is_admin() ok")).rows[0].ok) throw new Error("the named account does not read as admin");

    const queue = async () => {
      const q = (await client.query("select public.pending_queue() q")).rows[0].q;
      return Array.isArray(q) ? q : [];
    };
    const show = (r) => `${String(r.kind).padEnd(9)} ${r.slug ?? r.label ?? ""}`;

    // ══ 0. NOTHING MAY ALREADY BE PENDING ══
    const before = await queue();
    console.log(`\n══ PENDING BEFORE: ${before.length} ══`);
    for (const r of before) console.log(`  ${show(r)}`);
    if (before.length) throw new Error("the publish queue is not empty — stopping before any write. Resolve those drafts first.");

    /** kind:slug for every draft written. */
    const expected = new Set();

    // ══ 1. SITE CONTENT (draft_value only) ══
    console.log("\n══ SITE CONTENT ══");
    for (const key of CONTENT_KEYS) {
      const { rows } = await client.query("select value, draft_value from site_content where key = $1", [key]);
      // A missing row means the data moved since the audit — a refusal, not a
      // skip. Only the footer may be absent (its code default is corrected).
      if (rows.length !== 1) {
        if (OPTIONAL_CONTENT_KEYS.has(key)) console.log(`  ${key}: no stored row — the corrected code default applies, no draft`);
        else fail(`site_content "${key}" not found — the data changed since the audit`);
        continue;
      }
      let planned;
      try { planned = CONTENT_PLANS[key](rows[0].value ?? {}); } catch (e) { fail(`${key}: ${e.message}`); continue; }
      if (!planned) { console.log(`  ${key}: already clean — no draft`); continue; }
      await client.query("update site_content set draft_value = $1::jsonb where key = $2", [JSON.stringify(planned.next), key]);
      const back = (await client.query("select value, draft_value from site_content where key = $1", [key])).rows[0];
      const ok = same(back.draft_value, planned.next) && same(back.value, rows[0].value);
      expected.add(`content:${key}`);
      console.log(`  ${key}: ${ok ? "draft written, live value untouched" : "MISMATCH"}`);
      for (const n of planned.notes) console.log(`      ${n}`);
      if (!ok) fail(`${key} read-back failed`);
    }

    // ══ 2. PAGES (ensure_page_draft, then that draft only) ══
    console.log("\n══ PAGES ══");
    for (const slug of PAGE_SLUGS) {
      const { rows: pub } = await client.query(
        "select id, page_id, title, slug, intro, meta_description, body from site_page_versions where slug = $1 and state = 'published'",
        [slug]
      );
      if (pub.length !== 1) { fail(`expected one published "${slug}", found ${pub.length}`); continue; }
      let planned;
      try { planned = PAGE_PLANS[slug](pub[0]); } catch (e) { fail(`${slug}: ${e.message}`); continue; }
      const cols = Object.keys(planned.next);
      if (!cols.every((c) => PAGE_COLUMNS.has(c))) { fail(`${slug}: plan names a column outside ${[...PAGE_COLUMNS]}`); continue; }

      const draftId = (await client.query("select public.ensure_page_draft($1) id", [pub[0].page_id])).rows[0].id;
      if ((await client.query("select state from site_page_versions where id = $1", [draftId])).rows[0]?.state !== "draft") {
        fail(`${slug}: ensure_page_draft did not return a draft`); continue;
      }
      await client.query(
        `update site_page_versions set ${cols.map((c, i) => `${c} = $${i + 1}${c === "body" ? "::jsonb" : ""}`).join(", ")}
          where id = $${cols.length + 1} and state = 'draft'`,
        [...cols.map((c) => (c === "body" ? JSON.stringify(planned.next[c]) : planned.next[c])), draftId]
      );
      const back = (await client.query("select title, slug, intro, meta_description, body from site_page_versions where id = $1", [draftId])).rows[0];
      const live = (await client.query("select intro, meta_description, body from site_page_versions where id = $1", [pub[0].id])).rows[0];
      const ok =
        cols.every((c) => same(back[c], planned.next[c])) &&
        back.title === pub[0].title && back.slug === pub[0].slug &&
        same(live, { intro: pub[0].intro, meta_description: pub[0].meta_description, body: pub[0].body });
      expected.add(`page:${slug}`);
      console.log(`  /${slug}: draft ${draftId} ${ok ? "written; title, slug and live row untouched" : "MISMATCH"}`);
      for (const n of planned.notes) console.log(`      ${n}`);
      if (!ok) fail(`${slug} read-back failed`);
    }

    // ══ 3. THE COMPLETE QUEUE ══
    const after = await queue();
    console.log(`\n══ PENDING QUEUE AFTER (${after.length}) — this is what Review & Publish would show ══`);
    for (const r of after) console.log(`  ${show(r)}`);
    // Exactly what this run wrote, and nothing else — a draft that appeared
    // from anywhere else during the run is a refusal.
    const unexpected = after.filter((r) => !expected.has(`${r.kind}:${r.slug}`));
    const missing = [...expected].filter((e) => !after.some((r) => `${r.kind}:${r.slug}` === e));
    if (unexpected.length) fail(`unexpected items in the queue: ${unexpected.map(show).join(", ")}`);
    if (missing.length) fail(`drafts written but not pending (no-op?): ${missing.join(", ")}`);

    if (failed) {
      await client.query("rollback");
      console.error(`\n  ${failed} problem(s) — ROLLED BACK, nothing written.\n`);
      process.exitCode = 1;
    } else if (APPLY) {
      await client.query("commit");
      console.log("\n  COMMITTED as drafts. Nothing is live — review in Admin → Review & Publish.\n");
    } else {
      await client.query("rollback");
      console.log("\n  DRY RUN — rolled back, nothing written. Re-run with --apply to keep the drafts.\n");
    }
  } catch (e) {
    try { await client.query("rollback"); } catch {}
    console.error(`\n  ERROR: ${e.message} — rolled back, nothing written.\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\n  ERROR: ${e.message} — nothing written.\n`);
    process.exitCode = 1;
  });
}
