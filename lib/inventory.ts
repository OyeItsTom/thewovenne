import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Live stock, changed on purpose — migration 0060.
 *
 * Stock is not content. A draft describes a product; it does not decide how
 * many are on the shelf once the product is live, and publishing a draft never
 * changes that number. The two ways to change it are here, and both go live
 * immediately:
 *
 *   setProductStock   an unsized product's count
 *   sizeChanges       what the product form changed about a sized product's
 *                     sizes, for save_product_sizes
 *
 * Both send the figure the admin was LOOKING AT. If the shelf has moved since —
 * a sale, a cancellation, another admin — the database refuses and nothing
 * changes, rather than quietly writing a stale number over a newer one.
 */

/** A size as the form loaded it from the database. */
export interface LoadedSize {
  id: string;
  label: string;
  stock_quantity: number;
}

/** A size as it stands in the form. No id means it was added in the form. */
export interface EditedSize {
  id?: string;
  label: string;
  stock_quantity: number;
}

export type SizeChange =
  | { id: string; label: string; stock_quantity: number; expected: number }
  | { label: string; stock_quantity: number }
  | { id: string; label: string; remove: true; expected: number };

const key = (label: string) => label.trim().toLowerCase();
const count = (n: unknown) => Math.max(0, Math.floor(Number(n) || 0));

/**
 * What to send save_product_sizes for the form's sizes, given what it loaded.
 *
 * Returns [] when nothing about the sizes changed, so a save that only touched
 * the description does not call the function at all. Throws on a duplicate
 * label, which the admin has to resolve.
 *
 * Every size the form loaded goes out with `expected` — the count it showed. A
 * count the admin did not touch goes out equal to its expected, which the
 * database reads as "leave the shelf alone"; that is what stops an open form
 * from restocking a size that sold while it was open.
 *
 * A loaded size that is removed and a size of the same name added back is one
 * size edited, not a removal and a restock.
 *
 * Every existing size goes out with the id of the row the form loaded. The
 * database refuses one that is not this product's, so a payload can only ever
 * touch the sizes it was built from (migration 0060).
 */
export function sizeChanges(loaded: LoadedSize[], edited: EditedSize[]): SizeChange[] {
  const rows = edited
    .map((s) => ({ id: s.id, label: s.label.trim(), stock_quantity: count(s.stock_quantity) }))
    .filter((s) => s.label.length > 0);

  const seen = new Set<string>();
  for (const s of rows) {
    if (seen.has(key(s.label))) throw new Error(`"${s.label}" is listed twice.`);
    seen.add(key(s.label));
  }

  const byId = new Map(loaded.map((l) => [l.id, l]));
  const byKey = new Map(loaded.map((l) => [key(l.label), l]));

  // Each loaded size is claimed by at most one form row: its own (same id,
  // same name) or, failing that, any form row now carrying its name.
  const claimed = new Map<string, LoadedSize>();
  for (const r of rows) {
    const own = r.id ? byId.get(r.id) : undefined;
    if (own && key(own.label) === key(r.label)) claimed.set(key(r.label), own);
  }
  for (const r of rows) {
    const named = byKey.get(key(r.label));
    if (named && !claimed.has(key(r.label))) claimed.set(key(r.label), named);
  }
  const claimedIds = new Set([...claimed.values()].map((l) => l.id));

  const removals: SizeChange[] = loaded
    .filter((l) => !claimedIds.has(l.id))
    .map((l) => ({ id: l.id, label: l.label, remove: true as const, expected: l.stock_quantity }));

  const writes: SizeChange[] = rows.map((r) => {
    const was = claimed.get(key(r.label));
    return was
      ? { id: was.id, label: r.label, stock_quantity: r.stock_quantity, expected: was.stock_quantity }
      : { label: r.label, stock_quantity: r.stock_quantity };
  });

  const untouched =
    removals.length === 0 &&
    rows.length === loaded.length &&
    rows.every((r, i) => {
      const l = loaded[i];
      return r.id === l.id && r.label === l.label && r.stock_quantity === l.stock_quantity;
    });

  return untouched ? [] : [...removals, ...writes];
}

