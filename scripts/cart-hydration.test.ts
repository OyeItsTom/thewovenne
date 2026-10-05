/**
 * A saved bag must not change what the first client render prints.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/cart-hydration.test.ts
 *
 * The defect (Batch 0, 5 Oct 2026): the cart store rehydrates from localStorage
 * synchronously, so with anything in the bag the browser's first render showed
 * a badge, items and a checkout form the server had rendered as an empty cart.
 * React threw #418 per mismatch and #423 as it discarded the whole document —
 * on every storefront page — and sometimes #329 instead.
 *
 * What this proves headlessly (the browser half — console output across real
 * routes and widths — is the CDP run recorded in the PR):
 *   1. the hydration render reads the SERVER snapshot (false), never the store;
 *   2. the cart page's server/hydration HTML is identical whether the persisted
 *      bag is empty or full, and claims neither "empty" nor any item;
 *   3. every component that prints cart contents during hydration is gated;
 *   4. the store's own behaviour — persistence, reload, merge, quantity,
 *      remove, sign-out — is unchanged and creates no duplicate lines.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

// The browser's localStorage, in memory. Installed before the store is loaded:
// persist reads it when the store is created, exactly as in a browser.
const disk = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (disk.has(k) ? disk.get(k)! : null),
  setItem: (k: string, v: string) => void disk.set(k, String(v)),
  removeItem: (k: string) => void disk.delete(k),
  clear: () => disk.clear(),
  key: (i: number) => [...disk.keys()][i] ?? null,
  get length() { return disk.size; },
};

const SAREE = {
  id: "9de8314b-2b6d-4af0-81a5-25c3e8499334",
  slug: "black-line-border",
  name: "Black Line Border Saree",
  price_inr: 1399,
  image_url: null,
  size: "One Size",
  available: 3,
};
const KEY = "wovenne-cart";
const savedBag = (items: unknown[], ownerId: string | null = null) =>
  JSON.stringify({ state: { items, ownerId }, version: 1 });

/** A fresh copy of the store module — what a page load gets. */
let loads = 0;
async function freshStore() {
  const url = pathToFileURL(`${process.cwd()}/lib/store.ts`).href + `?load=${++loads}`;
  return (await import(url)) as typeof import("../lib/store");
}

