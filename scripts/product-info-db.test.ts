/**
 * 0065 — product information: facts and alt text draft and publish like every
 * other field, a draft may be incomplete, and publishing refuses a product
 * whose type-required facts are missing, naming exactly which.
 *
 * On a real PostgreSQL server with every migration applied unmodified
 * (scripts/pg-world.ts), through the real functions, as the real roles. It also
 * builds a database through 0064, puts incomplete products live, and applies
 * 0065 on top — the production path — to prove nothing already live moves.
 *
 * And it holds lib/productInfo.ts (what the admin form shows) to agreement with
 * product_info_missing (what the database enforces) across every product type.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> \
 *     npx tsx scripts/product-info-db.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import fs from "node:fs";
import { asAdmin, asRoot, asService, asUser, failure, failureCode, makeAdmin, startEngine, type Client } from "./pg-world";
import { publishBlockers, publishBlockedMessage, type InfoInput, type ProductProfile } from "../lib/productInfo";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

let n = 0;

/** A published category tree: one parent, one child. Returns the child's id. */
async function category(
  c: Client,
  admin: string,
  opts: { parentProfile?: ProductProfile | null; childProfile?: ProductProfile | null } = {}
): Promise<{ parent: string; child: string }> {
  n += 1;
  await asAdmin(c, admin);
  const parentV = (await c.query("select public.create_category_draft($1, $2, null, 0) id", [`Parent ${n}`, `parent-${n}`])).rows[0].id;
  const parent = (await c.query("update category_versions set product_profile = $2 where id = $1 returning category_id", [parentV, opts.parentProfile ?? null])).rows[0].category_id;
  await c.query("select public.publish_one('category', $1)", [parent]);
  const childV = (await c.query("select public.create_category_draft($1, $2, $3, 0) id", [`Child ${n}`, `child-${n}`, parent])).rows[0].id;
  const child = (await c.query("update category_versions set product_profile = $2 where id = $1 returning category_id", [childV, opts.childProfile ?? null])).rows[0].category_id;
  await c.query("select public.publish_one('category', $1)", [child]);
  await asRoot(c);
  return { parent, child };
}

type Facts = Partial<{
  fabric: string | null; colour: string | null; care_note: string | null; is_active: boolean;
  origin: string | null; weave: string | null; dimensions: string | null; blouse_piece: string | null;
  seo_title: string | null; meta_description: string | null; finish: string | null; fit_note: string | null;
}>;

/** A new product's draft, as the admin form writes it. Not published. */
async function draftProduct(
  c: Client,
  admin: string,
  categoryId: string | null,
  facts: Facts,
  photos: { alt: string | null }[] = [{ alt: "Draped on a model" }]
): Promise<{ productId: string; versionId: string; name: string }> {
  n += 1;
  const name = `Piece ${n}`;
  await asAdmin(c, admin);
  const vid = (await c.query("select public.create_product_draft() id")).rows[0].id as string;
  const cols = Object.keys(facts);
  const sets = cols.map((k, i) => `${k} = $${i + 5}`).join(", ");
  const { rows } = await c.query(
    `update product_versions set name = $2, slug = $3, price_inr = 2500, category_id = $4, stock_quantity = 1
       ${cols.length ? `, ${sets}` : ""}
     where id = $1 and state = 'draft' returning product_id`,
    [vid, name, `piece-${process.pid}-${n}`, categoryId, ...cols.map((k) => (facts as Record<string, unknown>)[k])]
  );
  const productId = rows[0].product_id as string;
  for (const [i, p] of photos.entries()) {
    await c.query(
      "insert into product_images (product_version_id, product_id, url, sort_order, alt_text) values ($1, $2, $3, $4, $5)",
      [vid, productId, `https://example.test/${n}-${i}.jpg`, i, p.alt]
    );
  }
  await asRoot(c);
  return { productId, versionId: vid, name };
}

const COMPLETE: Facts = { fabric: "Handloom cotton", colour: "Off-white", care_note: "Dry clean only." };

