/**
 * The accessibility foundation: modal focus, readable primary buttons and
 * labels, the Add to Cart announcement, and the empty-bag way back.
 *
 *   npx tsx scripts/a11y-foundation.test.ts
 *
 * The project has no test runner or DOM, so this is a plain script in the same
 * style as the others. What it can prove headlessly it proves directly: the
 * Tab-trap decision, the announcement sentences, the real cart store's
 * behaviour, and the contrast of the actual tokens in tailwind.config.ts. The
 * wiring (portal, inert, aria attributes, focus return) is guarded as a source
 * contract; the keyboard behaviour itself was exercised in a real browser and
 * is recorded in the pull request.
 *
 * Exits non-zero on failure.
 */
import { readFileSync } from "node:fs";
import tailwind from "../tailwind.config";
import { nextTrapTarget } from "../lib/focusTrap";
import { cartAddAnnouncement } from "../lib/cartAnnouncement";
// The cart store persists to localStorage; Node has none, and without one
// zustand neither persists nor exposes its persist API. An in-memory stand-in,
// installed before the store is loaded (hence require, not a hoisted import).
const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useCartStore } = require("../lib/store") as typeof import("../lib/store");

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else {
    fail++;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}
const read = (path: string) => readFileSync(path, "utf8");

// ── Tab trap ────────────────────────────────────────────────────────────────
console.log("\n=== Tab stays inside the dialog ===");

type Fake = { id: string; contains(other: never): boolean };
const a: Fake = { id: "close", contains: () => false };
const b: Fake = { id: "name", contains: () => false };
const c: Fake = { id: "save", contains: () => false };
const outside: Fake = { id: "table-row", contains: () => false };
const members = new Set<unknown>([a, b, c]);
const panel: Fake = { id: "panel", contains: (x: never) => members.has(x) };
const stops = [a, b, c];

check("Tab on the last control wraps to the first", nextTrapTarget(stops, c, panel, false) === a);
check("Shift+Tab on the first control wraps to the last", nextTrapTarget(stops, a, panel, true) === c);
check("Shift+Tab from the panel itself (focus on open) goes to the last", nextTrapTarget(stops, panel, panel, true) === c);
check("Tab from the panel itself is left to the browser (→ first control)", nextTrapTarget(stops, panel, panel, false) === null);
check("an ordinary Tab between two inside controls is left alone", nextTrapTarget(stops, a, panel, false) === null);
check("an ordinary Shift+Tab between two inside controls is left alone", nextTrapTarget(stops, c, panel, true) === null);
check("focus that escaped behind the dialog is pulled back to the first (Tab)", nextTrapTarget(stops, outside, panel, false) === a);
check("…and to the last (Shift+Tab)", nextTrapTarget(stops, outside, panel, true) === c);
check("focus on <body> (null-ish) is pulled back in", nextTrapTarget(stops, null, panel, false) === a);
check("a dialog with nothing focusable holds focus on itself", nextTrapTarget([] as Fake[], panel, panel, false) === panel);
check("a single control: Tab keeps it there", nextTrapTarget([a], a, { ...panel, contains: (x: never) => x === (a as never) }, false) === a);

// ── Announcement sentences ──────────────────────────────────────────────────
console.log("\n=== what a screen reader hears after Add to Cart ===");

check(
  "one-size piece: no size noise",
  cartAddAnnouncement({ name: "Green Micro Check Saree", size: "One Size", added: 1, inBag: true }) ===
    "Added Green Micro Check Saree to your bag."
);
check(
  "sized piece names the size",
  cartAddAnnouncement({ name: "Zari Dhoti", size: "M", added: 1, inBag: true }) ===
    "Added Zari Dhoti, size M, to your bag."
);
check(
  "more than one says the quantity in words a reader speaks well",
  cartAddAnnouncement({ name: "Zari Dhoti", size: "L", added: 2, inBag: true }) ===
    "Added Zari Dhoti, size L, quantity 2, to your bag."
);
check(
  "capped at what is left: says so rather than claiming an add",
  cartAddAnnouncement({ name: "Kasavu Saree", size: "One Size", added: 0, inBag: true }) ===
    "Kasavu Saree is already in your bag at the most we have available."
);
check(
  "refused and not in the bag: never says Added",
  !cartAddAnnouncement({ name: "Kasavu Saree", size: "One Size", added: 0, inBag: false }).startsWith("Added")
);

// ── The real store ──────────────────────────────────────────────────────────
console.log("\n=== the cart store records what the add actually did ===");

const piece = {
  id: "p1",
  slug: "micro-check-green",
  name: "Green Micro Check Saree",
  price_inr: 1599,
  image_url: null,
  size: "One Size",
  available: 1,
};
const store = useCartStore;
store.setState({ items: [], isOpen: false, lastAdded: null });

