/**
 * The database half of staging: replay migrations, clear disposable state, and
 * lay down the baseline catalogue. Everything here takes an open pg client and
 * nothing here reads credentials — scripts/staging.mjs does that, through
 * loadScriptEnv({ stagingOnly: true }), before a client exists. That split is
 * also what lets scripts/staging.test.ts run all of it against a throwaway
 * Postgres.
 */
import fs from "node:fs";
import path from "node:path";

export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

export function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
}

// ── Migrations ──────────────────────────────────────────────────────────────

/**
 * Apply every migration the database has not recorded, in number order, each
 * in its own transaction, UNMODIFIED.
 *
 * Before 0057 there is no ledger to write to, so a fresh project is detected
 * by having no tables in public at all; anything else without a ledger is not
 * a database this should touch. Once 0057 has run it backfills 0001–0056 as
 * "recorded retrospectively" — on staging that is not true, they were applied
 * a moment ago by this function, so those rows are corrected to the real time.
 *
 * A pending file numbered BELOW the newest applied one is refused rather than
 * applied: that is a branch merged out of order, and running it late is a
 * decision for a person.
 */
export async function applyPendingMigrations(c, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const ledgerExists = async () =>
    (await c.query("select to_regclass('public.schema_migrations') is not null as ok")).rows[0].ok;

  let applied = new Set();
  if (await ledgerExists()) {
    applied = new Set((await c.query("select filename from schema_migrations")).rows.map((r) => r.filename));
  } else {
    const { n } = (
      await c.query(
        "select count(*)::int n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
      )
    ).rows[0];
    if (n > 0) {
      throw new Error(
        `public has ${n} tables but no schema_migrations ledger. This is not a fresh staging project; nothing was run.`
      );
    }
  }

  const files = migrationFiles(dir);
  const pending = files.filter((f) => !applied.has(f));
  const newest = [...applied].sort().at(-1);
  const late = newest ? pending.filter((f) => f < newest) : [];
  if (late.length) {
    throw new Error(`out-of-order migrations pending below ${newest}: ${late.join(", ")}. Nothing was run.`);
  }

  const appliedNow = [];
  for (const f of pending) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await c.query("begin");
    try {
      await c.query(sql);
      if (await ledgerExists()) {
        await c.query(
          `insert into schema_migrations (filename, applied_at, recorded_retrospectively)
           values ($1, now(), false)
           on conflict (filename) do update set applied_at = excluded.applied_at, recorded_retrospectively = false`,
          [f]
        );
        if (appliedNow.length) {
          // The 0057 backfill just claimed these were applied at an unknown
          // time. They were applied in this run; say so.
          await c.query(
            `update schema_migrations set applied_at = now(), recorded_retrospectively = false
              where filename = any($1) and recorded_retrospectively`,
            [appliedNow]
          );
        }
      }
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw new Error(`${f} failed and was rolled back: ${e.message}`);
    }
    appliedNow.push(f);
    log(`applied ${f}`);
  }
  return { applied: appliedNow, total: files.length };
}

// ── What a reset clears ─────────────────────────────────────────────────────

/**
 * Every base table in public, sorted into one of two lists. A table missing
 * from both makes reset refuse: a new migration that adds customer data must
 * say which side it is on, not be silently kept or silently wiped.
 *
 * DISPOSABLE: test activity. Truncated by reset.
 * RETAINED:   schema history, migration-seeded structure and copy, and
 *             profiles (customer profiles go with their auth user, which reset
 *             deletes through the Auth API; staff profiles stay).
 */
export const TABLE_POLICY = {
  disposable: [
    "admin_audit_log",
    "ai_daily_spend",
    "ai_spend_reservations",
    "carts",
    "chat_usage",
    "coupon_redemptions",
    "coupons",
    "credit_notes",
    "expenses",
    "loyalty_ledger",
    "marketing_sends",
    "orders",
    "product_images",
    "product_reviews",
    "product_sizes",
    "product_url_history",
    "product_versions",
    "products",
    "razorpay_webhook_events",
    "stock_movements",
    "stock_requests",
    "style_submissions",
    "wishlists",
  ],
  retained: [
    "categories",
    "category_versions",
    "journal_posts",
    "journal_versions",
    "profiles",
    "schema_migrations",
    "site_content",
    "site_page_versions",
    "site_pages",
  ],
};

export async function unclassifiedTables(c) {
  const { rows } = await c.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"
  );
  const known = new Set([...TABLE_POLICY.disposable, ...TABLE_POLICY.retained]);
  return rows.map((r) => r.table_name).filter((t) => !known.has(t));
}

export async function clearDisposable(c) {
  const unknown = await unclassifiedTables(c);
  if (unknown.length) {
    throw new Error(
      `unclassified tables: ${unknown.join(", ")}. Add each to TABLE_POLICY in scripts/lib/staging.mjs. Nothing was cleared.`
    );
  }
  await c.query(`truncate ${TABLE_POLICY.disposable.map((t) => `public.${t}`).join(", ")} restart identity cascade`);
}

// ── Baseline catalogue ──────────────────────────────────────────────────────

/**
 * Synthetic, and says so. No row here came from production. Facts are the
 * minimum a product needs and are invented only in the sense that the products
 * are: nothing claims an origin, weave or technique.
 *
 * Each entry exists for a test someone will need:
 *   in-stock         a plain live product that can be bought
 *   sold-out         live, unsized, stock 0
 *   sized            live, sizes with one at 0
 *   pending-change   live, with an unpublished name change waiting
 *   draft-only       never published — must not be visible on the shop
 */
