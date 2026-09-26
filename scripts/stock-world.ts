/**
 * Products, drafts, orders and sales for the 0060 tests — made through the real
 * functions, as the roles that call them in production: the admin through RLS
 * and its RPCs, checkout as service_role. Only the order row itself is inserted
 * directly, because in production that is the checkout route's own insert.
 */
import { asAdmin, asRoot, asService, type Client } from "./pg-world";

export interface Live {
  productId: string;
  slug: string;
}

let n = 0;

/** A published product. Unsized unless `sizes` is given. */
export async function liveProduct(
  c: Client,
  admin: string,
  opts: { stock?: number; sizes?: { label: string; stock_quantity: number }[]; slug?: string } = {}
): Promise<Live> {
  n += 1;
  const slug = opts.slug ?? `piece-${process.pid}-${n}`;
  await asAdmin(c, admin);
  const vid = (await c.query("select public.create_product_draft() id")).rows[0].id as string;
  const { rows } = await c.query(
    `update product_versions
        set name = $2, slug = $3, price_inr = 2500, cost_price_inr = 900, sku = upper($3),
            stock_quantity = $4, description = 'A handloom piece.'
      where id = $1
      returning product_id`,
    [vid, `Piece ${n}`, slug, opts.stock ?? 0]
  );
  const productId = rows[0].product_id as string;
  // A photograph, so every later draft forks with a gallery and publishes the
  // way a real product does. allow_no_images deliberately resets on each new
  // draft (0042), so it cannot stand in for one.
  await asRoot(c);
  await c.query(
    "insert into product_images (product_version_id, product_id, url, sort_order) values ($1, $2, 'https://example.test/p.jpg', 0)",
    [vid, productId]
  );
  await asAdmin(c, admin);
  await c.query("select public.publish_one('product', $1)", [productId]);
  if (opts.sizes) {
    await c.query("select public.save_product_sizes($1, $2::jsonb)", [productId, JSON.stringify(opts.sizes)]);
  }
  await asRoot(c);
  return { productId, slug };
}

/** What the product form does for a descriptive edit: fork a draft, change the name. */
export async function nameOnlyDraft(c: Client, admin: string, productId: string, name: string) {
  await asAdmin(c, admin);
  const vid = (await c.query("select public.ensure_product_draft($1) id", [productId])).rows[0].id as string;
  await c.query("update product_versions set name = $2 where id = $1", [vid, name]);
  await asRoot(c);
  return vid;
}

export async function paidOrder(
  c: Client,
  items: { id: string; size?: string | null; quantity: number; name?: string }[]
): Promise<string> {
  await asRoot(c);
  const { rows } = await c.query(
    `insert into orders (items, total_inr, payment_status, status, customer_email)
     values ($1::jsonb, 2500, 'paid', 'placed', 'buyer@example.test') returning id`,
    [JSON.stringify(items.map((i) => ({ ...i, size: i.size ?? "One Size", price_inr: 2500 })))]
  );
  return rows[0].id as string;
}

/** Settlement's call, exactly: service_role, the order's lines, the order id. */
export async function sell(
  c: Client,
  orderId: string,
  items: { id: string; size?: string | null; quantity: number }[]
) {
  await asService(c);
  try {
    return (await c.query("select public.reserve_stock($1::jsonb, $2) r", [
      JSON.stringify(items.map((i) => ({ id: i.id, size: i.size ?? "One Size", quantity: i.quantity }))),
      orderId,
    ])).rows[0].r as { reserved: number; already_reserved: number };
  } finally {
    await asRoot(c);
  }
}

export async function liveRow(c: Client, productId: string) {
  await asRoot(c);
  const { rows } = await c.query(
    `select pv.id, pv.version, pv.name, pv.slug, pv.price_inr::text, pv.cost_price_inr::text, pv.sku,
            pv.stock_quantity, p.stock_quantity as mirror, p.slug as identity_slug, p.id as identity
       from product_versions pv join products p on p.id = pv.product_id
      where pv.product_id = $1 and pv.state = 'published'`,
    [productId]
  );
  return rows[0] as {
    id: string; version: number; name: string; slug: string; price_inr: string;
    cost_price_inr: string; sku: string; stock_quantity: number; mirror: number;
    identity_slug: string; identity: string;
  } | undefined;
}

export async function sizesOf(c: Client, productId: string) {
  const { rows } = await c.query(
    "select label, stock_quantity from product_sizes where product_id = $1 order by sort_order, label",
    [productId]
  );
  return Object.fromEntries(rows.map((r) => [r.label as string, r.stock_quantity as number]));
}

export async function movements(c: Client, productId: string) {
  const { rows } = await c.query(
    // request_id through to_jsonb: the column only exists from 0060, and the
    // control runs read a database from before it.
    `select reason, size_label, delta, order_id, (to_jsonb(m) ->> 'request_id')::uuid as request_id, actor_id
       from stock_movements m where product_id = $1 order by created_at, id`,
    [productId]
  );
  return rows as { reason: string; size_label: string | null; delta: number; order_id: string | null;
                   request_id: string | null; actor_id: string | null }[];
}

export const sum = (ms: { delta: number }[]) => ms.reduce((s, m) => s + m.delta, 0);