store.getState().addItem(piece, 1);
check("first add is announced as an add", store.getState().lastAdded === "Added Green Micro Check Saree to your bag.", store.getState().lastAdded);
check("…and the cart really holds one", store.getState().items[0]?.quantity === 1);

store.getState().addItem(piece, 1);
check(
  "a second add capped by the stock hint is NOT announced as an add",
  store.getState().lastAdded === "Green Micro Check Saree is already in your bag at the most we have available.",
  store.getState().lastAdded
);
check("…and the cart still holds one (stock logic unchanged)", store.getState().items[0]?.quantity === 1);

store.getState().openCart();
check("opening the drawer after an add keeps the announcement", store.getState().lastAdded !== null);
store.getState().closeCart();
check("closing the drawer clears it", store.getState().lastAdded === null);

store.getState().addItem({ ...piece, id: "p2", name: "Zari Dhoti", size: "M", available: 5 }, 3);
check("a sized multi-quantity add", store.getState().lastAdded === "Added Zari Dhoti, size M, quantity 3, to your bag.", store.getState().lastAdded);
store.getState().closeCart();
store.getState().toggleCart();
check("opening from the header bag icon carries no announcement", store.getState().isOpen && store.getState().lastAdded === null);

store.getState().addItem({ ...piece, id: "p3", available: 0 }, 1);
check("a refused add (nothing left) never claims success", !store.getState().lastAdded?.startsWith("Added"), store.getState().lastAdded);

store.getState().resetForSignOut();
check("sign-out clears it", store.getState().lastAdded === null);

const partialize = store.persist.getOptions().partialize!;
const persisted = partialize({ ...store.getState(), lastAdded: "x" }) as Record<string, unknown>;
check("the announcement is never written to localStorage", !("lastAdded" in persisted), Object.keys(persisted));
check(
  "…and is absent from what was actually stored",
  !(memory.get("wovenne-cart") ?? "").includes("lastAdded") && (memory.get("wovenne-cart") ?? "").length > 0
);

