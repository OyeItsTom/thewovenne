/**
 * 0060 under concurrency — on a real PostgreSQL server, several connections.
 *
 * Every scenario is FORCED to overlap: the first transaction takes its locks
 * and stays open; the second is started and the test waits until Postgres
 * itself reports it blocked on the first (pg_blocking_pids) before letting the
 * first commit. A scenario whose second operation never waited fails, because
 * "it passed" would then mean only that the two never met.
 *
 * Where the old functions went wrong, the same forced overlap is run against a
 * database with migrations only through 0059 and the old failure is asserted —
 * proof that the scenario reaches the code path, not just that it passes.
 *
 * Then a randomised run: several connections selling, cancelling, adjusting and
 * publishing the same few products at once, checking afterwards that no
 * deadlock or timeout occurred and that every unsized product's live stock
 * equals its opening stock plus its movements.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> \
 *     npx tsx scripts/stock-concurrency.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import { randomUUID } from "node:crypto";
import { asAdmin, asRoot, asService, makeAdmin, startEngine, type Client, type Engine } from "./pg-world";
import { liveProduct, liveRow, movements, nameOnlyDraft, paidOrder, sell, sizesOf, sum } from "./stock-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

type Outcome = { value?: unknown; error?: string; code?: string };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then((value) => ({ value }), (e) => ({ error: (e as Error).message, code: (e as { code?: string }).code }));

async function pidOf(c: Client): Promise<number> {
  return (await c.query("select pg_backend_pid() p")).rows[0].p as number;
}

/** True once `waiter` is waiting on a lock held by `holder`, as Postgres reports it. */
async function waitsOn(observer: Client, waiter: number, holder: number, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const { rows } = await observer.query("select pg_blocking_pids($1) b", [waiter]);
    if ((rows[0]?.b as number[] | undefined)?.includes(holder)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

interface World {
  db: string;
  root: Client;
  a: Client;
  b: Client;
  obs: Client;
  admin: string;
  pa: number;
  pb: number;
}

async function world(engine: Engine, db: string): Promise<World> {
  const root = await engine.connect(db);
  const a = await engine.connect(db);
  const b = await engine.connect(db);
  const obs = await engine.connect(db);
  for (const c of [a, b]) {
    // A hang becomes a failure with a code, not a stuck test.
    await c.query("set statement_timeout = '20s'");
    await c.query("set lock_timeout = '15s'");
  }
  const admin = await makeAdmin(root);
  return { db, root, a, b, obs, admin, pa: await pidOf(a), pb: await pidOf(b) };
}

/**
 * `first` runs inside an open transaction on connection a; `second` is started
 * on b and must be seen waiting on a before a ends.
 */
async function overlap(
  w: World,
  first: (c: Client) => Promise<unknown>,
  second: (c: Client) => Promise<unknown>,
  end: "commit" | "rollback" = "commit"
) {
  await w.a.query("begin");
  const firstOut = await settle(first(w.a));
  if (firstOut.error) {
    await w.a.query("rollback");
    return { first: firstOut, second: { error: "not started" } as Outcome, waited: false };
  }
  const running = settle(second(w.b));
  const waited = await waitsOn(w.obs, w.pb, w.pa);
  await w.a.query(end);
  const secondOut = await running;
  return { first: firstOut, second: secondOut, waited };
}

const publishOne = (admin: string, productId: string) => async (c: Client) => {
  await asAdmin(c, admin);
  return (await c.query("select public.publish_one('product', $1) r", [productId])).rows[0].r;
};
const publishAll = (admin: string) => async (c: Client) => {
  await asAdmin(c, admin);
  return (await c.query("select public.publish_all() r")).rows[0].r;
};
const reserve = (orderId: string, items: { id: string; size?: string; quantity: number }[]) => async (c: Client) => {
  await asService(c);
  return (await c.query("select public.reserve_stock($1::jsonb, $2) r", [
    JSON.stringify(items.map((i) => ({ id: i.id, size: i.size ?? "One Size", quantity: i.quantity }))), orderId,
  ])).rows[0].r;
};
const cancel = (admin: string, orderId: string) => async (c: Client) => {
  await asAdmin(c, admin);
  return (await c.query("select public.cancel_order($1, 'test') r", [orderId])).rows[0].r;
};
const setStock = (admin: string, productId: string, expected: number, quantity: number) => async (c: Client) => {
  await asAdmin(c, admin);
  return (await c.query("select public.set_product_stock($1, $2, $3, $4) r", [productId, expected, quantity, randomUUID()])).rows[0].r;
};
const saveSizes = (admin: string, productId: string, sizes: unknown[], legacy = false) => async (c: Client) => {
  await asAdmin(c, admin);
  return (await c.query(
    legacy ? "select public.save_product_sizes($1, $2::jsonb) r" : "select public.save_product_sizes($1, $2::jsonb, null, $3) r",
    legacy ? [productId, JSON.stringify(sizes)] : [productId, JSON.stringify(sizes), randomUUID()]
  )).rows[0].r;
};

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    return;
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway), separate backends per connection`);

  try {
    await engine.database("old", "0059");
    await engine.database("new");
    const old = await world(engine, "old");
    const w = await world(engine, "new");

    // ══ A. A sale arrives while a publish holds its locks ══
    console.log("\n=== A. sale begins while publication holds locks ===");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 1 });
      await nameOnlyDraft(w.root, w.admin, p.productId, "Renamed A");
      const o = await paidOrder(w.root, [{ id: p.productId, quantity: 1 }]);
      const r = await overlap(w, publishOne(w.admin, p.productId), reserve(o, [{ id: p.productId, quantity: 1 }]));
      check("the sale really waited on the publish", r.waited, true);
      check("the sale succeeds (not a false SOLD_OUT)", [r.second.error ?? null, (r.second.value as { reserved: number })?.reserved], [null, 1]);
      const live = (await liveRow(w.root, p.productId))!;
      check("final: the new version is live, stock 0", [live.name, live.stock_quantity], ["Renamed A", 0]);
      check("one sale movement", (await movements(w.root, p.productId)).map((m) => [m.reason, m.delta]), [["sale", -1]]);
    }
    {
      const p = await liveProduct(old.root, old.admin, { stock: 1 });
      await nameOnlyDraft(old.root, old.admin, p.productId, "Renamed A");
      const o = await paidOrder(old.root, [{ id: p.productId, quantity: 1 }]);
      const r = await overlap(old, publishOne(old.admin, p.productId), reserve(o, [{ id: p.productId, quantity: 1 }]));
      check("CONTROL before 0060: same overlap, the sale waited", r.waited, true);
      check("CONTROL before 0060: the paid sale is falsely refused", /SOLD_OUT/.test(r.second.error ?? ""), true);
    }

    console.log("\n=== A'. the publish rolls back instead ===");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 1 });
      const draft = await nameOnlyDraft(w.root, w.admin, p.productId, "Never published");
      const o = await paidOrder(w.root, [{ id: p.productId, quantity: 1 }]);
      const r = await overlap(w, publishOne(w.admin, p.productId), reserve(o, [{ id: p.productId, quantity: 1 }]), "rollback");
      check("sale waited, then succeeded against the old version", [r.waited, r.second.error ?? null], [true, null]);
      const live = (await liveRow(w.root, p.productId))!;
      check("old name still live, stock 0", [live.name.startsWith("Piece"), live.stock_quantity], [true, 0]);
      const d = (await w.root.query("select state from product_versions where id = $1", [draft])).rows[0];
      check("the draft is still a draft", d.state, "draft");
    }

    // ══ B. A publish arrives while a sale holds its locks ══
    console.log("\n=== B. publication begins while a sale holds locks ===");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 1 });
      await nameOnlyDraft(w.root, w.admin, p.productId, "Renamed B");
      const o = await paidOrder(w.root, [{ id: p.productId, quantity: 1 }]);
      const r = await overlap(w, reserve(o, [{ id: p.productId, quantity: 1 }]), publishOne(w.admin, p.productId));
      check("the publish really waited on the sale", r.waited, true);
      check("both succeed", [r.first.error ?? null, r.second.error ?? null], [null, null]);
      check("final: stock 0, not the draft's 1", (await liveRow(w.root, p.productId))!.stock_quantity, 0);
    }
    {
      const p = await liveProduct(old.root, old.admin, { stock: 1 });
      await nameOnlyDraft(old.root, old.admin, p.productId, "Renamed B");
      const o = await paidOrder(old.root, [{ id: p.productId, quantity: 1 }]);
      const r = await overlap(old, reserve(o, [{ id: p.productId, quantity: 1 }]), publishOne(old.admin, p.productId));
      check("CONTROL before 0060: the publish waited", r.waited, true);
      check("CONTROL before 0060: the sold piece is back in stock", (await liveRow(old.root, p.productId))!.stock_quantity, 1);
    }

    // ══ C. Cancellation during publication ══
    console.log("\n=== C. cancellation during publication ===");
    for (const order of ["publish first", "cancel first"] as const) {
      const p = await liveProduct(w.root, w.admin, { stock: 1 });
      const o = await paidOrder(w.root, [{ id: p.productId, quantity: 1 }]);
      await sell(w.root, o, [{ id: p.productId, quantity: 1 }]);
      await nameOnlyDraft(w.root, w.admin, p.productId, "Renamed C"); // draft opened AFTER the sale: stock 0
      const r = order === "publish first"
        ? await overlap(w, publishOne(w.admin, p.productId), cancel(w.admin, o))
        : await overlap(w, cancel(w.admin, o), publishOne(w.admin, p.productId));
      check(`${order}: the second really waited`, r.waited, true);
      const cancelled = (order === "publish first" ? r.second : r.first).value as { stock_returned: boolean };
      check(`${order}: cancellation reports the stock returned`, cancelled?.stock_returned, true);
      check(`${order}: final stock 1 on the new version`, (await liveRow(w.root, p.productId))!.stock_quantity, 1);
      const ms = await movements(w.root, p.productId);
      check(`${order}: history adds up (1 + movements = live)`, 1 + sum(ms), 1);
    }
    {
      const p = await liveProduct(old.root, old.admin, { stock: 1 });
      const o = await paidOrder(old.root, [{ id: p.productId, quantity: 1 }]);
      await sell(old.root, o, [{ id: p.productId, quantity: 1 }]);
      await nameOnlyDraft(old.root, old.admin, p.productId, "Renamed C");
      const r = await overlap(old, publishOne(old.admin, p.productId), cancel(old.admin, o));
      const live = (await liveRow(old.root, p.productId))!.stock_quantity;
      const ms = await movements(old.root, p.productId);
      check("CONTROL before 0060: cancellation waited", r.waited, true);
      check("CONTROL before 0060: a return is logged that never reached the shelf", [live, 1 + sum(ms)], [0, 1]);
    }

    // ══ D. Admin stock adjustment during publication ══
    console.log("\n=== D. admin stock adjustment during publication ===");
    for (const order of ["publish first", "adjust first"] as const) {
      const p = await liveProduct(w.root, w.admin, { stock: 1 });
      await nameOnlyDraft(w.root, w.admin, p.productId, "Renamed D");
      const r = order === "publish first"
        ? await overlap(w, publishOne(w.admin, p.productId), setStock(w.admin, p.productId, 1, 5))
        : await overlap(w, setStock(w.admin, p.productId, 1, 5), publishOne(w.admin, p.productId));
      check(`${order}: the second really waited`, r.waited, true);
      check(`${order}: both succeed`, [r.first.error ?? null, r.second.error ?? null], [null, null]);
      const live = (await liveRow(w.root, p.productId))!;
      check(`${order}: final 5 on the new version`, [live.name, live.stock_quantity], ["Renamed D", 5]);
    }

    // ══ E. Two buyers, one piece ══
    console.log("\n=== E. two purchases competing for the final unit ===");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 1 });
      const o1 = await paidOrder(w.root, [{ id: p.productId, quantity: 1 }]);
      const o2 = await paidOrder(w.root, [{ id: p.productId, quantity: 1 }]);
      const r = await overlap(w, reserve(o1, [{ id: p.productId, quantity: 1 }]), reserve(o2, [{ id: p.productId, quantity: 1 }]));
      check("the second buyer really waited", r.waited, true);
      check("first succeeds, second is SOLD_OUT", [r.first.error ?? null, /SOLD_OUT/.test(r.second.error ?? "")], [null, true]);
      check("final 0, one sale movement", [(await liveRow(w.root, p.productId))!.stock_quantity, (await movements(w.root, p.productId)).length], [0, 1]);
      check("the refused order left no claim", (await w.root.query("select count(*)::int n from stock_movements where order_id = $1", [o2])).rows[0].n, 0);
    }

    // ══ F. Several products at once ══
    console.log("\n=== F. multi-product publication concurrent with a sale ===");
    for (const order of ["publish_all first", "sale first"] as const) {
      const x = await liveProduct(w.root, w.admin, { stock: 1 });
      const y = await liveProduct(w.root, w.admin, { stock: 1 });
      await nameOnlyDraft(w.root, w.admin, x.productId, "X renamed");
      await nameOnlyDraft(w.root, w.admin, y.productId, "Y renamed");
      // Lines deliberately in the opposite order to the product ids.
      const items = [x, y].sort((m, n) => n.productId.localeCompare(m.productId)).map((p) => ({ id: p.productId, quantity: 1 }));
      const o = await paidOrder(w.root, items);
      const r = order === "publish_all first"
        ? await overlap(w, publishAll(w.admin), reserve(o, items))
        : await overlap(w, reserve(o, items), publishAll(w.admin));
      check(`${order}: the second really waited`, r.waited, true);
      check(`${order}: no deadlock, both succeed`, [r.first.code ?? null, r.second.code ?? null], [null, null]);
      check(`${order}: both products end at 0`, [(await liveRow(w.root, x.productId))!.stock_quantity, (await liveRow(w.root, y.productId))!.stock_quantity], [0, 0]);
    }
    {
      const x = await liveProduct(w.root, w.admin, { stock: 2 });
      const y = await liveProduct(w.root, w.admin, { stock: 2 });
      const o1 = await paidOrder(w.root, [{ id: x.productId, quantity: 1 }, { id: y.productId, quantity: 1 }]);
      const o2 = await paidOrder(w.root, [{ id: y.productId, quantity: 1 }, { id: x.productId, quantity: 1 }]);
      const r = await overlap(w, reserve(o1, [{ id: x.productId, quantity: 1 }, { id: y.productId, quantity: 1 }]),
                                 reserve(o2, [{ id: y.productId, quantity: 1 }, { id: x.productId, quantity: 1 }]));
      check("opposite-order multi-product sales: second waited, no deadlock", [r.waited, r.second.code ?? null], [true, null]);
      check("both end at 0", [(await liveRow(w.root, x.productId))!.stock_quantity, (await liveRow(w.root, y.productId))!.stock_quantity], [0, 0]);
    }

    // ══ G. Sizes ══
    console.log("\n=== G. sized-product adjustment concurrent with a sale ===");
    {
      const p = await liveProduct(w.root, w.admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
      const o = await paidOrder(w.root, [{ id: p.productId, size: "M", quantity: 1 }]);
      const r = await overlap(w, saveSizes(w.admin, p.productId, [{ label: "M", expected: 2, stock_quantity: 5 }]),
                                 reserve(o, [{ id: p.productId, size: "M", quantity: 1 }]));
      check("adjust first: sale waited, both succeed", [r.waited, r.first.error ?? null, r.second.error ?? null], [true, null, null]);
      check("adjust first: M = 5 - 1", (await sizesOf(w.root, p.productId)).M, 4);
      check("adjust first: version total follows the sizes", (await liveRow(w.root, p.productId))!.stock_quantity, 4);
    }
    {
      const p = await liveProduct(w.root, w.admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
      const o = await paidOrder(w.root, [{ id: p.productId, size: "M", quantity: 1 }]);
      const r = await overlap(w, reserve(o, [{ id: p.productId, size: "M", quantity: 1 }]),
                                 saveSizes(w.admin, p.productId, [{ label: "M", expected: 2, stock_quantity: 5 }]));
      check("sale first: the edit waited, then was refused as stale", [r.waited, r.second.error], [true, "STOCK_CHANGED:M:1"]);
      check("sale first: M = 1, nothing overwritten", (await sizesOf(w.root, p.productId)).M, 1);
    }
    {
      const p = await liveProduct(w.root, w.admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
      const o = await paidOrder(w.root, [{ id: p.productId, size: "M", quantity: 1 }]);
      const r = await overlap(w, reserve(o, [{ id: p.productId, size: "M", quantity: 1 }]),
                                 saveSizes(w.admin, p.productId, [{ label: "M", expected: 2, stock_quantity: 2 }]));
      check("sale first, untouched form saved: waited, succeeded", [r.waited, r.second.error ?? null], [true, null]);
      check("…and the sold unit stays sold (M = 1)", (await sizesOf(w.root, p.productId)).M, 1);
    }
    {
      const p = await liveProduct(old.root, old.admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
      const o = await paidOrder(old.root, [{ id: p.productId, size: "M", quantity: 1 }]);
      const r = await overlap(old, reserve(o, [{ id: p.productId, size: "M", quantity: 1 }]),
                                   saveSizes(old.admin, p.productId, [{ label: "M", stock_quantity: 2 }], true));
      check("CONTROL before 0060: the form's save waited on the sale", r.waited, true);
      check("CONTROL before 0060: an untouched form restocks the sold size", (await sizesOf(old.root, p.productId)).M, 2);
      const ms = await movements(old.root, p.productId);
      check("CONTROL before 0060: …and logs nothing for it", ms.filter((m) => m.reason === "correction").length, 0);
    }

    // ══ Randomised ══
    console.log("\n=== randomised: 4 connections, sales, cancels, adjustments and publishes at once ===");
    {
      const OPENING = 4;
      const products = [];
      for (let i = 0; i < 4; i++) products.push(await liveProduct(w.root, w.admin, { stock: OPENING }));
      const sized = await liveProduct(w.root, w.admin, { sizes: [{ label: "S", stock_quantity: 3 }, { label: "M", stock_quantity: 3 }] });
      const ids = products.map((p) => p.productId);
      const paid: string[] = [];
      const errors: Record<string, number> = {};
      const bad: string[] = [];
      const workers = await Promise.all([0, 1, 2, 3].map(() => engine.connect("new")));
      for (const c of workers) {
        await c.query("set statement_timeout = '20s'");
        await c.query("set lock_timeout = '15s'");
      }
      const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
      let ops = 0;

      async function step(c: Client) {
        const roll = Math.random();
        try {
          if (roll < 0.35) {
            const chosen = [...new Set([pick(ids), pick(ids)])];
            const items: { id: string; size?: string; quantity: number }[] = chosen.map((id) => ({ id, quantity: 1 }));
            if (Math.random() < 0.3) items.push({ id: sized.productId, size: pick(["S", "M"]), quantity: 1 });
            await asRoot(c);
            const o = (await c.query(
              "insert into orders (items, total_inr, payment_status, status) values ($1::jsonb, 1, 'paid', 'placed') returning id",
              [JSON.stringify(items)])).rows[0].id;
            await reserve(o, items)(c);
            paid.push(o);
          } else if (roll < 0.5 && paid.length > 0) {
            await cancel(w.admin, paid.splice(Math.floor(Math.random() * paid.length), 1)[0])(c);
          } else if (roll < 0.65) {
            const id = pick(ids);
            await asAdmin(c, w.admin);
            const vid = (await c.query("select public.ensure_product_draft($1) id", [id])).rows[0].id;
            await c.query("update product_versions set name = $2 where id = $1", [vid, `R${ops}`]);
          } else if (roll < 0.75) {
            await publishOne(w.admin, pick(ids))(c);
          } else if (roll < 0.82) {
            await publishAll(w.admin)(c);
          } else if (roll < 0.93) {
            const id = pick(ids);
            await asRoot(c);
            const live = (await c.query("select stock_quantity from product_versions where product_id = $1 and state = 'published'", [id])).rows[0].stock_quantity;
            await setStock(w.admin, id, live, live + 1)(c);
          } else {
            await asRoot(c);
            const cur = await sizesOf(c, sized.productId);
            await saveSizes(w.admin, sized.productId, [{ label: "S", expected: cur.S, stock_quantity: cur.S + 1 }, { label: "M", expected: cur.M, stock_quantity: cur.M }])(c);
          }
        } catch (e) {
          const code = (e as { code?: string }).code ?? "";
          const msg = (e as Error).message;
          const kind = code === "40P01" ? "DEADLOCK" : code === "55P03" ? "LOCK_TIMEOUT" : code === "57014" ? "STATEMENT_TIMEOUT"
            : /SOLD_OUT/.test(msg) ? "SOLD_OUT" : /STOCK_CHANGED/.test(msg) ? "STOCK_CHANGED"
            : /Nothing pending/.test(msg) ? "NOTHING_PENDING" : /already cancelled/.test(msg) ? "ALREADY_CANCELLED"
            // Two sessions opening a draft of the same product at the same
            // instant: ensure_product_draft (unchanged since 0051) checks, then
            // inserts, and the one-draft index refuses the second. A refusal
            // that changes nothing — pre-existing, outside 0060, and reported.
            : /product_versions_one_draft/.test(msg) ? "KNOWN_DRAFT_FORK_RACE" : "OTHER";
          errors[kind] = (errors[kind] ?? 0) + 1;
          if (kind === "OTHER" || kind.includes("TIMEOUT") || kind === "DEADLOCK") bad.push(`${kind}: ${msg}`);
        }
        ops++;
      }

      await Promise.all(workers.map(async (c) => { for (let i = 0; i < 60; i++) await step(c); }));
      for (const c of workers) await c.end();

      console.log(`    ${ops} operations; refusals by kind: ${JSON.stringify(errors)}`);
      if (bad.length) console.log(`    unexpected: ${bad.slice(0, 5).join(" | ")}`);
      check("no deadlocks, timeouts or unexpected errors", bad.length, 0);
      for (const p of products) {
        const live = (await liveRow(w.root, p.productId))!.stock_quantity;
        const ms = await movements(w.root, p.productId);
        check(`unsized ${p.slug}: live = opening + movements, and not negative`, [live, live >= 0], [OPENING + sum(ms), true]);
      }
      const sizes = await sizesOf(w.root, sized.productId);
      const sms = await movements(w.root, sized.productId);
      // Its sizes were created through save_product_sizes, which logged them as
      // restocks, so the movements alone account for every unit.
      check("sized: sizes total = movements", sizes.S + sizes.M, sum(sms));
      check("sized: version total = sizes total", (await liveRow(w.root, sized.productId))!.stock_quantity, sizes.S + sizes.M);
      const one = (await w.root.query("select count(*)::int n from product_versions where state = 'published' and product_id = any($1)", [ids])).rows[0].n;
      check("exactly one published version per product", one, ids.length);
    }

    for (const x of [old, w]) for (const c of [x.root, x.a, x.b, x.obs]) await c.end();
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
