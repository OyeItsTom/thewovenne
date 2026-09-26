/**
 * 0060 — publishing a description never puts sold stock back, and stock is
 * changed only on purpose, against the figure the admin actually saw.
 *
 * SEQUENTIAL. One connection at a time, on a real PostgreSQL server with every
 * migration applied unmodified (scripts/pg-world.ts). This proves what each
 * function does; scripts/stock-concurrency.test.ts proves what happens when
 * they overlap.
 *
 * It also runs the headline scenario against the database as it was BEFORE
 * 0060 (migrations through 0059) and asserts the bug is there — so a pass
 * below means the fix did something, not that the test could not see.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> \
 *     npx tsx scripts/stock-integrity.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { asAdmin, asRoot, asService, failure, makeAdmin, startEngine, type Client } from "./pg-world";
import { liveProduct, liveRow, movements, nameOnlyDraft, paidOrder, sell, sizesOf, sum } from "./stock-world";
import { sizeChanges, type LoadedSize } from "../lib/inventory";

const HISTORY_AUDIT = fs.readFileSync("scripts/stock-history-audit.sql", "utf8");

/**
 * scripts/stock-history-audit.sql, exactly as the owner would run it, in a
 * read-only transaction. `confirmedStart` fills in confirmed_log_start, as the
 * owner would if they established when 0038 was applied; without it the file
 * runs unmodified.
 */
async function historyAudit(c: Client, confirmedStart?: string) {
  const sql = confirmedStart
    ? HISTORY_AUDIT.replace("select null::timestamptz as confirmed_log_start", `select timestamptz '${confirmedStart}' as confirmed_log_start`)
    : HISTORY_AUDIT;
  if (confirmedStart && sql === HISTORY_AUDIT) throw new Error("confirmed_log_start not found in the audit file");
  await asRoot(c);
  await c.query("begin read only");
  try {
    return (await c.query(sql)).rows as {
      section: string; slug: string; size_label: string | null; finding: string; confidence: string; changed_by: number;
    }[];
  } finally {
    await c.query("rollback");
  }
}

