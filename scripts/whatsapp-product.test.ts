/**
 * The "Ask on WhatsApp" message a product page sends.
 *
 * The env vars are set BEFORE the module is imported only for tidiness — both
 * helpers read process.env at call time, so each case can move the ground under
 * them and see what the customer would actually receive.
 */
process.env.NEXT_PUBLIC_WHATSAPP_NUMBER = "919876543210";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else {
    fail++;
    if (detail) console.log(`        ${detail}`);
  }
}

async function main() {
  const { whatsappProductEnquiry, whatsappHrefFor } = await import("../lib/whatsapp");
  const { customerOrigin, customerUrl, PRODUCTION_ORIGIN } = await import("../lib/seo");
  const { productHref } = await import("../lib/urls");

  const product = {
    name: "Kerala Kasavu",
    slug: "kerala-kasavu",
    category_slug: "sarees",
    category_parent_slug: "women",
  };

  const decode = (href: string) =>
    decodeURIComponent(href.slice(href.indexOf("?text=") + "?text=".length));

  console.log("\n=== the message carries the product's identity ===");
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.thewovenne.com";
  const href = whatsappProductEnquiry(product)!;
  const text = decode(href);

  check("a link is produced at all", typeof href === "string" && href.length > 0);
  check("it keeps the configured destination", href.startsWith("https://wa.me/919876543210?text="));
  check("no phone number is written here", !/wa\.me\/\d/.test(JSON.stringify({ text })));
  check("the product name is present", text.includes("Kerala Kasavu"), text);
  check(
    "the ABSOLUTE product URL is present",
    text.includes("https://www.thewovenne.com/in/women/sarees/kerala-kasavu"),
    text
  );
  check("the request reads politely", /know more about/i.test(text) && /\?$/m.test(text.trim()));
  check("no price is quoted into a chat", !/₹|\bINR\b/.test(text));

  console.log("\n=== the URL comes from the app's own helpers ===");
  check(
    "it matches customerUrl(productHref(product))",
    text.includes(customerUrl(productHref(product))),
    `${customerUrl(productHref(product))} not in ${text}`
  );
  check(
    "a product with incomplete filing still gets a real URL",
    decode(
      whatsappProductEnquiry({
        name: "Unfiled Piece",
        slug: "unfiled-piece",
        category_slug: null,
        category_parent_slug: null,
      })!
    ).includes("https://www.thewovenne.com/in/product/unfiled-piece")
  );

  console.log("\n=== a customer is never sent somewhere that will not exist ===");
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  check("localhost is replaced by production", customerOrigin() === PRODUCTION_ORIGIN, customerOrigin());
  check(
    "the message therefore carries no localhost",
    !decode(whatsappProductEnquiry(product)!).includes("localhost")
  );

  process.env.NEXT_PUBLIC_SITE_URL = "https://thewovenne-git-fix-abc123.vercel.app";
  check("a Preview hostname is replaced by production", customerOrigin() === PRODUCTION_ORIGIN, customerOrigin());
  check(
    "the message therefore carries no preview host",
    !decode(whatsappProductEnquiry(product)!).includes("vercel.app")
  );

  delete process.env.NEXT_PUBLIC_SITE_URL;
  check("an unset origin falls back to production", customerOrigin() === PRODUCTION_ORIGIN);

  process.env.NEXT_PUBLIC_SITE_URL = "not a url";
  check("an unparseable origin falls back to production", customerOrigin() === PRODUCTION_ORIGIN);

  process.env.NEXT_PUBLIC_SITE_URL = "https://www.thewovenne.com/";
  check("a trailing slash does not double up", customerUrl("/in/shop") === "https://www.thewovenne.com/in/shop");

  console.log("\n=== encoding survives real product names ===");
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.thewovenne.com";
  const awkward = whatsappProductEnquiry({
    name: "Men's Kasavu & Gold — “Onam” Set #2",
    slug: "mens-kasavu-gold",
    category_slug: "shirts",
    category_parent_slug: "men",
  })!;
  check("& is encoded, not left to split the query", !awkward.includes("&text") && awkward.includes("%26"));
  check("# is encoded, not left to start a fragment", !awkward.split("?text=")[1].includes("#"));
  check("the apostrophe and curly quotes round-trip", decode(awkward).includes("Men's Kasavu & Gold — “Onam” Set #2"));
  check("newlines are encoded as %0A", awkward.includes("%0A"));

  const unicode = whatsappProductEnquiry({
    name: "കസവ് साड़ी",
    slug: "kasavu-saree",
    category_slug: "sarees",
    category_parent_slug: "women",
  })!;
  check("non-Latin names round-trip", decode(unicode).includes("കസവ് साड़ी"));
  check("non-Latin names are percent-encoded on the wire", /%[0-9A-F]{2}/.test(unicode));

  console.log("\n=== the absent-number rule is untouched ===");
  delete process.env.NEXT_PUBLIC_WHATSAPP_NUMBER;
  check("no number means no link, not a broken one", whatsappProductEnquiry(product) === null);
  check("a malformed number is still refused", whatsappHrefFor("12", "hi") === null);
  check("a formatted number is still accepted", whatsappHrefFor("+91 98765 43210", "hi") === "https://wa.me/919876543210?text=hi");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
