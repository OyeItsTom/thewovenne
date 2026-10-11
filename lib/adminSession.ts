/**
 * The admin's PRIVILEGED session, and when it ends.
 *
 * Admin and customer share one Supabase session — one set of sb-*-auth-token
 * cookies on this domain. Supabase keeps that session alive by refreshing it,
 * and a refreshed token keeps its aal2 claim, so on its own a session that once
 * passed two-factor stays an admin session for as long as the refresh token
 * lives: close the tab, come back tomorrow, and the dashboard opens without a
 * password or a code.
 *
 * The idle timeout used to be the only thing that ended it, and it was a timer
 * in the open admin tab. A closed tab, a sleeping laptop or a detour to the
 * storefront meant the timer never ran, and nothing on the server knew the
 * difference.
 *
 * This is the server's record of admin activity: a signed, httpOnly cookie
 * holding when the admin last did something, bound to the session it was issued
 * for. Middleware (pages) and the admin API gate read it. When it is missing or
 * too old, the session is REVOKED at Supabase — not just hidden — so its
 * refresh token is dead and the next way in is password plus authenticator.
 *
 * Two cases are kept apart deliberately:
 *   A. an access token expiring mid-session — refreshed as normal, untouched here;
 *   B. idle expiry or sign-out — the session is ended, and stays ended.
 *
 * Customers are not affected: nothing here runs outside /admin and /api/admin,
 * and a customer session never reaches aal2.
 *
 * Runs in edge middleware and in Node route handlers, so it uses Web Crypto only.
 */

/** Inactivity that ends a privileged session. Matches the visible countdown. */
export const ADMIN_IDLE_MS = 15 * 60 * 1000;

/**
 * Slack on the server side of the same rule. The browser only reports activity
 * at most once a minute (HEARTBEAT_MS), so the server's "last seen" can trail the
 * admin's real last movement by up to that much. Without the slack an admin who
 * moved the mouse at 14:50 could be refused by the server before their own
 * countdown had even appeared.
 */
export const ADMIN_IDLE_GRACE_MS = 2 * 60 * 1000;

/** How often, at most, an active admin tab tells the server it is in use. */
export const HEARTBEAT_MS = 60 * 1000;

export const ADMIN_ACTIVITY_COOKIE = "wv_admin_active";

const COOKIE_VERSION = "v1";

export type AdminActivity =
  /** A recorded admin action inside the window. */
  | "active"
  /** No record yet, but the second factor was passed moments ago — a new session. */
  | "fresh-mfa"
  /** Neither: the privileged session has ended. */
  | "expired";

/**
 * The rule itself, kept pure so it can be tested without a clock or a cookie.
 *
 * `lastSeenMs` must already be verified — signature checked and bound to this
 * session — or null. `lastAuthAtSec` is the newest authentication time in the
 * token's amr claim (seconds, as Supabase writes it).
 */
export function judgeAdminActivity({
  now,
  lastSeenMs,
  lastAuthAtSec,
}: {
  now: number;
  lastSeenMs: number | null;
  lastAuthAtSec: number | null;
}): AdminActivity {
  const window = ADMIN_IDLE_MS + ADMIN_IDLE_GRACE_MS;
  if (lastSeenMs !== null && lastSeenMs <= now + 60_000 && now - lastSeenMs <= window) {
    return "active";
  }
  // The first page after the authenticator code has no activity record yet. The
  // amr timestamp says when the code was entered, and it is signed by Supabase,
  // so it can open the window — once, at the start of a session.
  if (lastAuthAtSec !== null && now - lastAuthAtSec * 1000 <= window) {
    return "fresh-mfa";
  }
  return "expired";
}

/** The parts of a Supabase access token this module needs. */
export interface TokenFacts {
  sessionId: string | null;
  aal: string | null;
  /** Newest amr timestamp, in seconds. */
  lastAuthAtSec: number | null;
}

/**
 * Read the claims of an access token WITHOUT verifying it. Only for tokens that
 * getUser() has just validated against Supabase — never on its own.
 */
export function tokenFacts(accessToken: string | null | undefined): TokenFacts {
  const none: TokenFacts = { sessionId: null, aal: null, lastAuthAtSec: null };
  if (!accessToken) return none;
  const part = accessToken.split(".")[1];
  if (!part) return none;
  try {
    const json = JSON.parse(base64UrlDecode(part)) as {
      session_id?: unknown;
      aal?: unknown;
      amr?: unknown;
    };
    const stamps = Array.isArray(json.amr)
      ? json.amr
          .map((e) => Number((e as { timestamp?: unknown })?.timestamp))
          .filter((n) => Number.isFinite(n))
      : [];
    return {
      sessionId: typeof json.session_id === "string" ? json.session_id : null,
      aal: typeof json.aal === "string" ? json.aal : null,
      lastAuthAtSec: stamps.length ? Math.max(...stamps) : null,
    };
  } catch {
    return none;
  }
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  let bin = "";
  new Uint8Array(bytes).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The signing key. A dedicated secret if one is configured, otherwise derived
 * from the service-role key, which already lives only on the server. With
 * neither, nothing can be signed or verified — and every privileged session
 * then ends a window's length after its second factor, which fails safe.
 */
function secret(): string | null {
  return process.env.ADMIN_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

async function sign(payload: string): Promise<string | null> {
  const s = secret();
  if (!s) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`wovenne-admin-activity:${s}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

/** Constant-time comparison, so a forged signature can't be found a byte at a time. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function mintActivityCookie(sessionId: string, now: number): Promise<string | null> {
  const payload = `${COOKIE_VERSION}.${sessionId}.${now}`;
  const sig = await sign(payload);
  return sig ? `${payload}.${sig}` : null;
}

/**
 * The verified "last seen" time, or null if the cookie is absent, malformed,
 * forged, or was issued for a different session.
 */
export async function readActivityCookie(
  value: string | undefined,
  sessionId: string | null
): Promise<number | null> {
  if (!value || !sessionId) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [version, sid, at, sig] = parts;
  if (version !== COOKIE_VERSION || sid !== sessionId || !/^\d{1,16}$/.test(at)) return null;
  const expected = await sign(`${version}.${sid}.${at}`);
  if (!expected || !sameString(expected, sig)) return null;
  return Number(at);
}

/** Cookie attributes. Lax, not Strict: an emailed link to /admin must not look like an expired session. */
export const activityCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: Math.floor((ADMIN_IDLE_MS + ADMIN_IDLE_GRACE_MS) / 1000),
};

/** The full verdict for a request, from its validated access token and cookie. */
export async function assessAdminActivity(
  accessToken: string | null | undefined,
  cookieValue: string | undefined,
  now = Date.now()
): Promise<{ activity: AdminActivity; facts: TokenFacts; lastSeenMs: number | null }> {
  const facts = tokenFacts(accessToken);
  const lastSeenMs = await readActivityCookie(cookieValue, facts.sessionId);
  return {
    activity: judgeAdminActivity({ now, lastSeenMs, lastAuthAtSec: facts.lastAuthAtSec }),
    facts,
    lastSeenMs,
  };
}

/** Supabase's own session cookies: sb-<ref>-auth-token, and its .0/.1 chunks. */
export function isSupabaseAuthCookie(name: string): boolean {
  return /^sb-.+-auth-token(\.\d+)?$/.test(name);
}