/** What went wrong, in words, from one of the stock functions' refusals. */
export function stockErrorMessage(raw: string): { message: string; live: number | null } {
  let m = /STOCK_CHANGED:([^:]+):gone/.exec(raw);
  if (m) {
    return {
      message: `Size ${m[1]} was removed by someone else while this was open. Nothing in the sizes was saved — reopen the product to see the current sizes.`,
      live: null,
    };
  }
  m = /STOCK_CHANGED:([^:]+):(-?\d+)/.exec(raw);
  if (m) {
    return {
      message: `Size ${m[1]} now has ${m[2]} in stock — it changed while this was open (a sale, a cancellation or another admin). Nothing in the sizes was saved, so that change was not overwritten. Reopen the product to see the current counts.`,
      live: Number(m[2]),
    };
  }
  m = /STOCK_CHANGED:(-?\d+)/.exec(raw);
  if (m) {
    return {
      message: `Stock is now ${m[1]} — it changed since this was loaded (a sale, a cancellation or another admin). Nothing was changed, so that change was not overwritten.`,
      live: Number(m[1]),
    };
  }
  m = /DUPLICATE_SIZE:(.+)/.exec(raw);
  if (m) return { message: `"${m[1].trim()}" is listed twice.`, live: null };
  m = /NEGATIVE_STOCK(?::(.+))?/.exec(raw);
  if (m) return { message: `Stock${m[1] ? ` for ${m[1]}` : ""} can't be below zero.`, live: null };
  if (/EXPECTED_REQUIRED/.test(raw)) {
    return { message: "This page is out of date. Reload it and try again.", live: null };
  }
  if (/SIZED_PRODUCT/.test(raw)) {
    return { message: "This product has sizes — change its stock size by size in the product form.", live: null };
  }
  m = /SIZE_MISMATCH:(.+)/.exec(raw);
  if (m) {
    return { message: `Size ${m[1].trim()} no longer matches what this form loaded. Nothing in the sizes was saved — reopen the product.`, live: null };
  }
  if (/REQUEST_ID_REUSED/.test(raw)) {
    return { message: "That save could not be matched to the change it claimed to be. Nothing was changed — try again.", live: null };
  }
  if (/STOCK_IS_LIVE/.test(raw)) {
    return { message: "Stock on a live product is changed on the shelf, not in a draft. This page is out of date — reload it.", live: null };
  }
  if (/VERSION_STATE_LOCKED/.test(raw)) {
    return { message: "Products go live only through Publish. This page is out of date — reload it.", live: null };
  }
  if (/LIVE_STOCK_LOCKED/.test(raw)) {
    return { message: "Live stock can only be changed through the stock field. Reload and try again.", live: null };
  }
  return { message: raw, live: null };
}

export type StockStatus = "applied" | "unchanged" | "already_applied" | "opening_stock";

export type StockResult =
  | { ok: true; status: StockStatus; quantity: number }
  | { ok: false; message: string; live: number | null };

/**
 * Set an unsized product's stock to `quantity`, provided it is still
 * `expected` — the figure the admin was shown.
 *
 * Each call is one attempt with its own request id. A retry of THE SAME attempt
 * (pass the same id) is recognised and changes nothing; a new attempt is
 * checked against the shelf afresh.
 */
export async function setProductStock(
  client: SupabaseClient,
  productId: string,
  expected: number,
  quantity: number,
  opts: { requestId?: string; note?: string } = {}
): Promise<StockResult> {
  const { data, error } = await client.rpc("set_product_stock", {
    p_product_id: productId,
    p_expected: expected,
    p_quantity: quantity,
    p_request_id: opts.requestId ?? crypto.randomUUID(),
    p_note: opts.note ?? null,
  });
  if (error) return { ok: false, ...stockErrorMessage(error.message) };
  const r = data as { status: StockStatus; quantity: number };
  return { ok: true, status: r.status, quantity: Number(r.quantity) };
}