(async () => {
  const React = (await import("react")).default;
  // tsx compiles the app's JSX with the classic transform; the other render
  // tests (nav-parent-trigger, catalogue-discovery) provide React the same way.
  (globalThis as { React?: typeof React }).React = React;
  const { renderToString } = await import("react-dom/server");
  const { useHydrated } = await import("../lib/useHydrated");

  console.log("\n1. the hydration render uses the server snapshot");
  const Probe = () => React.createElement("i", null, String(useHydrated()));
  t("useHydrated() is false while rendering on the server", renderToString(React.createElement(Probe)) === "<i>false</i>");
  const hook = fs.readFileSync("lib/useHydrated.ts", "utf8");
  t("…built on useSyncExternalStore: server snapshot false, client snapshot true",
    /useSyncExternalStore\(\s*subscribe,\s*\(\) => true,\s*\(\) => false\s*\)/.test(hook));
  t("…with nothing to subscribe to (no polling, no listeners)", /const subscribe = \(\) => \(\) => \{\};/.test(hook));

  console.log("\n2. the cart page's first render does not depend on the saved bag");
  // The store module is shared by the page; seed storage, then load both.
  disk.set(KEY, savedBag([{ ...SAREE, quantity: 2 }]));
  const full = await freshStore();
  t("the store itself DID rehydrate the saved bag (the browser's situation)",
    full.useCartStore.getState().items.length === 1 && full.useCartStore.getState().totalItems() === 2);
  const CartPage = (await import("../app/(storefront)/in/cart/page")).default;
  const withBag = renderToString(React.createElement(CartPage));
  full.useCartStore.setState({ items: [] });
  const withoutBag = renderToString(React.createElement(CartPage));
  t("cart page HTML is identical with a full and an empty bag", withBag === withoutBag);
  t("…and names no item", !withBag.includes("Black Line Border"));
  t("…and does not claim the bag is empty", !/bag is empty/i.test(withBag));
  t("…but renders a placeholder that keeps the page's place", /aria-busy="true"/.test(withBag) && /min-h-\[16rem\]/.test(withBag));

  console.log("\n3. every component that prints cart contents during hydration is gated");
  const nav = fs.readFileSync("components/layout/NavbarClient.tsx", "utf8");
  const page = fs.readFileSync("app/(storefront)/in/cart/page.tsx", "utf8");
  const form = fs.readFileSync("components/cart/CheckoutForm.tsx", "utf8");
  t("navbar badge counts nothing until hydrated", /const totalItems = hydrated \? cartCount : 0;/.test(nav));
  t("navbar still reads the live count after hydration", /useCartStore\(\(s\) => s\.totalItems\(\)\)/.test(nav));
  t("cart page waits for hydration before items/empty", /\{!hydrated \? \(/.test(page));
  t("checkout form waits for hydration before items/empty",
    /if \(!hydrated\) \{\s*return <div className="mt-10 min-h-\[24rem\]" aria-busy="true" \/>;/.test(form));
  t("…and that return sits after every hook in the form",
    form.indexOf("if (!hydrated)") > form.lastIndexOf("useState(") && form.indexOf("if (!hydrated)") > form.lastIndexOf("useHydrated()"));
  for (const [name, src] of [["NavbarClient", nav], ["cart page", page], ["CheckoutForm", form]] as const) {
    t(`${name} does not hide the problem with suppressHydrationWarning`, !src.includes("suppressHydrationWarning"));
  }
  const drawer = fs.readFileSync("components/cart/CartDrawer.tsx", "utf8");
  t("the drawer needs no gate: it renders nothing until opened, and open is never persisted",
    /if \(!isOpen\) return null;/.test(drawer) && /partialize: \(state\) => \(\{ items: state\.items, ownerId: state\.ownerId \}\)/.test(fs.readFileSync("lib/store.ts", "utf8")));

  console.log("\n4. cart behaviour is unchanged");
  disk.clear();
  let s = await freshStore();
  s.useCartStore.getState().addItem(SAREE);
  t("add → one line, quantity 1", JSON.stringify(s.useCartStore.getState().items.map((i) => i.quantity)) === "[1]");
  t("add → persisted to storage", JSON.parse(disk.get(KEY)!).state.items.length === 1);
  s.useCartStore.getState().addItem(SAREE);
  t("adding the same piece again merges, no duplicate line",
    s.useCartStore.getState().items.length === 1 && s.useCartStore.getState().items[0].quantity === 2);
  s = await freshStore();
  t("reload: the bag comes back from storage", s.useCartStore.getState().totalItems() === 2);
  t("reload: no duplicate lines created by rehydration", s.useCartStore.getState().items.length === 1);
  t("reload: the stored blob holds only items and owner", JSON.stringify(Object.keys(JSON.parse(disk.get(KEY)!).state).sort()) === '["items","ownerId"]');
  s.useCartStore.getState().updateQuantity(SAREE.id, SAREE.size, 3);
  t("update quantity up (within the hint)", s.useCartStore.getState().items[0].quantity === 3);
  s.useCartStore.getState().updateQuantity(SAREE.id, SAREE.size, 9);
  t("update quantity beyond the hint is capped", s.useCartStore.getState().items[0].quantity === 3);
  s.useCartStore.getState().updateQuantity(SAREE.id, SAREE.size, 1);
  t("update quantity down", s.useCartStore.getState().items[0].quantity === 1);
  s.useCartStore.getState().removeItem(SAREE.id, SAREE.size);
  t("remove → empty, and persisted empty", s.useCartStore.getState().items.length === 0 && JSON.parse(disk.get(KEY)!).state.items.length === 0);
  s.useCartStore.getState().addItem(SAREE);
  s.useCartStore.getState().claimFor("user-a");
  s = await freshStore();
  t("a signed-in owner survives reload", s.useCartStore.getState().ownerId === "user-a" && s.useCartStore.getState().items.length === 1);
  s.useCartStore.getState().resetForSignOut();
  t("sign-out empties and disowns the bag", s.useCartStore.getState().items.length === 0 && s.useCartStore.getState().ownerId === null);
  s = await freshStore();
  t("…and it stays empty after reload", s.useCartStore.getState().items.length === 0 && s.useCartStore.getState().ownerId === null);
  disk.set(KEY, JSON.stringify({ state: { items: [{ ...SAREE, quantity: 1 }] } }));
  s = await freshStore();
  t("a legacy (ownerless) bag is still flushed on load", s.useCartStore.getState().items.length === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
