import {
  CONSENT_COOKIE,
  INTERNAL_COOKIE,
  MAX_BODY_BYTES,
  VISITOR_COOKIE,
  callerIp,
  collectionEnabled,
  deviceFor,
  geoFor,
  hasAnalyticsConsent,
  isBot,
  parseBatch,
  rateKey,
  visitorIdFor,
  type CleanEvent,
} from "./analyticsCollect";

/**
 * The body of POST /api/events, with its collaborators passed in so the whole
 * path — environment, size, origin, bots, consent, identity, rate limit — is
 * tested without a server or a database.
 *
 * Status codes are for tests and logs; the browser ignores the response.
 *   204  stored, or deliberately not stored (switched off, preview, a bot)
 *   400  malformed       403  another site     405  not POST
 *   413  too large       429  rate limited     503  database refused
 */
export interface IngestContext {
  visitor_id: string | null;
  user_id: string | null;
  device: "mobile" | "tablet" | "desktop" | null;
  country_code: string | null;
  region: string | null;
  traffic: "customer" | "internal";
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  skipped: number;
  limited: boolean;
}

export interface EventsDeps {
  env: Record<string, string | undefined>;
  /** Server-only secret for the rate key. */
  secret: string;
  /** The signed-in user, validated against Supabase Auth. Only asked with consent. */
  getUserId: () => Promise<string | null>;
  ingest: (rateKey: string, context: IngestContext, events: CleanEvent[]) => Promise<IngestResult>;
}

export interface EventsRequest {
  method: string;
  url: string;
  headers: Headers;
  cookie: (name: string) => string | undefined;
  hasAuthCookie: boolean;
  text: () => Promise<string>;
}

const empty = (status: number) => new Response(null, { status });

export async function handleEvents(req: EventsRequest, deps: EventsDeps): Promise<Response> {
  if (req.method !== "POST") return empty(405);
  if (!collectionEnabled(deps.env)) return empty(204);
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

  const consent = req.cookie(CONSENT_COOKIE);
  const consented = hasAnalyticsConsent(consent);
  // Identity only with consent, and only from a session Supabase vouches for.
  // The body cannot carry one — parseBatch refuses the key.
  const userId = consented && req.hasAuthCookie ? await deps.getUserId().catch(() => null) : null;

  const context: IngestContext = {
    visitor_id: visitorIdFor(consent, req.cookie(VISITOR_COOKIE)),
    user_id: userId,
    device: deviceFor(userAgent),
    ...geoFor(req.headers),
    // Set on any browser that has completed an admin sign-in (middleware).
    // Claiming it only hides your own traffic, so it needs no protection.
    traffic: req.cookie(INTERNAL_COOKIE) === "1" ? "internal" : "customer",
  };

  try {
    const result = await deps.ingest(rateKey(callerIp(req.headers), deps.secret), context, parsed.events);
    return empty(result.limited ? 429 : 204);
  } catch (err) {
    console.error("analytics ingest:", err instanceof Error ? err.message : err);
    return empty(503);
  }
}