export const STAGING_CATALOGUE = [
  {
    key: "in-stock",
    slug: "staging-cotton-saree",
    name: "Staging Cotton Saree",
    category: "sarees",
    price: 2500,
    cost: 900,
    fabric: "Cotton",
    colour: "Ivory",
    stock: 5,
    publish: true,
    images: 2,
  },
  {
    key: "sold-out",
    slug: "staging-sold-out-saree",
    name: "Staging Sold Out Saree",
    category: "sarees",
    price: 3200,
    cost: 1200,
    fabric: "Cotton",
    colour: "Indigo",
    stock: 0,
    publish: true,
    images: 1,
  },
  {
    key: "sized",
    slug: "staging-sized-kurti",
    name: "Staging Sized Kurti",
    category: "kurtis",
    price: 1800,
    cost: 600,
    fabric: "Linen",
    colour: "Sage",
    stock: 0,
    sizes: [
      { label: "S", stock_quantity: 3 },
      { label: "M", stock_quantity: 0 },
      { label: "L", stock_quantity: 2 },
    ],
    publish: true,
    images: 1,
  },
  {
    key: "pending-change",
    slug: "staging-pending-change-saree",
    name: "Staging Pending Change Saree",
    pendingName: "Staging Pending Change Saree (edited, not published)",
    category: "sarees",
    price: 2800,
    cost: 1000,
    fabric: "Cotton",
    colour: "Red",
    stock: 4,
    publish: true,
    images: 1,
  },
  {
    key: "draft-only",
    slug: "staging-draft-only-saree",
    name: "Staging Draft Only Saree",
    category: "sarees",
    price: 2100,
    cost: 800,
    fabric: "Cotton",
    colour: "Green",
    stock: 3,
    publish: false,
    images: 1,
  },
];

/** Categories the catalogue uses that 0007 leaves hidden. Made visible through the admin path. */
export const STAGING_VISIBLE_CATEGORIES = ["kurtis"];

export function imagePaths(entry) {
  return Array.from({ length: entry.images }, (_, i) => `products/${entry.slug}-${i + 1}.jpg`);
}

// The identity a request from a signed-in, two-factor admin carries — the same
// claims PostgREST sets, so every RLS policy and RPC runs as it does in the app.
async function asAdmin(c, adminId) {
  await c.query("set role authenticated");
  await c.query(
    "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
    [adminId, JSON.stringify({ sub: adminId, role: "authenticated", aal: "aal2" })]
  );
}
async function asRoot(c) {
  await c.query("reset role");
}

/**
 * Replace every product with the baseline, through the admin's own RPCs.
 * One transaction: a half-seeded catalogue is not a baseline.
 *
 * `imageUrl(path)` turns a storage path into the public URL the app stores;
 * the caller has already uploaded the bytes.
 */
export async function seedCatalogue(c, { adminId, imageUrl }) {
  await c.query("begin");
  try {
    await asRoot(c);
    const staff = (await c.query("select is_admin from profiles where id = $1", [adminId])).rows[0];
    if (!staff?.is_admin) throw new Error("the seeding account is not staff (profiles.is_admin)");

    // 0007's placeholders, and anything a previous test run left behind.
    await c.query("truncate public.products restart identity cascade");

    await asAdmin(c, adminId);
    for (const slug of STAGING_VISIBLE_CATEGORIES) {
      const cat = (await c.query("select id, is_visible from categories where slug = $1", [slug])).rows[0];
      if (!cat) throw new Error(`category ${slug} is missing — was 0007 applied?`);
      if (!cat.is_visible) {
        const vid = (await c.query("select public.ensure_category_draft($1) id", [cat.id])).rows[0].id;
        await c.query("update category_versions set is_visible = true where id = $1", [vid]);
        await c.query("select public.publish_one('category', $1)", [cat.id]);
      }
    }

    const made = {};
    for (const e of STAGING_CATALOGUE) {
      const category = (await c.query("select id from categories where slug = $1", [e.category])).rows[0];
      if (!category) throw new Error(`category ${e.category} is missing`);
      const vid = (await c.query("select public.create_product_draft() id")).rows[0].id;
      const { rows } = await c.query(
        `update product_versions
            set name = $2, slug = $3, price_inr = $4, cost_price_inr = $5, sku = upper($3),
                category_id = $6, fabric = $7, colour = $8, stock_quantity = $9,
                description = $10, care_note = 'Staging test product. Care details are not real.'
          where id = $1
          returning product_id`,
        [
          vid,
          e.name,
          e.slug,
          e.price,
          e.cost,
          category.id,
          e.fabric,
          e.colour,
          e.stock,
          `Synthetic staging product (${e.key}). Not a real item; exists for testing only.`,
        ]
      );
      const productId = rows[0].product_id;
      const paths = imagePaths(e);
      for (let i = 0; i < paths.length; i++) {
        await c.query(
          "insert into product_images (product_version_id, product_id, url, sort_order) values ($1, $2, $3, $4)",
          [vid, productId, imageUrl(paths[i]), i]
        );
      }
      if (e.publish) {
        await c.query("select public.publish_one('product', $1)", [productId]);
        if (e.sizes) {
          await c.query("select public.save_product_sizes($1, $2::jsonb)", [productId, JSON.stringify(e.sizes)]);
        }
        if (e.pendingName) {
          const draft = (await c.query("select public.ensure_product_draft($1) id", [productId])).rows[0].id;
          await c.query("update product_versions set name = $2 where id = $1", [draft, e.pendingName]);
        }
      }
      made[e.key] = productId;
    }

    await asRoot(c);
    await c.query("commit");
    return made;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}