async function publish(c: Client, admin: string, productId: string) {
  await asAdmin(c, admin);
  try {
    await c.query("select public.publish_one('product', $1)", [productId]);
  } finally {
    await asRoot(c);
  }
}

async function stateOf(c: Client, productId: string): Promise<string[]> {
  await asRoot(c);
  return (await c.query("select state from product_versions where product_id = $1 order by state", [productId])).rows.map((r) => r.state);
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    return;
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);

  try {
    // ══ Production path: 0065 applied over a live, incomplete catalogue ══
    console.log("\n=== 0065 over a live catalogue (built through 0064) ===");
    await engine.database("before0065", "0064");
    {
      const c = await engine.connect("before0065");
      const admin = await makeAdmin(c);
      // The seeded tree (0001's categories, versioned by 0011): Women › Sarees.
      const sarees = (await c.query(
        "select category_id from category_versions where slug = 'sarees' and state = 'published'")).rows[0].category_id;
      await asAdmin(c, admin);
      // Live, with no care, no colour, no alt text — like most of production.
      const vid = (await c.query("select public.create_product_draft() id")).rows[0].id;
      const pid = (await c.query(
        "update product_versions set name = 'Old Saree', slug = 'old-saree', price_inr = 1000, category_id = $2, fabric = 'Cotton' where id = $1 returning product_id",
        [vid, sarees])).rows[0].product_id;
      await asRoot(c);
      await c.query("insert into product_images (product_version_id, product_id, url, sort_order) values ($1, $2, 'https://example.test/old.jpg', 0)", [vid, pid]);
      await publish(c, admin, pid);
      const liveCount = (await c.query("select count(*)::text n from product_versions where state = 'published'")).rows[0].n;
      const before = (await c.query("select md5(to_jsonb(v)::text) h from product_versions v where product_id = $1 and state = 'published'", [pid])).rows[0].h;

      await asRoot(c);
      const verify = (await c.query(fs.readFileSync("supabase/migrations/0065_product_information.sql", "utf8")) as unknown as { rows: Record<string, unknown>[] }[]);
      const report = verify[verify.length - 1].rows[0];
      check("0065 applies over a live catalogue; verify reports every live product, 0 new facts, 0 alts",
        [report.published_products, report.versions_with_new_facts, report.images_with_alt], [liveCount, "0", "0"]);
      const profiles = String(report.category_profiles).split(", ");
      check("0065 backfills category types from the slugs it names",
        ["sarees=saree", "women=garment", "men=garment"].filter((p) => profiles.includes(p)), ["sarees=saree", "women=garment", "men=garment"]);
      check("…and only those: every typed category is one of the seven named slugs",
        profiles.every((p) => /^(jewellery|men|women|sarees|dhotis|accessories|home)=/.test(p)), true);
      check("verify counts the live products that would now need facts to publish an edit (all of them: none has care or alt text)",
        report.live_products_missing_required_facts, liveCount);
      const after = (await c.query(
        "select md5((to_jsonb(v) - 'dimensions' - 'blouse_piece' - 'fit_note' - 'finish' - 'weave' - 'origin' - 'seo_title' - 'meta_description')::text) h from product_versions v where product_id = $1 and state = 'published'", [pid])).rows[0].h;
      check("the live product's existing fields are untouched by 0065", after, before);
      check("it is still the only, published version", await stateOf(c, pid), ["published"]);

      // Hiding it is allowed without writing anything up.
      await asAdmin(c, admin);
      const hv = (await c.query("select public.ensure_product_draft($1) id", [pid])).rows[0].id;
      await c.query("update product_versions set is_active = false where id = $1", [hv]);
      check("hiding an incomplete live product publishes", await failure(() => publish(c, admin, pid)), "");
      // Showing it again is an edit that asks for the facts.
      await asAdmin(c, admin);
      const sv = (await c.query("select public.ensure_product_draft($1) id", [pid])).rows[0].id;
      await c.query("update product_versions set is_active = true where id = $1", [sv]);
      check("un-hiding it asks for exactly what is missing",
        await failure(() => publish(c, admin, pid)),
        publishBlockedMessage("Old Saree", ["Colour", "Care instructions", "Main image alt text"]));
      await c.end();
    }

    // ══ Fresh database, all migrations ══
    await engine.database("info");
    const c = await engine.connect("info");
    const admin = await makeAdmin(c);
    const saree = await category(c, admin, { parentProfile: "garment", childProfile: "saree" });
    const shirt = await category(c, admin, { parentProfile: "garment", childProfile: null });
    const jewel = await category(c, admin, { parentProfile: "jewellery", childProfile: null });
    const general = await category(c, admin, { parentProfile: null, childProfile: null });
    const drape = await category(c, admin, { parentProfile: "garment", childProfile: "drape" });

    console.log("\n=== 1. a draft may be incomplete ===");
    const bare = await draftProduct(c, admin, saree.child, {}, [{ alt: null }]);
    check("an incomplete draft saved (no fabric, colour, care, alt)", (await stateOf(c, bare.productId)), ["draft"]);
    await asAdmin(c, admin);
    check("…and keeps saving edits", await failure(() => c.query("update product_versions set description = 'More words.' where id = $1", [bare.versionId])), "");
    await asRoot(c);

    console.log("\n=== 2–3. publish is refused, with the exact fields ===");
    check("publish_one names every missing required field, in form order",
      await failure(() => publish(c, admin, bare.productId)),
      publishBlockedMessage(bare.name, ["Fabric", "Colour", "Care instructions", "Main image alt text"]));
    check("…and nothing went live", await stateOf(c, bare.productId), ["draft"]);
    await asAdmin(c, admin);
    const code = await failureCode(() => c.query("select public.publish_one('product', $1)", [bare.productId]));
    await asRoot(c);
    check("raised as P0001, so the admin sees the sentence as written", code, "P0001");

    await asAdmin(c, admin);
    const validated = (await c.query("select public.validate_publish() v")).rows[0].v as string;
    check("validate_publish explains before publish_all touches anything", validated.startsWith(publishBlockedMessage(bare.name, ["Fabric", "Colour", "Care instructions", "Main image alt text"])), true);
    check("publish_all refuses with the same sentence", (await failure(() => c.query("select public.publish_all()"))).startsWith(`Complete these before publishing “${bare.name}”`), true);
    await asRoot(c);
    check("publish_all promoted nothing", await stateOf(c, bare.productId), ["draft"]);

    // Fill it in, field by field, and watch the list shrink.
    await asAdmin(c, admin);
    await c.query("update product_versions set fabric = 'Cotton', colour = 'Red' where id = $1", [bare.versionId]);
    check("after fabric and colour, only care and alt remain",
      await failure(() => publish(c, admin, bare.productId)),
      publishBlockedMessage(bare.name, ["Care instructions", "Main image alt text"]));
    await asAdmin(c, admin);
    await c.query("update product_versions set care_note = 'Hand wash cold.' where id = $1", [bare.versionId]);
    await c.query("update product_images set alt_text = 'Red cotton saree, folded' where product_version_id = $1", [bare.versionId]);
    check("complete: it publishes", await failure(() => publish(c, admin, bare.productId)), "");
    check("…and is live", await stateOf(c, bare.productId), ["published"]);
    await asAdmin(c, admin);
    check("validate_publish is quiet when nothing is incomplete", (await c.query("select public.validate_publish() v")).rows[0].v, null);
    await asRoot(c);

    console.log("\n=== 4. category-specific requirements ===");
    const j = await draftProduct(c, admin, jewel.child, { care_note: "Keep dry." });
    check("jewellery (inherited from its parent) asks for Material, not Fabric or Colour",
      await failure(() => publish(c, admin, j.productId)), publishBlockedMessage(j.name, ["Material"]));
    const s = await draftProduct(c, admin, shirt.child, { care_note: "Machine wash." });
    check("a shirt (inherits garment) needs fabric and colour",
      await failure(() => publish(c, admin, s.productId)), publishBlockedMessage(s.name, ["Fabric", "Colour"]));
    const g = await draftProduct(c, admin, general.child, {}, []);
    check("general, no photos: only care (photos are 0042's question)",
      (await failure(() => publish(c, admin, g.productId))).startsWith("PRODUCT_HAS_NO_IMAGES"), true);
    await asAdmin(c, admin);
    await c.query("update product_versions set allow_no_images = true where id = $1", [g.versionId]);
    check("general with the no-photo override: care is the one requirement",
      await failure(() => publish(c, admin, g.productId)), publishBlockedMessage(g.name, ["Care instructions"]));
    const d = await draftProduct(c, admin, drape.child, { fabric: "Cotton", care_note: "Hand wash." });
    check("a dhoti (drape) needs colour too", await failure(() => publish(c, admin, d.productId)), publishBlockedMessage(d.name, ["Colour"]));

    // The admin's view: a pending category draft decides, as it does in the form.
    await asAdmin(c, admin);
    const sd = (await c.query("select public.ensure_category_draft($1) id", [shirt.child])).rows[0].id;
    check("ensure_category_draft carries product_profile (null = inherit)",
      (await c.query("select product_profile from category_versions where id = $1", [sd])).rows[0].product_profile, null);
    await c.query("update category_versions set product_profile = 'jewellery' where id = $1", [sd]);
    check("a pending category type change is what publishing judges by",
      await failure(() => publish(c, admin, s.productId)), publishBlockedMessage(s.name, ["Material"]));
    await asAdmin(c, admin);
    await c.query("select public.discard_one('category', $1, null)", [shirt.child]);
    const pd = (await c.query("select public.ensure_category_draft($1) id", [saree.child])).rows[0].id;
    check("a saree category's own type is carried into its draft",
      (await c.query("select product_profile from category_versions where id = $1", [pd])).rows[0].product_profile, "saree");
    await c.query("select public.discard_one('category', $1, null)", [saree.child]);
    await asRoot(c);

    console.log("\n=== 5. optional, unknown facts are allowed ===");
    const known = await draftProduct(c, admin, saree.child, { ...COMPLETE, origin: null, weave: null, dimensions: null, blouse_piece: null });
    check("origin, weave, dimensions and blouse piece unknown: publishes", await failure(() => publish(c, admin, known.productId)), "");

    console.log("\n=== 6–7. SEO values and facts are versioned like every field ===");
    await asAdmin(c, admin);
    const kd = (await c.query("select public.ensure_product_draft($1) id", [known.productId])).rows[0].id;
    await c.query(
      `update product_versions set seo_title = 'Off-white handloom saree', meta_description = 'An off-white handloom cotton saree.',
         origin = 'Chendamangalam, Kerala', weave = 'Handloom', dimensions = '5.5 m × 1.15 m', blouse_piece = 'included'
       where id = $1`, [kd]);
    await asRoot(c);
    const liveBefore = (await c.query("select seo_title, origin from product_versions where product_id = $1 and state = 'published'", [known.productId])).rows[0];
    check("the live version is unchanged while the draft holds new facts", [liveBefore.seo_title, liveBefore.origin], [null, null]);
    check("anon cannot read the draft's facts", await (async () => {
      await c.query("set role anon");
      const r = (await c.query("select count(*)::int n from product_versions where product_id = $1 and seo_title is not null", [known.productId])).rows[0].n;
      await asRoot(c);
      return r;
    })(), 0);
    await publish(c, admin, known.productId);
    const live = (await c.query("select seo_title, meta_description, origin, weave, dimensions, blouse_piece from product_versions where product_id = $1 and state = 'published'", [known.productId])).rows[0];
    check("publishing carries every new fact live",
      Object.values(live), ["Off-white handloom saree", "An off-white handloom cotton saree.", "Chendamangalam, Kerala", "Handloom", "5.5 m × 1.15 m", "included"]);
    await asAdmin(c, admin);
    const fork = (await c.query("select public.ensure_product_draft($1) id", [known.productId])).rows[0].id;
    const forked = (await c.query("select seo_title, meta_description, origin, weave, dimensions, blouse_piece from product_versions where id = $1", [fork])).rows[0];
    check("the next draft forks with every fact (the carry-through)", Object.values(forked), Object.values(live));
    check("an untouched fork is a no-op and settles away", (await c.query("select public.settle_draft('product', $1) s", [fork])).rows[0].s, true);
    await asRoot(c);

    console.log("\n=== 8. alt text persists, drafts and publishes ===");
    await asAdmin(c, admin);
    const af = (await c.query("select public.ensure_product_draft($1) id", [known.productId])).rows[0].id;
    const forkedAlt = (await c.query("select alt_text from product_images where product_version_id = $1 order by sort_order", [af])).rows.map((r) => r.alt_text);
    check("the draft's gallery carries the live alt text", forkedAlt, ["Draped on a model"]);
    await c.query("update product_images set alt_text = 'Off-white saree with a red border, draped' where product_version_id = $1", [af]);
    check("an alt-text-only edit is NOT a no-op (settle keeps the draft)", (await c.query("select public.settle_draft('product', $1) s", [af])).rows[0].s, false);
    const queued = (await c.query("select count(*)::int n from jsonb_array_elements(public.pending_queue()) q where q->>'entity_id' = $1", [known.productId])).rows[0].n;
    check("…and it is in the publish queue", queued, 1);
    await asRoot(c);
    const liveAlt = (await c.query("select i.alt_text from product_images i join product_versions v on v.id = i.product_version_id where v.product_id = $1 and v.state = 'published'", [known.productId])).rows[0].alt_text;
    check("the live photo keeps its old alt until publish", liveAlt, "Draped on a model");
    await publish(c, admin, known.productId);
    const newAlt = (await c.query("select i.alt_text from product_images i join product_versions v on v.id = i.product_version_id where v.product_id = $1 and v.state = 'published'", [known.productId])).rows[0].alt_text;
    check("after publish the live photo says the new thing", newAlt, "Off-white saree with a red border, draped");

    console.log("\n=== 9. deletions and hidden products are not judged ===");
    const gone = await draftProduct(c, admin, saree.child, COMPLETE);
    await publish(c, admin, gone.productId);
    await asAdmin(c, admin);
    const gd = (await c.query("select public.ensure_product_draft($1) id", [gone.productId])).rows[0].id;
    await c.query("update product_versions set care_note = null where id = $1", [gd]);
    await c.query("update product_versions set pending_delete = true where id = $1", [gd]);
    check("a pending deletion publishes without its facts", await failure(() => publish(c, admin, gone.productId)), "");
    check("…and the product is gone", (await c.query("select count(*)::int n from products where id = $1", [gone.productId])).rows[0].n, 0);
    const hidden = await draftProduct(c, admin, saree.child, { is_active: false }, [{ alt: null }]);
    check("a new product published hidden needs nothing written", await failure(() => publish(c, admin, hidden.productId)), "");

    console.log("\n=== 10. constraints: blank is not a value ===");
    await asAdmin(c, admin);
    const cd = (await c.query("select public.create_product_draft() id")).rows[0].id;
    for (const [col, val] of [["seo_title", "   "], ["meta_description", ""], ["origin", " "], ["blouse_piece", "maybe"],
                              ["seo_title", "x".repeat(71)], ["meta_description", "x".repeat(161)]] as const) {
      check(`${col} = ${JSON.stringify(val.length > 10 ? `${val.length} chars` : val)} is refused (23514)`,
        await failureCode(() => c.query(`update product_versions set ${col} = $2 where id = $1`, [cd, val])), "23514");
    }
    const iv = (await c.query("select public.create_product_draft() id")).rows[0].id;
    const ipid = (await c.query("select product_id from product_versions where id = $1", [iv])).rows[0].product_id;
    check("a blank alt text is refused (23514)",
      await failureCode(() => c.query("insert into product_images (product_version_id, product_id, url, sort_order, alt_text) values ($1, $2, 'u', 0, '  ')", [iv, ipid])), "23514");
    check("an unknown product type on a category is refused (23514)",
      await failureCode(() => c.query("update category_versions set product_profile = 'shoes' where category_id = $1 and state = 'published'", [saree.child])), "23514");
    await asRoot(c);

    console.log("\n=== 12. permissions ===");
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["public.category_product_profile(uuid)", "public.product_info_missing(public.product_versions)",
                        "public.product_info_message(text, text[])", "public.require_product_info_to_publish()"]) {
        const can = (await c.query("select has_function_privilege($1, $2, 'EXECUTE') v", [role, fn])).rows[0].v;
        check(`${role} cannot execute ${fn.replace("public.", "").split("(")[0]}`, can, false);
      }
    }
    const shopper = (await c.query("insert into auth.users (email) values ('shopper@example.test') returning id")).rows[0].id;
    await asUser(c, shopper, "aal2");
    check("a signed-in customer cannot write facts onto a version (RLS: 0 rows)",
      (await c.query("update product_versions set origin = 'Nowhere' where product_id = $1 returning id", [known.productId])).rowCount, 0);
    check("…or alt text onto a photo",
      (await c.query("update product_images set alt_text = 'x' where product_id = $1 returning id", [known.productId])).rowCount, 0);
    check("…or a type onto a category",
      (await c.query("update category_versions set product_profile = 'general' where category_id = $1 returning id", [saree.child])).rowCount, 0);
    await asService(c);
    check("service_role can still read the facts", (await c.query("select count(*)::int n from product_versions where origin is not null")).rows[0].n > 0, true);
    await asRoot(c);

    console.log("\n=== 13. the admin form and the database agree ===");
    const profiles: [ProductProfile, string | null][] = [
      ["saree", saree.child], ["drape", drape.child], ["garment", shirt.child], ["jewellery", jewel.child], ["general", general.child], ["general", null],
    ];
    const combos: Facts[] = [];
    for (const fabric of [null, "Cotton"]) for (const colour of [null, "Red"]) for (const care_note of [null, "Dry clean."]) combos.push({ fabric, colour, care_note });
    let agreed = 0;
    let disagreed = 0;
    for (const [profile, cat] of profiles) {
      for (const facts of combos) {
        for (const alt of [null, "A photo"]) {
          for (const active of [true, false]) {
            const p = await draftProduct(c, admin, cat, { ...facts, is_active: active }, [{ alt }]);
            const db = (await c.query("select public.product_info_missing(v) m from product_versions v where id = $1", [p.versionId])).rows[0].m as string[];
            const input: InfoInput = {
              profile, name: p.name, slug: "s", price: "2500", hasCategory: !!cat, description: "",
              fabric: facts.fabric ?? "", colour: facts.colour ?? "", care: facts.care_note ?? "",
              dimensions: "", blouse_piece: "", finish: "", weave: "", origin: "", heritage: "", craft: "", fit: "",
              images: [{ url: "u", alt: alt ?? "" }], seo_title: "", meta_description: "", isActive: active,
            };
            const ts = publishBlockers(input);
            if (JSON.stringify(ts) === JSON.stringify(db)) agreed++;
            else {
              disagreed++;
              console.log(`    disagree: ${profile} ${JSON.stringify(facts)} alt=${alt} active=${active}: ts=${JSON.stringify(ts)} db=${JSON.stringify(db)}`);
            }
          }
        }
      }
    }
    check(`lib/productInfo publishBlockers == product_info_missing on all ${agreed + disagreed} cases`, disagreed, 0);

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