let passed = 0;
let failed = 0;
// Objects compare by content, not key order: a size map built in sort order
// and one written in a test are the same shelf.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x);
function check(name: string, actual: unknown, expected: unknown, note = "") {
  const ok = canon(actual) === canon(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}${note ? `  (${note})` : ""}`);
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    return;
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);

  try {
    // ══ CONTROL: the database before 0060 ══
    console.log("\n=== control: migrations through 0059 still have the bug ===");
    await engine.database("before0060", "0059");
    {
      const c = await engine.connect("before0060");
      const admin = await makeAdmin(c);
      const p = await liveProduct(c, admin, { stock: 1 });
      await nameOnlyDraft(c, admin, p.productId, "Renamed");
      const order = await paidOrder(c, [{ id: p.productId, quantity: 1 }]);
      await sell(c, order, [{ id: p.productId, quantity: 1 }]);
      check("before 0060: sale takes stock to 0", (await liveRow(c, p.productId))!.stock_quantity, 0);
      await asAdmin(c, admin);
      await c.query("select public.publish_one('product', $1)", [p.productId]);
      check("before 0060: publishing the rename PUTS THE SOLD PIECE BACK", (await liveRow(c, p.productId))!.stock_quantity, 1,
        "the defect this migration fixes");

      // The same database, a deliberate draft stock edit under the old workflow.
      const q = await liveProduct(c, admin, { stock: 2 });
      await asAdmin(c, admin);
      const qd = (await c.query("select public.ensure_product_draft($1) id", [q.productId])).rows[0].id;
      await c.query("update product_versions set stock_quantity = 5 where id = $1", [qd]);
      await c.query("select public.publish_one('product', $1)", [q.productId]);

      // And the old product form over a sale: loaded M = 1, the piece sells, the
      // form saves M = 1 back and logs it as a correction.
      const z = await liveProduct(c, admin, { sizes: [{ label: "M", stock_quantity: 1 }] });
      const zo = await paidOrder(c, [{ id: z.productId, size: "M", quantity: 1 }]);
      await sell(c, zo, [{ id: z.productId, size: "M", quantity: 1 }]);
      await asAdmin(c, admin);
      await c.query("select public.save_product_sizes($1, $2::jsonb)", [z.productId, JSON.stringify([{ label: "M", stock_quantity: 1 }])]);
      check("before 0060: the old form put the sold size back", (await sizesOf(c, z.productId)).M, 1);

      // As shipped, the audit does not assume when the log began: this draft was
      // opened before the first movement ever logged, so it is not vouched for.
      const asShipped = (await historyAudit(c)).filter((r) => r.slug === p.slug && r.finding !== "first publication");
      check("history audit, default: a draft opened before the first logged movement is only 'inconclusive'",
        asShipped.map((r) => [r.finding, r.confidence]), [["restored moved stock", "inconclusive"]]);

      // Once the owner confirms the log covers it, the same row is a candidate.
      const audit = await historyAudit(c, "2000-01-01 00:00:00+00");
      const row = (slug: string) => audit.filter((r) => r.slug === slug && r.finding !== "first publication");
      check("history audit, log start confirmed: the resurrected piece is a candidate 'restored moved stock', by +1",
        row(p.slug).map((r) => [r.section, r.finding, r.confidence, r.changed_by]),
        [["publication", "restored moved stock", "candidate", 1]]);
      check("history audit: a deliberate old-style draft edit reads as intentional",
        row(q.slug).map((r) => [r.finding, r.confidence, r.changed_by]), [["intentional draft edit", "candidate", 3]]);
      check("history audit: the sized form overwrite is a size-overwrite candidate",
        row(z.slug).map((r) => [r.section, r.size_label, r.confidence, r.changed_by]), [["size overwrite", "M", "candidate", 1]]);
      await c.end();
    }

    // ══ With 0060 ══
    await engine.database("after0060");
    const c = await engine.connect("after0060");
    const admin = await makeAdmin(c);
    const other = await makeAdmin(c, "second@example.test");

    // ── The acceptance test, twice ──
    for (const path of ["publish_one", "publish_all"] as const) {
      console.log(`\n=== acceptance: name-only draft, sale, ${path} ===`);
      const p = await liveProduct(c, admin, { stock: 1 });
      const before = (await liveRow(c, p.productId))!;
      const draftId = await nameOnlyDraft(c, admin, p.productId, "Tennis Choker Necklace");
      const order = await paidOrder(c, [{ id: p.productId, quantity: 1 }]);
      check("sale reserves one", (await sell(c, order, [{ id: p.productId, quantity: 1 }])).reserved, 1);
      check("live stock is 0 after the sale", (await liveRow(c, p.productId))!.stock_quantity, 0);

      await asAdmin(c, admin);
      if (path === "publish_one") await c.query("select public.publish_one('product', $1)", [p.productId]);
      else await c.query("select public.publish_all()");
      await asRoot(c);

      const after = (await liveRow(c, p.productId))!;
      check("live stock STAYS 0 after publishing", after.stock_quantity, 0);
      check("products mirror is 0 too", after.mirror, 0);
      check("the name did change", after.name, "Tennis Choker Necklace");
      check("version advanced by exactly one", after.version, before.version + 1);
      check("same product identity", after.identity, before.identity);
      check("price unchanged", after.price_inr, before.price_inr);
      check("cost price unchanged", after.cost_price_inr, before.cost_price_inr);
      check("SKU unchanged", after.sku, before.sku);
      check("slug unchanged", [after.slug, after.identity_slug], [before.slug, before.identity_slug]);
      const ms = await movements(c, p.productId);
      check("history: exactly one movement, the sale", ms.map((m) => [m.reason, m.delta]), [["sale", -1]]);
      check("history adds up: opening 1 + movements = live", 1 + sum(ms), after.stock_quantity);
      const archived = (await c.query(
        "select stock_quantity from product_versions where id = $1", [before.id])).rows[0].stock_quantity;
      check("the archived version keeps the stock it had when archived", archived, 0);
      const carried = (await c.query(
        `select count(*)::int n from admin_audit_log
          where table_name = 'product_versions' and record_id = $1
            and changes -> 'stock_quantity' = '{"from": 1, "to": 0}'::jsonb`, [draftId])).rows[0].n;
      // Keyed by the VERSION id: 0040 rewrote log_admin_action and dropped
      // 0014's grouping by product id. Pre-existing, noted, not changed here.
      check("the carry-forward is in the audit log, not hidden", carried, 1);
      check("the piece cannot be sold again",
        await failure(() => sell(c, randomUUID(), [{ id: p.productId, quantity: 1 }])) !== "", true);
    }

    // ── Stock that rose while the draft waited ──
    console.log("\n=== a deliberate increase made after the draft opened survives publish ===");
    {
      const p = await liveProduct(c, admin, { stock: 1 });
      await nameOnlyDraft(c, admin, p.productId, "Renamed");
      await asAdmin(c, admin);
      const r = (await c.query("select public.set_product_stock($1, 1, 3, $2) r", [p.productId, randomUUID()])).rows[0].r;
      check("adjustment applied", r.status, "applied");
      await c.query("select public.publish_one('product', $1)", [p.productId]);
      check("published stock is the adjusted 3", (await liveRow(c, p.productId))!.stock_quantity, 3);
      check("one correction movement of +2", (await movements(c, p.productId)).map((m) => [m.reason, m.delta]), [["correction", 2]]);
    }

    // ── New products keep their opening stock ──
    console.log("\n=== a brand-new product publishes with its opening stock ===");
    {
      const p = await liveProduct(c, admin, { stock: 5 });
      check("opening stock 5 is live", (await liveRow(c, p.productId))!.stock_quantity, 5);
      check("no movement invented for opening stock", (await movements(c, p.productId)).length, 0);
    }

    // ── Sized ──
    console.log("\n=== sized product: publish respects product_sizes ===");
    {
      const p = await liveProduct(c, admin, { sizes: [{ label: "S", stock_quantity: 1 }, { label: "M", stock_quantity: 2 }] });
      await nameOnlyDraft(c, admin, p.productId, "Renamed sized");
      const order = await paidOrder(c, [{ id: p.productId, size: "M", quantity: 1 }]);
      await sell(c, order, [{ id: p.productId, size: "M", quantity: 1 }]);
      await asAdmin(c, admin);
      await c.query("select public.publish_one('product', $1)", [p.productId]);
      await asRoot(c);
      check("sizes after publish", await sizesOf(c, p.productId), { S: 1, M: 1 });
      check("version total derived from sizes", (await liveRow(c, p.productId))!.stock_quantity, 2);
      check("set_product_stock refuses a sized product",
        await failure(async () => { await asAdmin(c, admin); await c.query("select public.set_product_stock($1, 2, 5, $2)", [p.productId, randomUUID()]); }),
        "SIZED_PRODUCT");
      await asRoot(c);
    }

    // ── set_product_stock ──
    console.log("\n=== set_product_stock: expected value, retries, refusals ===");
    {
      const p = await liveProduct(c, admin, { stock: 4 });
      await nameOnlyDraft(c, admin, p.productId, "Has a draft");
      await asAdmin(c, admin);
      const req = randomUUID();
      const r1 = (await c.query("select public.set_product_stock($1, 4, 6, $2, 'Found two more', 'restock') r", [p.productId, req])).rows[0].r;
      check("applied with the right expected", [r1.status, r1.quantity, r1.delta], ["applied", 6, 2]);
      const draftQty = (await c.query("select stock_quantity from product_versions where product_id = $1 and state = 'draft'", [p.productId])).rows[0].stock_quantity;
      check("the open draft shows the same figure", draftQty, 6);
      check("products mirror follows", (await liveRow(c, p.productId))!.mirror, 6);
      await asAdmin(c, admin);
      const r2 = (await c.query("select public.set_product_stock($1, 4, 6, $2, 'Found two more', 'restock') r", [p.productId, req])).rows[0].r;
      check("an identical retry (same id, same request): already applied, same answer",
        [r2.status, r2.quantity, r2.delta], ["already_applied", 6, 2]);
      for (const [label, args] of [
        ["another quantity", [4, 7, "restock"]],
        ["another expected", [5, 6, "restock"]],
        ["another reason", [4, 6, "correction"]],
      ] as const) {
        check(`the same id with ${label}: REQUEST_ID_REUSED, not already_applied`,
          await failure(() => c.query("select public.set_product_stock($1, $2, $3, $4, null, $5)", [p.productId, args[0], args[1], req, args[2]])),
          "REQUEST_ID_REUSED");
      }
      const ms = await movements(c, p.productId);
      check("…and it wrote nothing more", ms.map((m) => [m.reason, m.delta, m.request_id === req, m.actor_id === admin]), [["restock", 2, true, true]]);

      check("a stale expected is refused and names the live figure",
        await failure(() => c.query("select public.set_product_stock($1, 4, 9, $2)", [p.productId, randomUUID()])), "STOCK_CHANGED:6");
      check("…and changed nothing", (await liveRow(c, p.productId))!.stock_quantity, 6);

      // The trap the brief names: the requested figure equals the shelf, but only
      // because a sale moved it there. That is not "my retry landed".
      const o = await paidOrder(c, [{ id: p.productId, quantity: 1 }]);
      await sell(c, o, [{ id: p.productId, quantity: 1 }]);
      await asAdmin(c, admin);
      check("shelf reached the requested figure by a sale: still STOCK_CHANGED, not success",
        await failure(() => c.query("select public.set_product_stock($1, 6, 5, $2)", [p.productId, randomUUID()])), "STOCK_CHANGED:5");

      const r3 = (await c.query("select public.set_product_stock($1, 5, 5, $2) r", [p.productId, randomUUID()])).rows[0].r;
      check("expected = live = requested: unchanged, nothing written", r3.status, "unchanged");
      check("no movement for an unchanged request", (await movements(c, p.productId)).length, 2);

      check("negative refused", await failure(() => c.query("select public.set_product_stock($1, 5, -1, $2)", [p.productId, randomUUID()])), "NEGATIVE_STOCK");
      check("expected is required", await failure(() => c.query("select public.set_product_stock($1, null, 1, $2)", [p.productId, randomUUID()])), "EXPECTED_REQUIRED");
      check("request id is required", await failure(() => c.query("select public.set_product_stock($1, 5, 1, null)", [p.productId])), "REQUEST_ID_REQUIRED");
      const q = await liveProduct(c, admin, { stock: 1 });
      await asAdmin(c, admin);
      check("a request id cannot be reused for another product",
        await failure(() => c.query("select public.set_product_stock($1, 1, 2, $2)", [q.productId, req])), "REQUEST_ID_REUSED");

      await asRoot(c);
      await c.query("insert into auth.users (id, email) values ($1, 'shopper@example.test')", [randomUUID()]);
      const shopper = (await c.query("select id from auth.users where email = 'shopper@example.test'")).rows[0].id;
      await asAdmin(c, shopper);
      check("a signed-in non-admin is refused",
        await failure(() => c.query("select public.set_product_stock($1, 5, 1, $2)", [p.productId, randomUUID()])), "Only admins can edit stock");
      await c.query("set role anon");
      check("anon cannot even call it",
        /permission denied/.test(await failure(() => c.query("select public.set_product_stock($1, 5, 1, $2)", [p.productId, randomUUID()]))), true);
      await asRoot(c);
    }

    console.log("\n=== set_product_stock before first publication ===");
    {
      await asAdmin(c, admin);
      const vid = (await c.query("select public.create_product_draft() id")).rows[0].id;
      const pid = (await c.query(
        "update product_versions set name = 'Unpublished', slug = 'unpublished-x', price_inr = 100, stock_quantity = 2, allow_no_images = true where id = $1 returning product_id",
        [vid])).rows[0].product_id;
      const r = (await c.query("select public.set_product_stock($1, 2, 7, $2) r", [pid, randomUUID()])).rows[0].r;
      check("sets the draft's opening stock", r.status, "opening_stock");
      check("no movement for a product nobody can buy yet", (await movements(c, pid)).length, 0);
      await c.query("select public.publish_one('product', $1)", [pid]);
      check("…and it publishes with that opening stock", (await liveRow(c, pid))!.stock_quantity, 7);
      await asRoot(c);
    }

    // ── Cancellation ──
    console.log("\n=== cancellation puts stock back, and only when it can ===");
    {
      const p = await liveProduct(c, admin, { stock: 1 });
      const o = await paidOrder(c, [{ id: p.productId, quantity: 1, name: "Saree" }]);
      await sell(c, o, [{ id: p.productId, quantity: 1 }]);
      await asAdmin(c, admin);
      const r = (await c.query("select public.cancel_order($1, 'test') r", [o])).rows[0].r;
      check("stock_returned", [r.stock_returned, r.stock_unreturned, r.stock_note], [true, [], null]);
      check("stock is back to 1", (await liveRow(c, p.productId))!.stock_quantity, 1);
      check("sale then cancellation in the log", (await movements(c, p.productId)).map((m) => [m.reason, m.delta]), [["sale", -1], ["cancellation", 1]]);

      const s = await liveProduct(c, admin, { sizes: [{ label: "M", stock_quantity: 1 }, { label: "L", stock_quantity: 1 }] });
      const o2 = await paidOrder(c, [{ id: s.productId, size: "M", quantity: 1, name: "Kurta" }]);
      await sell(c, o2, [{ id: s.productId, size: "M", quantity: 1 }]);
      await asAdmin(c, admin);
      await c.query("select public.save_product_sizes($1, $2::jsonb)", [s.productId, JSON.stringify([{ label: "M", remove: true, expected: 0 }])]);
      const before = (await movements(c, s.productId)).length;
      const r2 = (await c.query("select public.cancel_order($1, 'test') r", [o2])).rows[0].r;
      check("a size removed since the sale: not returned, and says so",
        [r2.stock_returned, r2.stock_unreturned.length, /Kurta \(M\)/.test(r2.stock_note ?? "")], [false, 1, true]);
      check("…and no movement claims it came back", (await movements(c, s.productId)).length, before);
      check("…and the credit note was still issued", !!r2.credit_note, true);
      await asRoot(c);
    }

    // ── The audit file is read-only by construction ──
    console.log("\n=== the history audit is a single read-only statement ===");
    {
      // Comments and string literals removed: `a.action = 'update'` names an
      // audit-log value, it is not a statement.
      const code = HISTORY_AUDIT.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
        .replace(/'(?:[^']|'')*'/g, "''").toLowerCase();
      check("no write, DDL, grant, transaction or side-effecting call outside comments",
        code.match(/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|copy|call|do|perform|nextval|setval|set_config|pg_advisory\w*|begin|commit|rollback|vacuum|refresh)\b/g), null);
      check("exactly one statement", code.split(";").filter((x) => x.trim()).length, 1);
    }

    // ── Failure and repetition ──
    console.log("\n=== failed publication rolls back; repeated publication is refused ===");
    {
      const p = await liveProduct(c, admin, { stock: 1 });
      const vid = await nameOnlyDraft(c, admin, p.productId, "Will fail");
      await asRoot(c);
      // Take the draft's photographs away so the publish is refused part-way:
      // after the carry-forward, at the promotion (0042's trigger).
      await c.query("delete from product_images where product_version_id = $1", [vid]);
      const o = await paidOrder(c, [{ id: p.productId, quantity: 1 }]);
      await sell(c, o, [{ id: p.productId, quantity: 1 }]);
      await asAdmin(c, admin);
      check("publish refused (no photographs)",
        /PRODUCT_HAS_NO_IMAGES/.test(await failure(() => c.query("select public.publish_one('product', $1)", [p.productId]))), true);
      await asRoot(c);
      const draft = (await c.query("select state, stock_quantity, name from product_versions where id = $1", [vid])).rows[0];
      check("the draft is untouched: still a draft, carry-forward rolled back", [draft.state, draft.stock_quantity, draft.name], ["draft", 1, "Will fail"]);
      check("live stock still 0, live name unchanged", [(await liveRow(c, p.productId))!.stock_quantity, (await liveRow(c, p.productId))!.name.startsWith("Piece")], [0, true]);

      await c.query("insert into product_images (product_version_id, product_id, url) values ($1, $2, 'https://example.test/q.jpg')", [vid, p.productId]);
      await asAdmin(c, admin);
      await c.query("select public.publish_one('product', $1)", [p.productId]);
      check("a second publish of the same draft is refused",
        await failure(() => c.query("select public.publish_one('product', $1)", [p.productId])), "Nothing pending for that product");
      check("…and stock is still 0", (await liveRow(c, p.productId))!.stock_quantity, 0);
      await asRoot(c);
    }

    // ── Draft comparison ──
    console.log("\n=== a stale stock figure alone is not a pending change ===");
    {
      const p = await liveProduct(c, admin, { stock: 2 });
      await asAdmin(c, admin);
      const vid = (await c.query("select public.ensure_product_draft($1) id", [p.productId])).rows[0].id;
      const o = await paidOrder(c, [{ id: p.productId, quantity: 1 }]);
      await sell(c, o, [{ id: p.productId, quantity: 1 }]);
      await asAdmin(c, admin);
      check("draft whose only difference is stale stock is a no-op",
        (await c.query("select public.draft_is_noop('product', $1) v", [vid])).rows[0].v, true);
      check("settle_draft clears it away", (await c.query("select public.settle_draft('product', $1) v", [vid])).rows[0].v, true);

      await nameOnlyDraft(c, admin, p.productId, "Now really changed");
      await asAdmin(c, admin);
      const o2 = await paidOrder(c, [{ id: p.productId, quantity: 1 }]);
      await sell(c, o2, [{ id: p.productId, quantity: 1 }]);
      await asAdmin(c, admin);
      const queue = (await c.query("select public.pending_queue() q")).rows[0].q as { entity_id: string; changes: { field: string }[] }[];
      const item = queue.find((i) => i.entity_id === p.productId);
      check("the queue lists the rename and does not list stock", item?.changes.map((x) => x.field), ["name"]);
      await asRoot(c);
    }

    // ── The guard ──
    console.log("\n=== live stock cannot be written around the functions ===");
    {
      const p = await liveProduct(c, admin, { stock: 1 });
      const live = (await liveRow(c, p.productId))!;
      await asAdmin(c, admin);
      check("an admin's direct write to live stock is refused",
        await failure(() => c.query("update product_versions set stock_quantity = 9 where id = $1", [live.id])), "LIVE_STOCK_LOCKED");
      check("…but other live fields are not affected by the guard",
        await failure(() => c.query("update product_versions set is_active = true where id = $1", [live.id])), "");
      const vid = (await c.query("select public.ensure_product_draft($1) id", [p.productId])).rows[0].id;
      // What an admin tab still running the old code does for a stock edit: it
      // writes the draft. That now fails out loud instead of saving a figure
      // publishing would ignore.
      check("an old-style stock write into a live product's draft is refused",
        await failure(() => c.query("update product_versions set stock_quantity = 9 where id = $1", [vid])), "STOCK_IS_LIVE");
      check("…while a descriptive write to the same draft is not",
        await failure(() => c.query("update product_versions set name = 'Still editable' where id = $1", [vid])), "");
      check("the draft's figure still does not reach the shelf", await (async () => {
        await c.query("select public.publish_one('product', $1)", [p.productId]);
        return (await liveRow(c, p.productId))!.stock_quantity;
      })(), 1);
      await asAdmin(c, admin);
      check("direct writes to product_sizes are no longer granted",
        /permission denied/.test(await failure(() => c.query("insert into product_sizes (product_id, label, stock_quantity) values ($1, 'XL', 5)", [p.productId]))), true);
      await asRoot(c);
    }

    // ── Sizes ──
    console.log("\n=== save_product_sizes: only what changed, only against what was seen ===");
    {
      const p = await liveProduct(c, admin, { sizes: [{ label: "S", stock_quantity: 1 }, { label: "M", stock_quantity: 1 }, { label: "L", stock_quantity: 2 }] });
      // The form opens here and loads S1 M1 L2.
      const o = await paidOrder(c, [{ id: p.productId, size: "M", quantity: 1 }]);
      await sell(c, o, [{ id: p.productId, size: "M", quantity: 1 }]);
      const logged = (await movements(c, p.productId)).length;
      await asAdmin(c, admin);
      const form = (sizes: Record<string, number>, edits: Record<string, number> = {}) =>
        JSON.stringify(Object.entries(sizes).map(([label, q]) => ({ label, expected: q, stock_quantity: edits[label] ?? q })));

      await c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, form({ S: 1, M: 1, L: 2 })]);
      check("an untouched stale form does NOT restock the sold size", await sizesOf(c, p.productId), { S: 1, M: 0, L: 2 });
      check("…and logs nothing", (await movements(c, p.productId)).length, logged);

      check("a stale EDITED quantity is refused, naming the live figure",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, form({ S: 1, M: 1, L: 2 }, { M: 3 })])), "STOCK_CHANGED:M:0");
      check("…and the shelf is unchanged", await sizesOf(c, p.productId), { S: 1, M: 0, L: 2 });

      check("one fresh edit and one stale edit in the same save: refused",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, form({ S: 1, M: 1, L: 2 }, { S: 5, M: 3 })])), "STOCK_CHANGED:M:0");
      check("…and the fresh one did not land either (all or nothing)", await sizesOf(c, p.productId), { S: 1, M: 0, L: 2 });

      await c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, form({ S: 1, M: 0, L: 2 }, { S: 5, M: 3 })]);
      check("the same edits against the current figures land", await sizesOf(c, p.productId), { S: 5, M: 3, L: 2 });

      const req = randomUUID();
      await c.query("select public.save_product_sizes($1, $2::jsonb, null, $3)", [p.productId, form({ S: 5, M: 3, L: 2 }, { L: 4 }), req]);
      check("a correct edit lands", (await sizesOf(c, p.productId)).L, 4);
      const retry = (await c.query("select public.save_product_sizes($1, $2::jsonb, null, $3) r", [p.productId, form({ S: 5, M: 3, L: 2 }, { L: 4 }), req])).rows[0].r;
      check("the same request retried: already applied", retry.status, "already_applied");

      check("removing a size whose count moved is refused",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, JSON.stringify([{ label: "L", remove: true, expected: 2 }])])), "STOCK_CHANGED:L:4");
      await c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, JSON.stringify([{ label: "L", remove: true, expected: 4 }, { label: "XL", stock_quantity: 2 }])]);
      check("remove with the right count; add a new size; others untouched", await sizesOf(c, p.productId), { S: 5, M: 3, XL: 2 });
      // Same transaction, same now(): compared as a set, not a sequence.
      const tail = (await movements(c, p.productId)).slice(-2).map((m) => [m.reason, m.size_label, m.delta]).sort();
      check("…logged as a correction out and a restock in", tail, [["correction", "L", -4], ["restock", "XL", 2]]);

      check("an existing size sent without `expected` (the old form) is refused",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, JSON.stringify([{ label: "S", stock_quantity: 1 }])])), "EXPECTED_REQUIRED:S");
      check("the old three-argument signature is gone",
        (await c.query("select count(*)::int n from pg_proc where proname = 'save_product_sizes'")).rows[0].n, 1);
      check("a size the admin saw but that has since gone is refused",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, JSON.stringify([{ label: "L", stock_quantity: 9, expected: 4 }])])), "STOCK_CHANGED:L:gone");
      check("negative refused", await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, JSON.stringify([{ label: "XXL", stock_quantity: -1 }])])), "NEGATIVE_STOCK:XXL");
      check("duplicate refused", await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, JSON.stringify([{ label: "q", stock_quantity: 1 }, { label: "Q", stock_quantity: 1 }])])), "DUPLICATE_SIZE:Q");
      await asAdmin(c, other);
      check("a second admin's unchanged form leaves every count alone",
        await (async () => { await c.query("select public.save_product_sizes($1, $2::jsonb)", [p.productId, form({ S: 1, M: 1, XL: 0 })]); return sizesOf(c, p.productId); })(),
        { S: 5, M: 3, XL: 2 });
      await asRoot(c);
    }

    // ── The admin form's own payloads, against the real function ──
    console.log("\n=== the product form's payloads (lib/inventory) against save_product_sizes ===");
    {
      const p = await liveProduct(c, admin, { sizes: [{ label: "S", stock_quantity: 1 }, { label: "M", stock_quantity: 1 }] });
      const opened = (await c.query("select id, label, stock_quantity from product_sizes where product_id = $1 order by sort_order", [p.productId])).rows as LoadedSize[];
      const o = await paidOrder(c, [{ id: p.productId, size: "M", quantity: 1 }]);
      await sell(c, o, [{ id: p.productId, size: "M", quantity: 1 }]);
      await asAdmin(c, admin);
      const save = (edited: { id?: string; label: string; stock_quantity: number }[]) =>
        failure(() => c.query("select public.save_product_sizes($1, $2::jsonb, null, $3)", [p.productId, JSON.stringify(sizeChanges(opened, edited)), randomUUID()]));
      check("form opened before the sale, description-only save: nothing is sent", sizeChanges(opened, opened.map((r) => ({ ...r }))), []);
      check("form opened before the sale, sizes reordered: accepted", await save([opened[1], opened[0]].map((r) => ({ ...r }))), "");
      check("…and M stays sold", await sizesOf(c, p.productId), { S: 1, M: 0 });
      check("form opened before the sale, M edited: refused, naming the live figure",
        await save(opened.map((r) => (r.label === "M" ? { ...r, stock_quantity: 4 } : { ...r }))), "STOCK_CHANGED:M:0");
      check("form opened before the sale, only S edited: S lands, M untouched",
        [await save(opened.map((r) => (r.label === "S" ? { ...r, stock_quantity: 3 } : { ...r }))), await sizesOf(c, p.productId)],
        ["", { S: 3, M: 0 }]);
      await asRoot(c);
    }

    // ── The admin as it runs on main today, against 0060 ──
    // Exactly the writes main's admin code makes (ProductModal, ProductTable's
    // StockEditor, the CSV import, sizes, publish), made by an old browser tab
    // after the migration and before the new app reaches it. None may move the
    // shelf; the ones that would have are refused out loud.
    console.log("\n=== an admin tab still running main's code, against 0060 ===");
    {
      const p = await liveProduct(c, admin, { stock: 2 });
      const z = await liveProduct(c, admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
      const o = await paidOrder(c, [{ id: p.productId, quantity: 1 }, { id: z.productId, size: "M", quantity: 1 }]);
      await sell(c, o, [{ id: p.productId, quantity: 1 }, { id: z.productId, size: "M", quantity: 1 }]);
      await asAdmin(c, admin);
      // The page was loaded before the sale: it shows 2 and M = 2.
      const draft = (await c.query("select public.ensure_product_draft($1) id", [p.productId])).rows[0].id;
      check("old ProductModal, description saved with the page's stale stock (2): refused out loud, nothing saved",
        await failure(() => c.query("update product_versions set description = 'new words', stock_quantity = 2 where id = $1", [draft])), "STOCK_IS_LIVE");
      check("old ProductModal, description saved with the draft's own figure: accepted",
        await failure(() => c.query("update product_versions set description = 'new words', stock_quantity = (select stock_quantity from product_versions where id = $1) where id = $1", [draft])), "");
      check("old StockEditor (writes the draft): refused out loud",
        await failure(() => c.query("update product_versions set stock_quantity = 5 where id = $1", [draft])), "STOCK_IS_LIVE");
      check("old CSV import update (writes stock into the draft): refused out loud",
        await failure(() => c.query("update product_versions set price_inr = 2600, stock_quantity = 9 where id = $1", [draft])), "STOCK_IS_LIVE");
      check("old sizes save (every loaded count, no expected): refused out loud",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)", [z.productId, JSON.stringify([{ label: "M", stock_quantity: 2 }])])), "EXPECTED_REQUIRED:M");
      check("old sizes save for an unsized product (empty list): a harmless no-op",
        await failure(() => c.query("select public.save_product_sizes($1, '[]'::jsonb)", [p.productId])), "");
      check("old Publish button (the same RPC): publishes, carrying the live stock",
        await failure(() => c.query("select public.publish_one('product', $1)", [p.productId])), "");
      check("…and after all of that the shelf is exactly what the sale left", [(await liveRow(c, p.productId))!.stock_quantity, (await sizesOf(c, z.productId)).M], [1, 1]);
      await asRoot(c);
    }

    // ── Settlement guarantees from 0058 still hold ──
    console.log("\n=== 0058's settlement guarantees are intact ===");
    {
      const p = await liveProduct(c, admin, { stock: 2 });
      const q = await liveProduct(c, admin, { sizes: [{ label: "M", stock_quantity: 1 }] });
      const o = await paidOrder(c, [{ id: p.productId, quantity: 1 }, { id: q.productId, size: "M", quantity: 1 }]);
      const items = [{ id: q.productId, size: "M", quantity: 1 }, { id: p.productId, quantity: 1 }];
      check("first settlement reserves both", (await sell(c, o, items)).reserved, 2);
      const again = await sell(c, o, items);
      check("replayed settlement moves nothing", [again.reserved, again.already_reserved], [0, 2]);
      check("stock taken once", [(await liveRow(c, p.productId))!.stock_quantity, (await sizesOf(c, q.productId)).M], [1, 0]);
      const o2 = await paidOrder(c, [{ id: p.productId, quantity: 2 }]);
      check("SOLD_OUT still refuses", /SOLD_OUT/.test(await failure(() => sell(c, o2, [{ id: p.productId, quantity: 2 }]))), true);
      check("…and leaves no claim behind", (await c.query("select count(*)::int n from stock_movements where order_id = $1", [o2])).rows[0].n, 0);
      await asService(c);
      check("sized line without a size is refused",
        /SIZE_REQUIRED/.test(await failure(() => c.query("select public.reserve_stock($1::jsonb, $2)", [JSON.stringify([{ id: q.productId, size: "", quantity: 1 }]), o2]))), true);
      await asAdmin(c, admin);
      check("reserve_stock is still service_role only",
        /permission denied/.test(await failure(() => c.query("select public.reserve_stock('[]'::jsonb, null)"))), true);
      await asService(c);
      check("service_role cannot call set_product_stock's admin path",
        await failure(() => c.query("select public.set_product_stock($1, 1, 2, $2)", [p.productId, randomUUID()])), "Only admins can edit stock");
      await asRoot(c);
    }

    // ── publish_all over several products ──
    console.log("\n=== publish_all: several products, new, live and deleted ===");
    {
      const a = await liveProduct(c, admin, { stock: 1 });
      const b = await liveProduct(c, admin, { stock: 3 });
      const gone = await liveProduct(c, admin, { stock: 1 });
      await nameOnlyDraft(c, admin, a.productId, "A renamed");
      await nameOnlyDraft(c, admin, b.productId, "B renamed");
      await asAdmin(c, admin);
      const gv = (await c.query("select public.ensure_product_draft($1) id", [gone.productId])).rows[0].id;
      await c.query("update product_versions set pending_delete = true where id = $1", [gv]);
      const nv = (await c.query("select public.create_product_draft() id")).rows[0].id;
      const newId = (await c.query("update product_versions set name='Fresh', slug='fresh-x', price_inr=100, stock_quantity=4, allow_no_images=true where id=$1 returning product_id", [nv])).rows[0].product_id;
      const o = await paidOrder(c, [{ id: b.productId, quantity: 1 }, { id: a.productId, quantity: 1 }]);
      await sell(c, o, [{ id: b.productId, quantity: 1 }, { id: a.productId, quantity: 1 }]);
      await asAdmin(c, admin);
      const res = (await c.query("select public.publish_all() r")).rows[0].r;
      // Earlier sections leave drafts of their own; all of them publish too.
      check("published at least these three", res.products >= 3, true);
      check("live stock kept for both live products", [(await liveRow(c, a.productId))!.stock_quantity, (await liveRow(c, b.productId))!.stock_quantity], [0, 2]);
      check("new product has its opening stock", (await liveRow(c, newId))!.stock_quantity, 4);
      check("deleted product is gone", (await c.query("select count(*)::int n from products where id = $1", [gone.productId])).rows[0].n, 0);
      await asRoot(c);
    }

    console.log("\n=== the history audit finds nothing to question after 0060 ===");
    {
      const asShipped = await historyAudit(c);
      check("as shipped: no publication is flagged restored or unexplained",
        asShipped.filter((r) => r.section === "publication" && !["consistent", "first publication"].includes(r.finding)).map((r) => [r.slug, r.finding]), []);
      const audit = await historyAudit(c, "2000-01-01 00:00:00+00");
      const pubs = audit.filter((r) => r.section === "publication");
      check(`every publication in this run (${pubs.length}) is conclusive: consistent or a first publication`,
        pubs.filter((r) => r.confidence !== "conclusive").map((r) => [r.slug, r.finding]), []);
      check("every size count in this run matches its movement history",
        audit.filter((r) => r.section === "size balance").map((r) => [r.slug, r.size_label]), []);
      // Deliberate recounts right after a sale look like the old overwrite, by
      // design of the heuristic; they must only ever be candidates.
      check("size-overwrite rows are only ever candidates",
        audit.filter((r) => r.section === "size overwrite" && r.confidence !== "candidate").length, 0);
    }

    await c.end();
  } finally {
    await engine.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
