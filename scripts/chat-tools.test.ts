/**
 * The concierge's tools, exercised without a concierge.
 *
 *   npx tsx scripts/chat-tools.test.ts
 *
 * Two halves, and the second is the point:
 *
 * 1. THE DEFINITIONS, checked as data. Names, strict schemas, and the one
 *    property that is easy to lose in an edit — a description that says WHEN to
 *    call the tool, not just what it returns.
 *
 * 2. THE EXECUTORS, run against the REAL anonymous client. These reads are public
 *    — the same ones every product page makes — so this needs no session and no
 *    service key, which is exactly the boundary being tested: if any of these
 *    tools needed a privileged client, this file could not run at all.
 *
 * It asserts the refusals as carefully as the results. A concierge that answers
 * "we don't have that" when we do is a bad afternoon; one that describes a
 * weaving tradition nobody wrote down is a claim the shop cannot defend.
 */
import fs from "node:fs";
import pg from "pg";

// The anon client reads these at import time, so they have to be set before
// anything from lib/ is loaded.
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

// tsx compiles this as CJS, where top-level await is not available — hence one
// async main() rather than a flat script.
async function main() {
  const { CHAT_TOOLS, CHAT_TOOL_NAMES, runChatTool } = await import("../lib/chatTools");
  const { getAllBrandKnowledge } = await import("../lib/products");

  let pass = 0;
  let fail = 0;
  let notes = 0;

  function t(name: string, ok: boolean, detail = "") {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (ok) pass++;
    else fail++;
  }
  function note(text: string) {
    console.log(`  NOTE  ${text}`);
    notes++;
  }
  const says = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.toLowerCase());

  // ══ 1. The definitions ════════════════════════
  console.log("\n=== the four tools, and only those four ===");
  t(
    "exactly the four tools in the brief",
    JSON.stringify([...CHAT_TOOL_NAMES].sort()) ===
      JSON.stringify(
        ["check_availability", "get_product_details", "search_brand_knowledge", "search_products"]
      ),
    CHAT_TOOL_NAMES.join(", ")
  );

  for (const tool of CHAT_TOOLS) {
    const schema = tool.input_schema as {
      properties?: Record<string, { description?: string }>;
      additionalProperties?: boolean;
    };
    t(`${tool.name}: refuses unknown arguments`, schema.additionalProperties === false);
    t(
      `${tool.name}: every parameter is described`,
      Object.values(schema.properties ?? {}).every((p) => Boolean(p.description)),
    );
    // The property that lifts call rate on current models, and the one most
    // likely to be edited away by someone tightening the prose.
    t(
      `${tool.name}: says when to call it`,
      says(tool.description ?? "", "call this") || says(tool.description ?? "", "call it"),
    );
  }

  console.log("\n=== nothing here can write ===");
  // A read-only surface is a claim about names as much as behaviour: the moment a
  // tool is called create_/update_/set_, somebody has crossed the line this file
  // exists to hold.
  t(
    "no tool is named for an action",
    CHAT_TOOL_NAMES.every((n) => /^(search|get|check)_/.test(n)),
    CHAT_TOOL_NAMES.join(", ")
  );
  const source = fs.readFileSync("lib/chatTools.ts", "utf8");
  t(
    "the tool module never builds a service-role client",
    !source.includes("createServiceClient"),
    "the privileged order lookup stays in lib/chat.ts and is not a tool"
  );
  t(
    "and never writes",
    !/\.(insert|update|upsert|delete)\(/.test(source),
    "no PostgREST writer appears in the file at all"
  );

  // ══ 2. The executors, for real ════════════════
  console.log("\n=== search_products ===");
  const linen = await runChatTool("search_products", { query: "linen" });
  console.log(`        ${linen.text.split("\n").slice(0, 3).join(" | ")}`);
  t("a plausible query returns something or says it doesn't", typeof linen.text === "string" && linen.text.length > 0);
  if (linen.found) {
    t("results carry the slug the other tools need", says(linen.text, "slug:"));
  } else {
    note("nothing matched 'linen' — the shop's four products may not mention it");
  }

  const nonsense = await runChatTool("search_products", { query: "zzzqqq" });
  t("an impossible query does not invent a product", nonsense.found === false);
  t("and tells the model not to guess", says(nonsense.text, "do not guess"));

  const blank = await runChatTool("search_products", { query: "   " });
  t("an empty query is refused rather than listing the shop", blank.found === false);

  console.log("\n=== get_product_details ===");
  // Take a real slug from the search above rather than hardcoding one; product
  // slugs are the owner's to change and a test that pins them rots.
  const slugMatch = /slug: ([a-z0-9-]+)\)/.exec(linen.found ? linen.text : "");
  const anySearch = slugMatch ? linen : await runChatTool("search_products", { query: "cotton" });
  const slug = (/slug: ([a-z0-9-]+)\)/.exec(anySearch.text) ?? [])[1];

  if (slug) {
    const details = await runChatTool("get_product_details", { slug });
    t(`a real slug (${slug}) returns details`, details.found === true);
    t("including a price", says(details.text, "price:"));
    t("including sizes", says(details.text, "sizes:"));
    // The instruction that stops it filling the gap itself.
    t(
      "and says heritage is somewhere else",
      says(details.text, "search_brand_knowledge"),
      "so it looks the story up instead of composing one"
    );
  } else {
    note("no product slug available from search — skipping the details assertions");
  }

  const ghost = await runChatTool("get_product_details", { slug: "not-a-real-piece" });
  t("an unknown slug is a refusal, not an invention", ghost.found === false);

  console.log("\n=== check_availability ===");
  if (slug) {
    const stock = await runChatTool("check_availability", { slug });
    t("stock comes back for a real piece", stock.found === true);
    console.log(`        ${stock.text}`);

    const wrongSize = await runChatTool("check_availability", { slug, size: "XXXL" });
    t(
      "a size the piece doesn't come in says so, and lists the ones it does",
      wrongSize.text.toLowerCase().includes("does not come in") ||
        wrongSize.text.toLowerCase().includes("no separate sizes"),
      wrongSize.text
    );
  }
  const ghostStock = await runChatTool("check_availability", { slug: "not-a-real-piece" });
  t("an unknown slug cannot be reported as available", ghostStock.found === false);

  console.log("\n=== search_brand_knowledge ===");
  const written = await getAllBrandKnowledge();
  console.log(`        ${written.length} product(s) written up so far`);

  if (written.length === 0) {
    // The state the shop is actually in on the day this ships, and the behaviour
    // that matters most: no notes must never become improvised provenance.
    const empty = await runChatTool("search_brand_knowledge", { query: "kasavu" });
    t("with nothing written, a heritage query finds nothing", empty.found === false);
    t(
      "and the model is told not to answer from general knowledge",
      says(empty.text, "general knowledge"),
      "the one instruction protecting the provenance claim"
    );

    if (slug) {
      const perPiece = await runChatTool("search_brand_knowledge", { slug });
      t("a real piece with no notes says exactly that", perPiece.found === false);
      t(
        "and does not describe how it was probably made",
        says(perPiece.text, "do not describe"),
        perPiece.text.slice(0, 80) + "…"
      );
    }
  } else {
    const hit = await runChatTool("search_brand_knowledge", { slug: written[0].slug });
    t(`${written[0].slug} returns its notes`, hit.found === true);
    const query = await runChatTool("search_brand_knowledge", { query: "loom" });
    t("a cross-product query runs", typeof query.text === "string" && query.text.length > 0);
  }

  const ghostKnowledge = await runChatTool("search_brand_knowledge", { slug: "not-a-real-piece" });
  t("an unknown slug has no heritage either", ghostKnowledge.found === false);

  console.log("\n=== an unknown tool ===");
  const madeUp = await runChatTool("place_order", { anything: true });
  t("a hallucinated tool is answered, not thrown", madeUp.found === false);
  t("and is told it does not exist", says(madeUp.text, "no tool called"));

  // ══ 3. The boundary ═══════════════════════════
  // The claim is that the concierge cannot reach what the storefront hides. That is
  // only demonstrable against a product the storefront actually hides, so this
  // looks for one rather than assuming.
  console.log("\n=== what the storefront hides, the concierge cannot see ===");
  const db = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await db.connect();
    const { rows } = await db.query(
      `select pv.slug, pv.is_active, cv.is_visible, cv.name as category
         from product_versions pv
         left join category_versions cv
           on cv.category_id = pv.category_id and cv.state = 'published'
        where pv.state = 'published'
          and (cv.is_visible is not true or pv.is_active is not true or pv.category_id is null)
        limit 1`
    );
    if (rows.length === 0) {
      note("every published product is currently in a visible category — nothing hidden to test against");
    } else {
      const hidden = rows[0];
      const reached = await runChatTool("get_product_details", { slug: hidden.slug });
      t(
        `a hidden piece (${hidden.slug}, category ${hidden.category ?? "none"}) is invisible to the concierge`,
        reached.found === false,
        "visibility scoping is inherited from the storefront reads, not re-implemented"
      );
      const searched = await runChatTool("search_products", { query: hidden.slug.replace(/-/g, " ") });
      t("and does not surface in a search for its own name", !says(searched.text, `slug: ${hidden.slug})`));
    }
  } catch (e) {
    note(`could not check the hidden-product boundary: ${(e as Error).message}`);
  } finally {
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed, ${notes} note(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
