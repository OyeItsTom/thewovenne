import {
  INTERNAL_COOKIE,
  MAX_BODY_BYTES,
  OPT_OUT_COOKIE,
  callerIp,
  deploymentMode,
  deviceFor,
  geoFor,
  isBot,
  optedOut,
  parseBatch,
  rateKey,
  type CleanEvent,
} from "./analyticsCollect";

/**
 * The body of POST /api/events, with its collaborators passed in so the whole
 * path — deployment, size, origin, opt-out, bots, staff, rate limit, the
 * database switch — is tested without a server or a database.
 *
 * Status codes are for tests and logs; the browser ignores the response.
 *   204  stored, or deliberately not stored (preview/local, switched off in
 *        the database, opted out, a bot)
 *   400  malformed       403  another site     405  not POST
 *   413  too large       429  rate limited     503  database refused
 */
export interface IngestContext {
  device: "mobile" | "tablet" | "desktop" | null;
  country_code: string | null;
  region: string | null;
  traffic: "customer" | "internal" | "test";
}

export interface IngestResult {
  collecting: boolean;
  accepted: number;
  duplicates: number;
  skipped: number;
  limited: boolean;
}

export interface EventsDeps {
  env: Record<string, string | undefined>;
  /** Server-only secret for the rate key. */
  secret: string;
  ingest: (rateKey: string, context: IngestContext, events: CleanEvent[]) => Promise<IngestResult>;
}

export interface EventsRequest {
  method: string;
  url: string;
  headers: Headers;
  cookie: (name: string) => string | undefined;
  text: () => Promise<string>;
}

const empty = (status: number) => new Response(null, { status });

export async function handleEvents(req: EventsRequest, deps: EventsDeps): Promise<Response> {
  if (req.method !== "POST") return empty(405);
  const mode = deploymentMode(deps.env);
  // A preview or local build shares the production database; it never asks.
  if (mode === "off") return empty(204);
  if (!deps.secret) return empty(503);

  // Same-site only. A beacon from our own pages carries our Origin; a form on
  // someone else's site would carry theirs.
  const origin = req.headers.get("origin");
  if (origin) {
    let sameSite = false;
    try {
      sameSite = new URL(origin).host === new URL(req.url).host;
    } catch {
      // "null" (a sandboxed frame) or garbage: not us.
    }
    if (!sameSite) return empty(403);
  }

  // The visitor objected. The browser client already sends nothing in this
  // case; this is the server honouring it even if a page (an old tab, a
  // cached script) does not.
  if (optedOut(req.cookie(OPT_OUT_COOKIE), req.headers.get("sec-gpc"))) return empty(204);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return empty(413);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return empty(413);

  const userAgent = req.headers.get("user-agent");
  if (isBot(userAgent)) return empty(204);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return empty(400);
  }
  const parsed = parseBatch(body);
  if (!parsed.ok) return empty(400);

  const context: IngestContext = {
    device: deviceFor(userAgent),
    ...geoFor(req.headers),
    traffic:
      mode === "test"
        ? "test"
        : // Set on any browser that has completed an admin sign-in (middleware).
          // Claiming it only hides your own traffic, so it needs no protection.
          req.cookie(INTERNAL_COOKIE) === "1"
          ? "internal"
          : "customer",
  };

  try {
    const result = await deps.ingest(rateKey(callerIp(req.headers), deps.secret), context, parsed.events);
    return empty(result.limited ? 429 : 204);
  } catch (err) {
    console.error("analytics ingest:", err instanceof Error ? err.message : err);
    return empty(503);
  }
}
