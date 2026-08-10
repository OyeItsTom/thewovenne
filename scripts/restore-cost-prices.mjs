/**
 * ONE-OFF: put back the two cost prices the product form erased.
 *
 *   node scripts/restore-cost-prices.mjs
 *
 * THIS ONE COMMITS. Both figures come from the audit log, which recorded them as
 * it overwrote them:
 *
 *   001    — cost_price_inr 600.00 -> null   9 Aug 2026, 11:31:25
 *   Cotton — cost_price_inr 200.00 -> null   9 Aug 2026, 11:33:22
 *
 * THROUGH THE NORMAL PATH, NOT A DIRECT UPDATE. ensure_product_draft forks a
 * draft, the cost goes on the draft, publish_one publishes it, and 0038's trigger
 * carries the cost onto `products`. That matters for three reasons: it is the same
 * route the admin form takes, so if it did not work the form would not either; the
 * audit trigger records the restore as an ordinary edit, so the books show what
 * happened rather than a value that changed by magic; and it re-exercises the
 * carry-through this session has now touched twice.
 *
 * One transaction per product. A failure at publish rolls back the fork with it,
 * so a half-finished repair cannot be left sitting in the publish queue.
 *
 * It refuses to run if either product already has a draft — publishing that would
 * ship somebody's unfinished edit alongside the cost.
 */
import fs from "node:fs";
import pg from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

/** slug -> the value the audit log says was erased. */
const RESTORE = [
  { slug: "001", cost: "600.00", wipedAt: "2026-08-09 11:31:25" },
  { slug: "cotton", cost: "200.00", wipedAt: "2026-08-09 11:33:22" },
];

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const { rows: admins } = await client.query(
  `select id, email from profiles where is_admin = true order by created_at limit 1`
);
if (admins.length === 0) {
  console.error("no admin profile to act as");
  process.exit(1);
}

for (const target of RESTORE) {
  console.log(`\n=== ${target.slug} → ₹${target.cost} (erased ${target.wipedAt}) ===`);
  try {
    await client.query("begin");
    // Transaction-local, so the claim cannot leak into another statement.
    await client.query(
      `select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
      [admins[0].id]
    );

    const { rows: found } = await client.query(
      `select p.id, p.name, p.cost_price_inr,
              (select count(*)::int from product_versions pv
                where pv.product_id = p.id and pv.state = 'draft') as drafts
         from products p where p.slug = $1`,
      [target.slug]
    );
    if (found.length === 0) throw new Error(`no product with slug ${target.slug}`);
    const product = found[0];

    if (product.drafts > 0) {
      throw new Error(
        `${product.name} already has an unpublished draft — publishing it would ship that edit too. Publish or discard it first.`
      );
    }
    if (product.cost_price_inr !== null) {
      throw new Error(
        `${product.name} already has a cost of ${product.cost_price_inr} — nothing to restore, and this would overwrite it.`
      );
    }

    const { rows: forked } = await client.query(
      `select public.ensure_product_draft($1) as id`,
      [product.id]
    );
    console.log(`  draft forked: ${forked[0].id}`);

    await client.query(
      `update product_versions set cost_price_inr = $2 where id = $1`,
      [forked[0].id, target.cost]
    );

    await client.query(`select public.publish_one('product', $1)`, [product.id]);
    console.log("  published");

    const { rows: after } = await client.query(
      `select p.cost_price_inr as products_cost, pv.cost_price_inr as version_cost, pv.state
         from products p
         join product_versions pv on pv.product_id = p.id and pv.state = 'published'
        where p.id = $1`,
      [product.id]
    );
    // Both, because the whole bug was a value living in one place and not the
    // other. Committing on a half-copied restore would be the same mistake again.
    if (
      Number(after[0].products_cost) !== Number(target.cost) ||
      Number(after[0].version_cost) !== Number(target.cost)
    ) {
      throw new Error(
        `verification failed: products=${after[0].products_cost}, version=${after[0].version_cost}`
      );
    }

    await client.query("commit");
    console.log(
      `  COMMITTED — products.cost_price_inr = ${after[0].products_cost}, published version = ${after[0].version_cost}`
    );
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error(`  FAILED, rolled back: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("\n=== cost as it stands now ===");
console.table(
  (
    await client.query(
      `select p.name, p.cost_price_inr as products_cost, pv.cost_price_inr as version_cost,
              (select count(*)::int from product_versions x where x.product_id = p.id and x.state = 'draft') as open_drafts
         from products p
         left join product_versions pv on pv.product_id = p.id and pv.state = 'published'
        order by p.name`
    )
  ).rows
);

console.log("=== the restore, as the audit log now records it ===");
console.table(
  (
    await client.query(
      `select created_at, actor_email, action, record_label,
              changes -> 'cost_price_inr' ->> 'from' as cost_from,
              changes -> 'cost_price_inr' ->> 'to' as cost_to
         from admin_audit_log
        where table_name = 'product_versions'
          and changes ? 'cost_price_inr'
          and created_at > now() - interval '10 minutes'
        order by created_at`
    )
  ).rows
);

await client.end();
