/**
 * "Verified purchase" means a paid, delivered order for this piece under the
 * reviewer's own sign-in email, and nothing else.
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/verified-purchase.test.ts
 *
 * The render half proves the badge follows `verified` and nothing else. The
 * database half starts from PRODUCTION'S STATE (the migrations through 0065,
 * as verified on 7 October 2026). It reproduces the defect: an aal2 admin
 * inserts a review for a customer who never bought the piece. Then it applies
 * 0066 unmodified and checks every role through the real policies, grants and
 * functions. Without embedded-postgres the database half is skipped, and the
 * run exits non-zero rather than passing.
 */
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProductReviews from "../components/product/ProductReviews";
import { asAdmin, asRoot, asService, asStaffPasswordOnly, asUser, failure, makeAdmin, startEngine, type Client } from "./pg-world";

// tsx compiles JSX with the classic transform, which expects React in scope.
(globalThis as { React?: typeof React }).React = React;

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

const MIGRATION = fs.readFileSync(path.join("supabase", "migrations", "0066_verified_purchase_reviews.sql"), "utf8");

// ── The page ─────────────────────────────────
console.log("\nthe badge follows the database's verdict and nothing else");
const base = { id: "r1", rating: 5, body: "Beautiful weave, true to the photos.", author: "Asha", created_at: "2026-09-01T00:00:00Z" };
const render = (reviews: unknown[]) =>
  renderToStaticMarkup(createElement(ProductReviews, { productId: "p", reviews: reviews as never, rating: { average: 5, total: reviews.length } }));
const count = (html: string) => (html.match(/Verified purchase/g) ?? []).length;
t("8. verified: true → one Verified purchase label", count(render([{ ...base, verified: true }])) === 1);
t("9. verified: false → no label, review still shown", count(render([{ ...base, verified: false }])) === 0 && render([{ ...base, verified: false }]).includes(base.body));
t("9. verified missing (an older function) → no label", count(render([base])) === 0);
t("9. verified as a truthy non-boolean → no label", count(render([{ ...base, verified: "true" }, { ...base, id: "r2", verified: 1 }])) === 0);
t("8/9. a mixed list labels exactly the verified rows",
  count(render([{ ...base, verified: true }, { ...base, id: "r2", verified: false }, { ...base, id: "r3", verified: true }])) === 2);
const empty = renderToStaticMarkup(createElement(ProductReviews, { productId: "p", reviews: [], rating: { average: null, total: 0 } }));
t("15. the empty state is unchanged", empty.includes("No reviews yet — they appear here once customers have worn their") && count(empty) === 0);
const page = fs.readFileSync("components/product/ProductReviews.tsx", "utf8");
t("no substitute trust wording", !/Trusted buyer|Confirmed customer|Verified buyer/i.test(page));
t("the badge is gated on verified === true", /review\.verified === true &&/.test(page));

