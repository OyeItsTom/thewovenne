/**
 * Product content check — the rules behind the Add Product form's panel.
 *
 *   npx --cache <dir> --yes tsx@4.19.2 scripts/product-content.test.ts
 *
 * The examples are the real names the first catalogue shipped with. Each test
 * asserts two things: that the problem is SEEN, and that nothing uncertain is
 * turned into a fact on the way to a suggestion.
 */
import fs from "node:fs";
import path from "node:path";
import {
  applySuggestion,
  checkProductContent,
  cleanName,
  draftDescription,
  productTypeFor,
  titleCase,
  type ContentInput,
  type Finding,
} from "../lib/productContent";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

/** A snapshot of the live catalogue's shape: names, fabrics and colours as stored. */
const CATALOGUE: ContentInput["otherProducts"] = [
  { name: "Lime Green Thick Border Saree", fabric: "Handloom 120 count mul cotton", colour: "Off-white" },
  { name: "Red Heart Embroidered Saree", fabric: "Cotton", colour: "Off-white" },
  { name: "Tennis Choker Necklace", fabric: null, colour: null },
  { name: "Pink Border Handloom Mul Cotton Saree", fabric: "Handloom 120 count mul cotton", colour: "Off-white" },
];

const SAREE = { categoryName: "Sarees", parentCategoryName: "Women" };
const RING = { categoryName: "Rings", parentCategoryName: "Jewellery" };

function input(over: Partial<ContentInput>): ContentInput {
  return {
    name: "",
    description: "",
    fabric: "",
    colour: "",
    categoryName: null,
    parentCategoryName: null,
    sizes: [],
    otherProducts: [],
    ...over,
  };
}

const byField = (fs_: Finding[], field: string) => fs_.filter((f) => f.field === field);
const nameSuggestion = (fs_: Finding[]) => fs_.find((f) => f.field === "name" && f.suggestion)?.suggestion?.value ?? null;
const descSuggestion = (fs_: Finding[]) => fs_.find((f) => f.field === "description" && f.suggestion)?.suggestion?.value ?? null;
const messages = (fs_: Finding[]) => fs_.map((f) => f.message).join("\n");

console.log("\nhelpers");
check("type from Sarees", productTypeFor("Sarees"), "saree");
check("type from Dhoti", productTypeFor("Dhoti"), "dhoti");
check("type from Nehru Jackets", productTypeFor("Nehru Jackets"), "nehru jacket");
check("type from Dress keeps the ss", productTypeFor("Dress"), "dress");
check("title case keeps small words low and 14K as typed", titleCase("couple ring with 14K gold"), "Couple Ring with 14K Gold");
check("title case hyphenated", titleCase("off-white tie-dye"), "Off-White Tie-Dye");

console.log("\n1. “Lime green thick border” — naming quality");
{
  const r = checkProductContent(input({ name: "Lime green thick border", ...SAREE, otherProducts: [] }));
  check("suggests the cleaned name", nameSuggestion(r.findings), "Lime Green Thick Border Saree");
  const f = r.findings.find((x) => x.suggestion?.field === "name")!;
  check("explains capitalisation", f.reasons!.some((x) => /Capitalises/.test(x)), true);
  check("explains the added product type", f.reasons!.some((x) => /product type/.test(x)), true);
  check("evidence is DERIVED", f.evidence, "DERIVED");
  check("status needs review", r.status, "warn");
}

console.log("\n2. “Red Heart Emb” — abbreviation");
{
  const r = checkProductContent(input({ name: "Red Heart Emb", ...SAREE }));
  check("suggests Embroidered + Saree", nameSuggestion(r.findings), "Red Heart Embroidered Saree");
  check("says which abbreviation", r.findings.some((f) => f.reasons?.some((x) => x.includes("“Emb” → “embroidered”"))), true);
}
{
  const r = checkProductContent(input({ name: "Magenta w green lines border", ...SAREE }));
  check("“w” becomes “with”", nameSuggestion(r.findings), "Magenta with Green Lines Border Saree");
}

console.log("\n3. “Mini Check - Pink+Magenta” — spacing and wording");
{
  const r = checkProductContent(input({ name: "Mini Check - Pink+Magenta", ...SAREE }));
  check("colours move to the front, + becomes and", nameSuggestion(r.findings), "Pink and Magenta Mini Check Saree");
}
{
  const c = cleanName("Tissue Fancy - Red thick Border", "Sarees");
  check("a non-colour tail just loses the dash", c.value, "Tissue Fancy Red Thick Border Saree");
}