// ── Contrast, from the real tokens ──────────────────────────────────────────
console.log("\n=== contrast of the tokens actually configured ===");

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = (h: string) => {
  const [r, g, b] = hex(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (x: string, y: string) => {
  const [hi, lo] = [lum(x), lum(y)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const colors = (tailwind.theme?.extend as any).colors;
const T = {
  white: colors.cream as string,
  linen: colors.linen as string,
  ink: colors.ink.DEFAULT as string,
  muted: colors.ink.muted as string,
  brand: colors.terracotta.DEFAULT as string,
  dark: colors.terracotta.dark as string,
  deep: colors.terracotta.deep as string,
};

const AA = 4.5;
const r = (x: string, y: string) => Math.round(ratio(x, y) * 100) / 100;
check(`the brand terracotta itself is unchanged (${T.brand})`, T.brand.toUpperCase() === "#C2714F");
check(`it is genuinely too light for button text: ${r(T.white, T.brand)}:1 < 4.5`, ratio(T.white, T.brand) < AA);
check(`primary resting — white on terracotta-dark ${r(T.white, T.dark)}:1 ≥ 4.5`, ratio(T.white, T.dark) >= AA);
check(`primary hover — white on terracotta-deep ${r(T.white, T.deep)}:1 ≥ 4.5`, ratio(T.white, T.deep) >= AA);
check(`primary disabled / Sold out — ink-muted on linen ${r(T.muted, T.linen)}:1 ≥ 4.5`, ratio(T.muted, T.linen) >= AA);
check(`muted labels on white ${r(T.muted, T.white)}:1 ≥ 4.5`, ratio(T.muted, T.white) >= AA);
check(`muted labels on linen ${r(T.muted, T.linen)}:1 ≥ 4.5`, ratio(T.muted, T.linen) >= AA);
check(
  `muted stays clearly quieter than body ink — under half its contrast (${r(T.muted, T.white)} vs ${r(T.ink, T.white)})`,
  ratio(T.muted, T.white) < ratio(T.ink, T.white) * 0.5
);
check(`focus ring (terracotta, offset onto white) ${r(T.brand, T.white)}:1 ≥ 3 non-text`, ratio(T.brand, T.white) >= 3);

// ── Wiring, as source contracts ─────────────────────────────────────────────
console.log("\n=== wiring ===");

const button = read("components/ui/Button.tsx");
const primaryLine = button.match(/primary:\s*\n?\s*"([^"]+)"/)?.[1] ?? "";
check("primary variant uses terracotta-dark at rest", /\bbg-terracotta-dark\b/.test(primaryLine), primaryLine);
check("primary variant hovers to terracotta-deep", /hover:bg-terracotta-deep\b/.test(primaryLine));
check("primary disabled is a readable linen surface, not a fade", /disabled:bg-linen\b/.test(primaryLine) && /disabled:text-ink-muted\b/.test(primaryLine));
check("the 50% fade no longer applies to primary", !/disabled:opacity-50/.test(primaryLine) && !/cursor-not-allowed disabled:opacity-50/.test(button));

const sticky = read("components/product/ProductOptions.tsx");
check("the mobile sticky Add to Cart matches", /bg-terracotta-dark[^"]*hover:bg-terracotta-deep[^"]*disabled:bg-linen disabled:text-ink-muted/.test(sticky));

const noBareTerracottaButton = [
  "components/ui/Button.tsx",
  "components/product/ProductOptions.tsx",
  "components/style/StyleSubmissionForm.tsx",
  "app/global-error.tsx",
].every((f) => !/bg-terracotta [^"]*text-cream/.test(read(f)));
check("no primary-style button left on bare terracotta behind white text", noBareTerracottaButton);

const detail = read("components/product/ProductDetail.tsx");
const card = read("components/shop/ProductCard.tsx");
const line = read("components/cart/CartItem.tsx");
const sizeSel = read("components/product/SizeSelector.tsx");
const qty = read("components/product/AddToCart.tsx");
check("PDP category label uses ink-muted", /tracking-wider text-ink-muted">\s*\{product\.category\}/.test(detail));
check("PDP stock note uses ink-muted", /tracking-\[0\.12em\] text-ink-muted">\s*<span aria-hidden className="h-1 w-1 rounded-full bg-gold" \/>\s*\{note\}/.test(detail));
// PR 3: the fabric is now a labelled detail — the "Fabric" label is the quiet
// ink-muted text and the value itself is full ink. Since 0065 the fabric is the
// first of the fact rows (productFactRows), rendered by one loop, so the label
// and value classes are checked on that loop.
check("PDP fabric label uses ink-muted", /text-ink-muted">\s*\{row\.label\}\s*<\/dt>/.test(detail));
check("PDP fabric value is full ink", /text-ink">\s*\{row\.value\}/.test(detail));
check("card Sold out uses ink-muted", /text-ink-muted">\s*Sold out/.test(card));
check("cart line size uses ink-muted", /text-ink-muted">\s*Size \{item\.size\}/.test(line));
check("Size heading uses ink-muted", /text-ink-muted">\s*Size/.test(sizeSel));
check("Quantity heading uses ink-muted", /text-ink-muted">\s*Quantity/.test(qty));
check("Delivery heading uses ink-muted", /text-ink-muted">\s*Delivery/.test(read("components/product/DeliveryEstimator.tsx")));
check("labels were recoloured, not enlarged or bolded", !/text-ink-muted[^"]*font-(medium|semibold|bold)/.test(detail + card + line + sizeSel + qty));

const drawer = read("components/cart/CartDrawer.tsx");
check("drawer describes itself with the add result", /aria-describedby=\{lastAdded \? "cart-drawer-status" : undefined\}/.test(drawer));
check("the description is screen-reader only (no visual noise)", /id="cart-drawer-status" className="sr-only"/.test(drawer));
check("empty drawer offers the way back to /in/shop", /href="\/in\/shop"\s*onClick=\{closeCart\}[\s\S]{0,120}Explore the Collection/.test(drawer));
const cartPage = read("app/(storefront)/in/cart/page.tsx");
check("…in the cart page's own words", /Explore the Collection/.test(cartPage));
check("the drawer's existing focus trap is untouched", /const FOCUSABLE =/.test(drawer) && /openerRef\.current\?\.focus\?\.\(\)/.test(drawer));

const modal = read("components/ui/Modal.tsx");
check("modal renders through a portal on <body>", /createPortal\(/.test(modal) && /<\/div>,\s*document\.body\s*\)/.test(modal));
check("modal makes the rest of <body> inert and undoes only its own", /setAttribute\("inert", ""\)/.test(modal) && /madeInert\) el\.removeAttribute\("inert"\)/.test(modal));
check("modal skips siblings that were already inert", /hasAttribute\("inert"\)/.test(modal));
check("modal takes focus on open", /panelRef\.current\?\.focus\(\)/.test(modal) && /tabIndex=\{-1\}/.test(modal));
check("modal is named by its title", /aria-labelledby=\{title \? titleId : undefined\}/.test(modal) && /id=\{titleId\}/.test(modal));
check("Escape closes", /event\.key === "Escape"[\s\S]{0,80}onCloseRef\.current\(\)/.test(modal));
check("focus returns to the opener, if it still exists", /opener && opener\.isConnected\) opener\.focus/.test(modal));
check("the trap is not rebuilt on every parent render", /\}, \[isOpen\]\);/.test(modal));
check("body scroll lock is restored, not cleared", /previousOverflow/.test(modal));

const productModal = read("components/admin/ProductModal.tsx");
check("Add and Edit Product both go through the shared Modal", /import Modal from "@\/components\/ui\/Modal"/.test(productModal) && /title=\{isEdit \? `Edit \$\{product!\.name\}` : "Add New Product"\}/.test(productModal));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