(async () => {
  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database half — embedded-postgres not found (set PG_HARNESS_DIR)");
    console.log(`\n${pass} passed, ${fail} failed (DB SKIPPED)\n`);
    process.exit(fail ? 1 : 2);
  }
  try {
    await engine.database("w", "0065");
    const c = await engine.connect("w");

    // ── Fixtures ──
    await asRoot(c);
    const P1 = (await c.query("insert into products (name, slug, price_inr) values ('Kasavu saree', 'kasavu-saree', 1000) returning id")).rows[0].id as string;
    const P2 = (await c.query("insert into products (name, slug, price_inr) values ('Linen dhoti', 'linen-dhoti', 1000) returning id")).rows[0].id as string;
    const P3 = (await c.query("insert into products (name, slug, price_inr) values ('Temple earrings', 'temple-earrings', 1000) returning id")).rows[0].id as string;

    const users: Record<string, string> = {};
    const customer = async (key: string) => {
      await asRoot(c);
      const email = `${key}@example.test`;
      const id = (await c.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id as string;
      await c.query("insert into profiles (id, email, full_name) values ($1, $2, $3) on conflict (id) do update set full_name = $3", [id, email, key]);
      users[key] = id;
      return id;
    };
    const order = async (key: string, products: string[], payment: string, status: string, items?: unknown) => {
      await asRoot(c);
      await c.query(
        "insert into orders (customer_email, total_inr, items, payment_status, status) values ($1, 1000, $2::jsonb, $3, $4)",
        [`${key.toUpperCase()}@Example.test`, JSON.stringify(items ?? products.map((id) => ({ id, name: "x", quantity: 1, price_inr: 1000 }))), payment, status]
      );
    };
    // As PostgREST presents a customer: the id, the aal, and the token's email.
    const as = async (key: string, aal: "aal1" | "aal2" = "aal1") => {
      await asUser(c, users[key], aal);
      await c.query("select set_config('request.jwt.claim.email', $1, false)", [`${key}@example.test`]);
    };
    const asAnon = async () => {
      await asRoot(c);
      await c.query("select set_config('request.jwt.claim.email', '', false)");
      await c.query("set role anon");
      await c.query("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', false)");
    };
    const insert = (product: string, user: string, body = "Lovely drape and very soft cotton.") =>
      c.query("insert into product_reviews (product_id, user_id, rating, body) values ($1, $2, 5, $3) returning id", [product, user, body]);
    const list = async (product: string) => {
      await asAnon();
      return (await c.query("select * from product_reviews_for($1)", [product])).rows as Array<Record<string, unknown>>;
    };
    const verifiedOf = async (product: string, user: string) => {
      await asRoot(c);
      const id = (await c.query("select id from product_reviews where product_id = $1 and user_id = $2", [product, user])).rows[0]?.id;
      const row = (await list(product)).find((r) => r.id === id);
      return row ? row.verified : "absent";
    };

    await customer("buyer");       // paid + delivered P1
    await customer("stranger");    // no orders at all
    await customer("other");       // paid + delivered P2 only
    await customer("cancelled");   // paid P1, cancelled
    await customer("shipped");     // paid P1, not yet delivered
    await customer("unpaid");      // P1 delivered but payment pending
    await customer("malformed");   // an order whose items is not an array
    const admin = await makeAdmin(c, "admin@example.test");
    users.admin = admin;
    await asRoot(c);
    await c.query("update profiles set full_name = 'admin' where id = $1", [admin]);
    await order("buyer", [P1, P3], "paid", "delivered");
    await order("other", [P2], "paid", "delivered");
    await order("cancelled", [P1], "paid", "cancelled");
    await order("shipped", [P1], "paid", "shipped");
    await order("unpaid", [P1], "pending", "delivered");
    await order("malformed", [], "paid", "delivered", { id: P1 });

    // ── Production's state ──
    console.log("\nproduction's state (through 0065): the defect");
    await asAdmin(c, admin);
    const forged = await failure(() => insert(P1, users.stranger, "Forged review with no order behind it."));
    t("defect reproduced: an aal2 admin inserts a review for a customer who never bought it", forged === "", forged);
    await asAdmin(c, admin);
    const rewritten = (await c.query("update product_reviews set body = 'Rewritten by the shop, not the buyer.' where user_id = $1 returning id", [users.stranger])).rowCount;
    t("defect reproduced: …and an admin can rewrite a review's body", rewritten === 1);
    const pre = await list(P1);
    t("defect reproduced: the forged row is public and the function has no verified field", pre.length === 1 && !("verified" in pre[0]));

    // ── 0066 refuses an unexpected schema ──
    console.log("\n0066 refuses an unexpected schema");
    for (const [label, setup, undo] of [
      ["an extra INSERT policy", `create policy "Anyone review" on product_reviews for insert to authenticated with check (true)`, `drop policy "Anyone review" on product_reviews`],
      ["a changed purchase rule", `alter policy "Verified purchasers may review" on product_reviews with check (user_id = auth.uid())`,
        `alter policy "Verified purchasers may review" on product_reviews with check (user_id = auth.uid() and public.has_purchased(product_id))`],
      ["RLS switched off", `alter table product_reviews disable row level security`, `alter table product_reviews enable row level security`],
    ] as const) {
      await asRoot(c);
      await c.query(setup);
      await c.query("begin");
      const msg = await failure(() => c.query(MIGRATION));
      await c.query("rollback");
      t(`refused: ${label}`, msg.includes("MIGRATION_0066_PRECONDITION_FAILED"), msg.slice(0, 140));
      await c.query(undo);
    }

    // ── Apply ──
    console.log("\napply 0066");
    await asRoot(c);
    const snapshot = async () => {
      await asRoot(c);
      return JSON.stringify((await c.query(
        "select (select json_agg(o order by o.id) from orders o) o, (select json_agg(r order by r.id) from product_reviews r) r, (select json_agg(p order by p.id) from profiles p) p"
      )).rows[0]);
    };
    const otherPolicies = async () => {
      await asRoot(c);
      return (await c.query("select tablename||policyname||cmd||coalesce(qual,'')||coalesce(with_check,'') p from pg_policies where tablename <> 'product_reviews' order by 1")).rows.map((r) => r.p).join("\n");
    };
    const dataBefore = await snapshot();
    const othersBefore = await otherPolicies();
    await c.query("begin");
    const applied = await failure(() => c.query(MIGRATION));
    await c.query(applied ? "rollback" : "commit");
    t("0066 applies cleanly to production's state", applied === "", applied);
    t("no row anywhere changed (orders, reviews, profiles)", (await snapshot()) === dataBefore);
    t("no policy on any other table changed", (await otherPolicies()) === othersBefore);
    const policies = (await c.query("select policyname||'|'||cmd p from pg_policies where tablename = 'product_reviews' order by 1")).rows.map((r) => r.p);
    t("11. product_reviews policies are exactly the intended six", JSON.stringify(policies) === JSON.stringify([
      "Admins delete reviews|DELETE", "Admins read every review|SELECT", "Customers delete their own review|DELETE",
      "Customers edit their own review|UPDATE", "Verified purchasers may review|INSERT", "Visible reviews are public|SELECT",
    ]), policies.join(", "));
    await c.query("begin");
    const again = await failure(() => c.query(MIGRATION));
    await c.query(again ? "rollback" : "commit");
    t("re-running 0066 is accepted and leaves the same six", again === "" &&
      (await c.query("select count(*)::int n from pg_policies where tablename = 'product_reviews'")).rows[0].n === 6, again);

    // ── Historical rows ──
    console.log("\nhistorical rows are judged by evidence, not by who wrote them");
    t("4/13. the row the admin forged before 0066 is now unverified", (await verifiedOf(P1, users.stranger)) === false);
    const first = JSON.stringify(await list(P1));
    t("13. the derivation is deterministic (same answer twice)", JSON.stringify(await list(P1)) === first);
    await asRoot(c);
    await c.query("delete from product_reviews");

    // ── 14. zero reviews ──
    console.log("\nzero reviews");
    t("14. no reviews → an empty list, not an error", (await list(P1)).length === 0);
    await asAnon();
    const rating = (await c.query("select * from product_rating($1)", [P1])).rows[0];
    t("14. no reviews → rating total 0, average null", Number(rating.total) === 0 && rating.average === null);

    // ── Customers ──
    console.log("\ncustomers");
    await as("buyer");
    t("1. a customer with a paid, delivered order reviews it", (await failure(() => insert(P1, users.buyer))) === "");
    t("1. …and the review is verified", (await verifiedOf(P1, users.buyer)) === true);
    for (const key of ["stranger", "cancelled", "shipped", "unpaid", "malformed"]) {
      await as(key);
      const msg = await failure(() => insert(P1, users[key]));
      // has_purchased() raises on a non-array items value instead of answering
      // false (0036, unchanged here). Either way the insert is refused.
      t(`2. "${key}" cannot review the piece`, key === "malformed" ? msg !== "" : msg.includes("row-level security"), msg.slice(0, 80));
    }
    await as("other");
    const crossMsg = await failure(() => insert(P1, users.other));
    t("3. a customer who bought a different piece cannot review this one", crossMsg.includes("row-level security"), crossMsg.slice(0, 80));
    await as("other");
    t("3. …but reviews the piece they did buy, verified", (await failure(() => insert(P2, users.other))) === "" && (await verifiedOf(P2, users.other)) === true);
    await as("stranger");
    const impersonate = await failure(() => insert(P1, users.buyer, "Writing as somebody else entirely."));
    t("a customer cannot write under another customer's id", impersonate.includes("row-level security"), impersonate.slice(0, 80));
    await as("buyer");
    t("7. the author edits their own review", (await c.query("update product_reviews set body = 'Edited after a month of wearing it.', updated_at = now() where user_id = $1 returning id", [users.buyer])).rowCount === 1);
    t("7. …and it stays verified", (await verifiedOf(P1, users.buyer)) === true);
    await as("stranger");
    t("a customer cannot edit someone else's review", (await c.query("update product_reviews set body = 'Hijacked review body text.' where user_id = $1 returning id", [users.buyer])).rowCount === 0);
    await as("buyer");
    const move = await failure(() => c.query("update product_reviews set product_id = $2 where user_id = $1", [users.buyer, P2]));
    t("the author cannot move a review onto another product", move.includes("permission denied"), move.slice(0, 80));

    // ── The evidence, not the profile ──
    console.log("\nthe evidence is the sign-in email and the order, nothing a customer can edit");
    await as("stranger");
    await c.query("update profiles set email = 'buyer@example.test' where id = $1", [users.stranger]);
    await asService(c);
    await insert(P3, users.stranger, "Inserted by a trusted path for this test.");
    t("10. editing profiles.email to a buyer's address earns no badge", (await verifiedOf(P3, users.stranger)) === false);
    await asRoot(c);
    await c.query("update profiles set email = 'stranger@example.test' where id = $1", [users.stranger]);
    await c.query("delete from product_reviews where user_id = $1", [users.stranger]);
    await asRoot(c);
    // The real path is cancel_order(), which also issues a credit note. Only
    // the order's status matters here, so the guard trigger is set aside for
    // this one statement in this throwaway database.
    await c.query("set session_replication_role = replica");
    await c.query("update orders set status = 'cancelled' where lower(customer_email) = 'buyer@example.test'");
    await c.query("set session_replication_role = default");
    t("an order that stops qualifying takes the badge with it", (await verifiedOf(P1, users.buyer)) === false);
    await asRoot(c);
    await c.query("set session_replication_role = replica");
    await c.query("update orders set status = 'delivered' where lower(customer_email) = 'buyer@example.test'");
    await c.query("set session_replication_role = default");
    t("…and restoring it restores the badge", (await verifiedOf(P1, users.buyer)) === true);
    await asService(c);
    await insert(P1, users.malformed, "Malformed order history should not break the list.");
    const malformedList = await failure(() => list(P1));
    t("a malformed order (items not an array) does not break the list", malformedList === "", malformedList);
    t("…and earns no badge", (await verifiedOf(P1, users.malformed)) === false);

    // Parity with has_purchased(): the badge and the insert rule agree for everyone.
    const disagreements: string[] = [];
    for (const key of ["buyer", "stranger", "other", "cancelled", "shipped", "unpaid", "malformed"]) {
      for (const product of [P1, P2, P3]) {
        await as(key);
        // A raise from has_purchased() (the malformed order) refuses the insert, so it counts as false.
        const may = await c.query("select public.has_purchased($1) v", [product]).then((x) => x.rows[0].v as boolean, () => false);
        await asService(c);
        await c.query("insert into product_reviews (product_id, user_id, rating, body) values ($1, $2, 4, 'Parity check row for the test.') on conflict do nothing", [product, users[key]]);
        const shown = await verifiedOf(product, users[key]);
        if (shown !== may) disagreements.push(`${key}/${product === P1 ? "P1" : product === P2 ? "P2" : "P3"}: has_purchased=${may} verified=${shown}`);
      }
    }
    t("the badge agrees with has_purchased() for every customer × product", disagreements.length === 0, disagreements.join("; "));
    await asRoot(c);
    await c.query("delete from product_reviews where body = 'Parity check row for the test.' or user_id = $1", [users.malformed]);

    // ── Admins ──
    console.log("\nadmins moderate; they do not author");
    await asAdmin(c, admin);
    const adminForge = await failure(() => insert(P1, users.stranger, "Forged review with no order behind it."));
    t("4. an aal2 admin cannot insert a review for a customer without a purchase", adminForge.includes("row-level security"), adminForge.slice(0, 80));
    await asAdmin(c, admin);
    await c.query("select set_config('request.jwt.claim.email', 'admin@example.test', false)");
    const adminOwn = await failure(() => insert(P1, admin, "The shop reviewing its own piece."));
    t("4. …nor one under their own id without a purchase", adminOwn.includes("row-level security"), adminOwn.slice(0, 80));
    await asAdmin(c, admin);
    const setVerified = await failure(() => c.query("update product_reviews set verified = true"));
    t("5. there is no verified column for anyone to set", setVerified.includes('column "verified"'), setVerified.slice(0, 80));
    await asAdmin(c, admin);
    t("5. an admin cannot rewrite a customer's review", (await c.query("update product_reviews set body = 'Rewritten by the shop, not the buyer.', rating = 1 where user_id = $1 returning id", [users.buyer])).rowCount === 0);
    await asAdmin(c, admin);
    const reassign = await failure(() => c.query("update product_reviews set user_id = $1", [users.stranger]));
    t("5. an admin cannot reassign a review to another customer or product", reassign.includes("permission denied"), reassign.slice(0, 80));
    await asAdmin(c, admin);
    t("5. a server-side function cannot be asked to verify (none takes a verdict)",
      (await c.query("select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and pg_get_function_arguments(oid) ilike '%verified%'")).rows[0].n === 0);

    await asAdmin(c, admin);
    const adminList = (await c.query("select public.admin_reviews(true) j")).rows[0].j as unknown[];
    t("6. an admin reads the moderation list", adminList.length === 2);
    const buyerReview = (await (async () => { await asRoot(c); return c.query("select id from product_reviews where user_id = $1", [users.buyer]); })()).rows[0].id;
    await asAdmin(c, admin);
    t("6. an admin hides a review", (await c.query("select public.set_review_hidden($1, true) ok", [buyerReview])).rows[0].ok === true);
    t("6. …it leaves the public list", !(await list(P1)).some((r) => r.id === buyerReview));
    await asAdmin(c, admin);
    t("6. an admin unhides it", (await c.query("select public.set_review_hidden($1, false) ok", [buyerReview])).rows[0].ok === true);
    t("6. …and it is back, still verified", (await verifiedOf(P1, users.buyer)) === true);
    await asStaffPasswordOnly(c, admin);
    const aal1Hide = await failure(() => c.query("select public.set_review_hidden($1, true)", [buyerReview]));
    t("12. staff with only a password (aal1) cannot hide", aal1Hide.includes("Only admins"), aal1Hide.slice(0, 80));
    await asStaffPasswordOnly(c, admin);
    t("12. …nor delete", (await c.query("delete from product_reviews where id = $1 returning id", [buyerReview])).rowCount === 0);
    await asStaffPasswordOnly(c, admin);
    const aal1List = await failure(() => c.query("select public.admin_reviews(true)"));
    t("12. …nor read the moderation list", aal1List.includes("Only admins"), aal1List.slice(0, 80));
    await asAdmin(c, admin);
    const otherReview = (await c.query("select id from product_reviews where user_id = $1", [users.other])).rows[0].id;
    t("6. an aal2 admin deletes a review", (await c.query("delete from product_reviews where id = $1 returning id", [otherReview])).rowCount === 1);

    // ── Anonymous visitors and order privacy ──
    console.log("\nanonymous visitors and order privacy");
    const anonRows = await list(P1);
    t("10. anon reads the public list with the badge", anonRows.length === 1 && anonRows[0].verified === true);
    t("10. the list carries no order or contact data", JSON.stringify(Object.keys(anonRows[0]).sort()) ===
      JSON.stringify(["author", "body", "created_at", "id", "rating", "verified"]));
    await asAnon();
    const anonOrders = await failure(() => c.query("select count(*) from orders"));
    t("10. anon still cannot read orders", anonOrders.includes("permission denied"), anonOrders.slice(0, 80));
    await asAnon();
    const anonUsers = await failure(() => c.query("select count(*) from auth.users"));
    t("10. anon cannot read auth.users", anonUsers.includes("permission denied"), anonUsers.slice(0, 80));
    await asAnon();
    const anonProbe = await failure(() => c.query("select public.has_purchased($1)", [P1]));
    t("10. anon cannot call has_purchased()", anonProbe.includes("permission denied"), anonProbe.slice(0, 80));
    await as("stranger");
    t("10. a customer sees none of another customer's orders", Number((await c.query("select count(*) n from orders")).rows[0].n) === 0);
    await asAnon();
    const anonWrite = await failure(() => insert(P1, users.buyer));
    t("11. anon cannot write a review", anonWrite.includes("permission denied"), anonWrite.slice(0, 80));

    await c.end();

    // ── Clean replay ──
    console.log("\nclean replay 0001–0066");
    await engine.database("replay");
    const r = await engine.connect("replay");
    const fn = (await r.query("select prosecdef, proconfig, pg_get_function_result(oid) res from pg_proc where oid = 'public.product_reviews_for(uuid)'::regprocedure")).rows[0];
    t("replayed: product_reviews_for returns verified, SECURITY DEFINER, pinned search_path",
      fn.prosecdef === true && String(fn.proconfig).includes("search_path=public") && /verified boolean/.test(fn.res), fn.res);
    t("replayed: anon may execute it, PUBLIC may not",
      (await r.query("select has_function_privilege('anon', 'public.product_reviews_for(uuid)', 'execute') a")).rows[0].a === true &&
      !(await r.query("select proacl::text a from pg_proc where oid = 'public.product_reviews_for(uuid)'::regprocedure")).rows[0].a.match(/(^|[{,])=X\//));
    t("replayed: no admin INSERT/UPDATE policy on product_reviews",
      (await r.query("select count(*)::int n from pg_policies where tablename = 'product_reviews' and cmd in ('INSERT','UPDATE','ALL') and coalesce(with_check, qual) like '%is_admin%'")).rows[0].n === 0);
    await r.end();
  } finally {
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