console.log("\n“Zari tie & dye - Pin” — Pin is NOT turned into Pink");
{
  const r = checkProductContent(input({ name: "Zari tie & dye - Pin", ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  const s = nameSuggestion(r.findings)!;
  check("suggestion keeps “Pin”", /\bPin\b/.test(s) && !/Pink/.test(s), true);
  check("suggestion", s, "Zari Tie-Dye Pin Saree");
  const typo = r.findings.find((f) => f.id.startsWith("name:typo:pin"));
  check("Pin flagged as a possible typo for Pink", typo?.message.includes("“Pink”"), true);
  check("…labelled UNCERTAIN", typo?.evidence, "UNCERTAIN");
  check("…with no suggestion attached", typo?.suggestion, undefined);
}

console.log("\n4. “Tissue Elephant Emb” + Fabric Cotton — conflict reported, not resolved");
{
  const form = input({ name: "Tissue Elephant Emb", ...SAREE, fabric: "Cotton", colour: "Off-white", otherProducts: CATALOGUE });
  const r = checkProductContent(form);
  const conflict = r.findings.find((f) => f.id.startsWith("fabric:conflict"));
  check("fabric conflict found", !!conflict, true);
  check("it is a problem, not a warning", conflict?.level, "problem");
  check("message names both sides", /Tissue.*Cotton/.test(conflict?.message ?? ""), true);
  check("no suggestion offered for Fabric", byField(r.findings, "fabric").some((f) => f.suggestion), false);
  check("name suggestion keeps Tissue (does not resolve it)", nameSuggestion(r.findings), "Tissue Elephant Embroidered Saree");
  check("status is problem", r.status, "problem");
  check("no description is suggested while the fabric is unsettled", descSuggestion(r.findings), null);
  check("input untouched", form.fabric, "Cotton");
}

console.log("\n5. “Adjustable Ring” with size 6");
{
  const r = checkProductContent(input({ name: "Adjustable Ring", ...RING, sizes: ["6"] }));
  const f = r.findings.find((x) => x.field === "sizes");
  check("size/name conflict found", f?.level, "problem");
  check("names the size", f?.message.includes("“6”"), true);
}
{
  const r = checkProductContent(input({ name: "Adjustable Ring", ...RING, sizes: ["Free Size"] }));
  check("“Free Size” does not conflict with Adjustable", byField(r.findings, "sizes").length, 0);
}
{
  const r = checkProductContent(input({ name: "Couple Ring | 14K Gold Plated | Adjustable Detachable Ring", ...RING, sizes: ["6"] }));
  check("the live ring name: pipes flagged", r.findings.some((f) => f.id.startsWith("name:separators")), true);
  check("…and the size conflict", r.findings.some((f) => f.field === "sizes" && f.level === "problem"), true);
  check("…jewellery gets no invented description", descSuggestion(r.findings), null);
  check("…metal/plating/stone listed as missing", r.missing.some((m) => /plating/.test(m)), true);
}

console.log("\n6. Missing description");
{
  const r = checkProductContent(input({ name: "Red Heart Embroidered Saree", ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  const f = r.findings.find((x) => x.field === "description");
  check("warns", f?.level, "warn");
  check("suggests a plain description from name + fabric only", descSuggestion(r.findings), "A red heart embroidered saree in cotton.");
  check("labelled DERIVED", f?.evidence, "DERIVED");
}
{
  const r = checkProductContent(input({ name: "Red Heart Embroidered Saree", ...SAREE }));
  check("no fabric → no suggested description", descSuggestion(r.findings), null);
  check("…and fabric listed as needing confirmation", r.missing.some((m) => /^Fabric/.test(m)), true);
}
{
  check("description draft keeps a proper-noun fabric", draftDescription("Violet Saree", "Chanderi Silk"), "A violet saree in Chanderi Silk.");
  check("“An” before a vowel", draftDescription("Off-White Dhoti with Gold Zari Border", "Cotton"), "An off-white dhoti with gold zari border in cotton.");
}
{
  const r = checkProductContent(input({ name: "Kasavu Saree with Zari Border", ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  check("zari type listed as needing confirmation", r.missing.some((m) => /Zari type/.test(m)), true);
  check("…and never put in the description", /pure|tested/i.test(descSuggestion(r.findings) ?? ""), false);
}

console.log("\n7. A good product — no unnecessary warnings");
{
  const r = checkProductContent(
    input({
      name: "Green and Violet Tie-Dye Saree",
      description: "A green and violet tie-dye saree in cotton, with a gold border and tassels on the pallu.",
      fabric: "Cotton",
      colour: "Green",
      ...SAREE,
      otherProducts: CATALOGUE,
    })
  );
  check("status looks good", r.status, "ok");
  check("no findings", messages(r.findings), "");
  check("nothing missing", r.missing, []);
}
{
  const r = checkProductContent(
    input({
      name: "Tennis Choker Bracelet",
      description: "A tennis-style bracelet crafted from copper, 14K gold plated, with a synthetic cubic zirconia inlay.",
      categoryName: "Bracelets",
      parentCategoryName: "Jewellery",
      colour: "Gold",
      otherProducts: CATALOGUE,
    })
  );
  check("jewellery with a factual description (the house example): looks good", [r.status, messages(r.findings)], ["ok", ""]);
}

console.log("\nother checks");
{
  const r = checkProductContent(input({ name: "Red heart embroidered saree", ...SAREE, otherProducts: CATALOGUE }));
  check("exact duplicate (case-insensitive) is a problem", r.findings.find((f) => f.id.startsWith("name:duplicate"))?.level, "problem");
  check("…and the tidy version is not offered, since it is taken", nameSuggestion(r.findings), null);
}
{
  const r = checkProductContent(input({ name: "Saree Thick Border Lime Green", ...SAREE, otherProducts: CATALOGUE }));
  check("same words in a different order is flagged as close", r.findings.some((f) => f.id.startsWith("name:near")), true);
}
{
  const r = checkProductContent(input({ name: "  Red  Saree ", ...SAREE }));
  check("outer and double spaces cleaned", nameSuggestion(r.findings), "Red Saree");
}
{
  const r = checkProductContent(input({ name: "Red Saree Saree", ...SAREE }));
  check("repeated word removed", nameSuggestion(r.findings), "Red Saree");
}
{
  const r = checkProductContent(input({ name: "Stunning Gorgeous Saree", ...SAREE }));
  check("marketing words flagged", r.findings.some((f) => f.id.startsWith("name:marketing")), true);
  check("…but not removed from the suggestion", nameSuggestion(r.findings), null);
}
{
  const r = checkProductContent(input({ name: "Saree", ...SAREE }));
  check("vague name flagged", r.findings.some((f) => f.id.startsWith("name:vague")), true);
}
{
  const r = checkProductContent(input({ name: "Gren Border Saree", ...SAREE }));
  check("misspelt colour hinted, not changed", [r.findings.some((f) => f.id.startsWith("name:typo:gren")), nameSuggestion(r.findings)], [true, null]);
}
{
  const long = "Green and Red Temple Border Handloom Mul Cotton Saree with Gold Zari Tassels";
  const r = checkProductContent(input({ name: long, ...SAREE, fabric: "Handloom 120 count mul cotton" }));
  check("long name flagged", r.findings.some((f) => f.id.startsWith("name:long")), true);
}
{
  const r = checkProductContent(input({ name: "Pink Tie-Dye Saree with Gold Zari Border", ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  const f = r.findings.find((x) => x.id.startsWith("colour:review"));
  check("pink body vs Off-white colour → review", f?.level, "warn");
  check("…UNCERTAIN, no suggestion", [f?.evidence, f?.suggestion], ["UNCERTAIN", undefined]);
}
{
  const r = checkProductContent(input({ name: "Red and Black Double Line Border Saree", ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  check("colours joined by “and” before a border are border colours", r.findings.some((f) => f.id.startsWith("colour:review")), false);
}
{
  const r = checkProductContent(input({ name: "Red Saree", ...SAREE, fabric: "Cotton", colour: "Red", description: "An elegant red saree in cotton with a vibrant gold border." }));
  check("sales adjectives in a description flagged", r.findings.find((f) => f.id.startsWith("description:marketing"))?.message.includes("“elegant”"), true);
}
{
  const r = checkProductContent(input({ name: "Red Saree", ...SAREE, fabric: "Cotton", colour: "Red", description: "A red cotton saree with a gold-plated brooch pin and copper thread." }));
  check("metal claims in a SAREE description are still questioned", r.findings.some((f) => f.id.startsWith("description:claims")), true);
}
{
  const r = checkProductContent(input({ name: "Lime Green Thick Border Saree", ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  check("a border colour does not trigger a colour review", r.findings.some((f) => f.id.startsWith("colour:review")), false);
}
{
  const r = checkProductContent(input({ name: "Red Saree", ...SAREE, fabric: "Cotton", colour: "off white", otherProducts: CATALOGUE }));
  const f = r.findings.find((x) => x.id.startsWith("colour:spelling"));
  check("new spelling of an existing colour → existing spelling offered", f?.suggestion, { field: "colour", value: "Off-white" });
}
{
  const r = checkProductContent(input({ name: "Red Saree", ...SAREE, fabric: "handloom 120 count Mul Cotton", colour: "Red", otherProducts: CATALOGUE }));
  check("same for fabric", r.findings.find((x) => x.id.startsWith("fabric:spelling"))?.suggestion?.value, "Handloom 120 count mul cotton");
}
{
  const r = checkProductContent(input({ name: "Handloom Red Saree", ...SAREE, fabric: "Cotton", colour: "Red" }));
  check("“Handloom” in the name without backing → confirm", r.findings.some((f) => f.id.startsWith("fabric:claim")), true);
}
{
  const r = checkProductContent(input({ name: "Silk Saree", ...SAREE, colour: "Red" }));
  check("fabric named but field empty → warn, not filled in", [r.findings.find((f) => f.id.startsWith("fabric:empty-named"))?.level, byField(r.findings, "fabric").some((f) => f.suggestion)], ["warn", false]);
}
{
  const r = checkProductContent(
    input({
      name: "Red Saree",
      ...SAREE,
      fabric: "Cotton",
      colour: "Red",
      description: "Elevate your wardrobe with this timeless masterpiece, perfect for every special occasion.",
    })
  );
  check("advert language flagged", r.findings.some((f) => f.id.startsWith("description:marketing")), true);
  check("occasion claim flagged", r.findings.some((f) => f.id.startsWith("description:claims") && /occasion/.test(f.message)), true);
}
{
  const r = checkProductContent(
    input({ name: "Red Saree", ...SAREE, fabric: "Cotton", colour: "Red", description: "A handwoven silk saree from Kerala, 5.5 m long with a blouse piece." })
  );
  const f = r.findings.find((x) => x.id.startsWith("description:claims"))!;
  check("unbacked claims each named", ["how it was made", "where it was made", "a blouse piece", "a measurement"].every((c) => f.message.includes(c)), true);
  check("description says silk, fabric says cotton", r.findings.some((x) => x.id.startsWith("description:fabric")), true);
}
{
  const r = checkProductContent(
    input({ name: "Red Handloom Saree", ...SAREE, fabric: "Handloom cotton", colour: "Red", description: "A red handloom saree in cotton, with a plain border." })
  );
  check("a claim backed by Fabric is not flagged", r.findings.some((x) => x.id.startsWith("description:claims")), false);
}
{
  const r = checkProductContent(input({ name: "Red Saree", ...SAREE, fabric: "Cotton", colour: "Red", description: "  A red saree in cotton, plain border and pallu.  " }));
  check("outer spaces in description → trimmed suggestion", descSuggestion(r.findings), "A red saree in cotton, plain border and pallu.");
}

console.log("\nColour = the MAIN BODY colour (decision of 3 Oct 2026)");
{
  const r = checkProductContent(input({ name: "Off-White Saree with Green Border", ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  check("1. off-white body + green border: Off-white not flagged because of Green", r.findings.filter((f) => f.field === "colour").map((f) => f.id), []);
}
{
  const r = checkProductContent(input({ name: "Pink Tie-Dye Saree", ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  const f = r.findings.find((x) => x.id.startsWith("colour:review"));
  check("2. pink tie-dye + Off-white → Colour requires review", f?.message.startsWith("Colour requires review"), true);
  check("   …says Colour is the main body colour", /main body colour/.test(f?.message ?? ""), true);
  check("   …never replaced automatically", [f?.evidence, f?.suggestion], ["UNCERTAIN", undefined]);
}
for (const name of ["Lime Green Thick Border Saree", "White Border with Red Line Saree", "Red and Black Double Line Border Saree", "Magenta Border with Green Lines Saree"]) {
  const r = checkProductContent(input({ name, ...SAREE, fabric: "Cotton", colour: "Off-white" }));
  check(`3. border colour is not the body: ${name}`, r.findings.filter((f) => f.field === "colour").map((f) => f.id), []);
}
{
  const r = checkProductContent(input({ name: "Lime Green Thick Border Saree", ...SAREE, fabric: "Cotton", colour: "Lime Green" }));
  const f = r.findings.find((x) => x.id.startsWith("colour:border"));
  check("   Colour set to the border colour → review", f?.message.includes("border"), true);
  check("   …UNCERTAIN, no suggestion", [f?.evidence, f?.suggestion], ["UNCERTAIN", undefined]);
}
{
  const r = checkProductContent(input({ name: "Pink Tie-Dye Saree", ...SAREE, fabric: "Cotton", colour: "Pink" }));
  check("   pink tie-dye with Colour Pink → nothing to say about colour", r.findings.filter((f) => f.field === "colour").length, 0);
}
{
  const r = checkProductContent(input({ name: "Green Border Saree", ...SAREE, fabric: "Cotton", colour: "off white", otherProducts: CATALOGUE }));
  const f = r.findings.find((x) => x.id.startsWith("colour:spelling"));
  check("4. new product Colour “off white” → canonical “Off-white” offered", f?.suggestion, { field: "colour", value: "Off-white" });
  check("   …and the green border does not trigger a colour review", r.findings.some((x) => x.id.startsWith("colour:review") || x.id.startsWith("colour:border")), false);
}

console.log("\n8. Existing products are never touched");
{
  const catalogue = JSON.parse(JSON.stringify(CATALOGUE));
  const frozen = Object.freeze(catalogue.map((p: object) => Object.freeze({ ...p })));
  const form = Object.freeze(input({ name: "Red Heart Emb", ...SAREE, fabric: "Cotton", colour: "off white", otherProducts: frozen }));
  let threw = false;
  try {
    checkProductContent(form);
  } catch {
    threw = true;
  }
  check("runs on frozen input (no mutation possible)", threw, false);
  check("catalogue values unchanged", catalogue, CATALOGUE);
  const src = fs.readFileSync(path.join(__dirname, "../lib/productContent.ts"), "utf8");
  const ui = fs.readFileSync(path.join(__dirname, "../components/admin/ProductContentCheck.tsx"), "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("checker imports nothing (no database, no network)", /^\s*import\s/m.test(code(src)), false);
  check("checker has no fetch/supabase", /fetch\(|supabase|\.from\(\s*["']/i.test(code(src)), false);
  check("panel has no database, fetch, save or publish", /supabase|fetch\(|publish_all|publishAll|handleSubmit|requestSubmit|\.submit\(|\.update\(|\.insert\(|\.from\(\s*["']/i.test(code(ui)), false);
  check("panel does not submit the form (every button is type=button)", (code(ui).match(/<button\b/g) ?? []).length === (code(ui).match(/type="button"/g) ?? []).length, true);
}

console.log("\n9. Accepting a suggestion changes one field and nothing else");
{
  const form = { name: "Red Heart Emb", slug: "red-heart-emb", description: "", fabric: "Cotton", colour: "Off-white", price_inr: "1499", cost_price_inr: "600", stock_quantity: "1" };
  const next = applySuggestion(form, { field: "name", value: "Red Heart Embroidered Saree" });
  check("name changed", next.name, "Red Heart Embroidered Saree");
  const { name: _a, ...restBefore } = form;
  const { name: _b, ...restAfter } = next;
  check("every other field identical (cost included)", restAfter, restBefore);
  check("original form object not mutated", form.name, "Red Heart Emb");
  const d = applySuggestion(form, { field: "description", value: "A red heart embroidered saree in cotton." });
  check("description suggestion touches only description", Object.keys(form).filter((k) => (form as Record<string, string>)[k] !== (d as Record<string, string>)[k]), ["description"]);
  const modal = fs.readFileSync(path.join(__dirname, "../components/admin/ProductModal.tsx"), "utf8");
  const useHandler = modal.match(/const acceptSuggestion = [\s\S]*?\n {2}};/)?.[0] ?? "";
  check("the modal's accept handler exists", useHandler.length > 0, true);
  check("…and never saves, publishes or touches the database", /handleSubmit|supabase|publish|settleDraft|onSaved|from\(/.test(useHandler), false);
}

console.log("\n10. Ignoring a suggestion leaves the data alone");
{
  const form = input({ name: "Red Heart Emb", ...SAREE, fabric: "Cotton", colour: "Off-white" });
  const before = JSON.stringify(form);
  const r = checkProductContent(form);
  const ignored = new Set([r.findings.find((f) => f.suggestion?.field === "name")!.id]);
  const visible = r.findings.filter((f) => !ignored.has(f.id));
  check("ignored finding hidden", visible.some((f) => f.suggestion?.field === "name"), false);
  check("form unchanged", JSON.stringify(form), before);
  const again = checkProductContent({ ...form, name: "Red Heart Embd" });
  check("an edit brings the check back (ignore is per value)", again.findings.some((f) => f.suggestion?.field === "name" && !ignored.has(f.id)), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
