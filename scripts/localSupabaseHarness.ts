/**
 * A synthetic PostgREST-like HTTP server for order boundary tests.
 *
 * Real: the application order executors, installed supabase-js and HTTP.
 * Simulated: PostgreSQL, PostgREST, authentication, roles, RLS and schema.
 * Implements only the email/id equality, selection, ordering and limit behavior
 * used by these tests. Filters are applied only when received, so omitting the
 * application's customer filter exposes foreign synthetic rows to the tests.
 *
 * This is application-layer regression evidence, not real-backend proof.
 * Run a real local Supabase/PostgREST suite before claiming that broader proof.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

// ══ Local-only guard ══════════════════════════

/** Hosts this harness will ever talk to. Everything else is refused. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class NotLocalError extends Error {}

/**
 * Refuse to proceed unless the target is unambiguously loopback.
 *
 * ══ FAIL CLOSED, AND NOT ON NODE_ENV ══
 *
 * `NODE_ENV=test` is a claim about intent. It is set by whoever launched the
 * process, it is trivially wrong, and it has no relationship to which database
 * a URL points at. The only question worth asking is the literal one: is this
 * host loopback? Anything else — a production Supabase hostname, a Vercel URL,
 * a staging box, an empty string — throws before a single byte is written.
 *
 * Checked before client setup and for each fetch. Fixtures exist only in memory.
 */
export function assertLocalOnly(url: string | undefined, context: string): URL {
  if (!url || url.trim() === "") {
    throw new NotLocalError(`${context}: no Supabase URL configured — refusing to guess`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NotLocalError(`${context}: invalid URL — refusing`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname) || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new NotLocalError(
      `${context}: target must be HTTP(S) loopback without embedded credentials`
    );
  }
  return parsed;
}

// ══ External-network block ════════════════════

export interface NetworkLog {
  allowed: string[];
  blocked: string[];
  restore: () => void;
}

/**
 * Allow loopback, refuse the internet.
 *
 * supabase-js uses global fetch, so that is the surface that matters. Every
 * request is recorded either way, which is what lets the report state the
 * loopback connections rather than merely assert their absence elsewhere.
 */
export function blockExternalNetwork(): NetworkLog {
  const realFetch = globalThis.fetch;
  const log: NetworkLog = {
    allowed: [],
    blocked: [],
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    let host = "";
    try {
      host = new URL(raw).hostname;
    } catch {
      /* relative or malformed — treated as external below */
    }
    if (!LOCAL_HOSTS.has(host)) {
      log.blocked.push(raw);
      throw new Error(`EXTERNAL NETWORK BLOCKED: ${raw}`);
    }
    assertLocalOnly(raw, "fetch");
    log.allowed.push(raw);
    // Do not follow a local redirect to an unchecked external destination.
    return realFetch(input as RequestInfo, { ...init, redirect: "error" });
  }) as typeof fetch;

  return log;
}

// ══ Synthetic rows ════════════════════════════

/** Only the columns runOrderTool actually selects. Nothing copied from production. */
export interface SyntheticOrder {
  id: string;
  customer_email: string;
  created_at: string;
  status: string;
  payment_status: string;
  total_inr: number;
  items: { name?: string; quantity?: number; size?: string }[] | null;
  courier_name: string | null;
  awb_number: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  invoice_number: string | null;
}

export interface CapturedRequest {
  method: string;
  path: string;
  table: string;
  /** Every PostgREST filter that arrived, e.g. `customer_email=eq.alice…`. */
  filters: string[];
  select: string | null;
  order: string | null;
  limit: string | null;
  /** Whether an Authorization header was present. The value is never recorded. */
  hadAuthHeader: boolean;
}

export interface LocalPostgrest {
  url: string;
  requests: CapturedRequest[];
  rows: SyntheticOrder[];
  close: () => Promise<void>;
}

/**
 * A loopback server that speaks enough PostgREST to serve `orders`.
 *
 * ══ IT FILTERS ONLY BY WHAT IT IS ACTUALLY SENT ══
 *
 * This is the property that makes the test meaningful rather than decorative.
 * The server applies `customer_email=eq.X` only if that filter arrives in the
 * query string. It has no notion of a "current customer" and cannot supply one.
 *
 * So if runOrderTool ever stopped scoping by the trusted email — or scoped by
 * something the model supplied instead — this server would happily return every
 * synthetic row, and the cross-customer assertions would fail. The test cannot
 * pass by accident.
 */
export async function startLocalPostgrest(rows: SyntheticOrder[]): Promise<LocalPostgrest> {
  const requests: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const table = url.pathname.replace(/^\/rest\/v1\//, "");

    const filters: string[] = [];
    let emailEq: string | null = null;
    let idEq: string | null = null;
    for (const [key, value] of url.searchParams.entries()) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      filters.push(`${key}=${value}`);
      if (key === "customer_email" && value.startsWith("eq.")) {
        emailEq = value.slice(3);
      }
      if (key === "id" && value.startsWith("eq.")) idEq = value.slice(3);
    }

    requests.push({
      method: req.method ?? "GET",
      path: url.pathname + url.search,
      table,
      filters,
      select: url.searchParams.get("select"),
      order: url.searchParams.get("order"),
      limit: url.searchParams.get("limit"),
      // Recorded as a boolean only. A test that prints a service key is a test
      // that leaks one.
      hadAuthHeader: Boolean(req.headers.authorization || req.headers.apikey),
    });

    if (table !== "orders") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `no such table: ${table}` }));
      return;
    }

    // ── The filter, applied exactly as received ──
    let result = rows;
    if (emailEq !== null) {
      result = result.filter((r) => r.customer_email === emailEq);
    }
    if (idEq !== null) result = result.filter((r) => r.id === idEq);

    const order = url.searchParams.get("order");
    if (order?.startsWith("created_at.desc")) {
      result = [...result].sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    const limit = Number(url.searchParams.get("limit") ?? "0");
    if (Number.isFinite(limit) && limit > 0) result = result.slice(0, limit);

    res.writeHead(200, { "Content-Type": "application/json" });
    const select = url.searchParams.get("select");
    const projected = result.map((row) => select && select !== "*"
      ? Object.fromEntries(select.split(",").map((column) => [column.trim(), row[column.trim() as keyof SyntheticOrder]]))
      : row);
    const single = req.headers.accept?.includes("application/vnd.pgrst.object+json");
    res.end(JSON.stringify(single ? projected[0] ?? null : projected));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    rows,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
