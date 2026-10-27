import { RECOVERY_WINDOW_SECONDS, recoverySessionOpen, tokenClaims } from "./signInMethods";

/**
 * Cross-device password recovery (WP-OPS-01C).
 *
 * THE OLD LINK only worked in the browser that asked for it. The browser client
 * is PKCE (forced by @supabase/ssr), so asking for a reset stores a code
 * verifier in THAT browser's cookies; the emailed link is spent by Supabase on
 * first open and comes back as `?code=`, which nothing but the asking browser
 * can exchange. On a phone, or in a mail app's own browser, the page simply had
 * no session, and a timer called that "expired".
 *
 * THE NEW LINK carries the recovery token hash in the URL FRAGMENT:
 *
 *   https://www.thewovenne.com/in/reset-password#token_hash=…&type=recovery
 *
 * The page does nothing with it until the customer presses Continue, and only
 * then calls verifyOtp({ token_hash, type: "recovery" }) — Supabase's supported
 * recovery check, which works on any device and spends the token (GoTrue's
 * Recover() clears every one-time token for the user). A fragment never reaches
 * a server, a log or a Referer, and opening the page — by a person, a link
 * preview or a mail scanner — spends nothing.
 *
 * WHY THE PROOF IS KEPT HERE. A session made by verifyOtp is stamped `amr: otp`
 * by GoTrue, the same stamp as a signup code. `otp` alone therefore cannot open
 * the form, or a fresh signup would. Instead the page keeps a RecoveryProof in
 * memory — made only from the session verifyOtp(type "recovery") just returned,
 * bound to that user and that session, and lapsing with the same 15-minute
 * window. It is never persisted: a refresh loses it, and the token is already
 * spent, so the customer is honestly asked for a new link.
 *
 * Nothing here logs, stores or sends the token anywhere but to verifyOtp.
 */

/**
 * GoTrue writes `{{ .TokenHash }}` as hex sha224 (56 characters), prefixed with
 * `pkce_` when the reset was asked for by a PKCE client — which this app's is.
 * The range leaves room for a future hash without accepting junk; Supabase is
 * the real judge.
 */
const TOKEN_HASH = /^(pkce_)?[0-9a-f]{32,128}$/i;

/** No genuine recovery fragment is anywhere near this long. */
const MAX_FRAGMENT = 512;

export type RecoveryLink =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "token"; tokenHash: string };

export interface RecoveryUrl {
  link: RecoveryLink;
  /** Supabase redirected here with an error (a spent or expired old link). */
  supabaseError: boolean;
  /** An old-style PKCE `?code=`, which only the asking browser can use. */
  legacyCode: boolean;
}

const ERROR_PARAMS = ["error", "error_code", "error_description"];
/** Fragment keys that mean the fragment holds something to remove. */
const SECRET_FRAGMENT_KEYS = ["token_hash", "access_token", "refresh_token", "provider_token", ...ERROR_PARAMS];
/** Query keys removed from the address bar once read. */
const SECRET_QUERY_KEYS = ["code", "token_hash", ...ERROR_PARAMS];

function fragmentOf(url: URL): string {
  return url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
}

export function parseRecoveryUrl(href: string): RecoveryUrl {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { link: { kind: "none" }, supabaseError: false, legacyCode: false };
  }
  const fragment = fragmentOf(url);
  const hash = new URLSearchParams(fragment);
  const query = url.searchParams;

  let link: RecoveryLink = { kind: "none" };
  const tokens = hash.getAll("token_hash");
  if (tokens.length > 0 || query.has("token_hash")) {
    const types = hash.getAll("type");
    const valid =
      fragment.length <= MAX_FRAGMENT &&
      tokens.length === 1 &&
      types.length === 1 &&
      types[0] === "recovery" &&
      TOKEN_HASH.test(tokens[0]);
    // A token in the QUERY is refused, not used: a query string reaches the
    // server and its logs, which is exactly what the fragment avoids.
    link = valid && !query.has("token_hash") ? { kind: "token", tokenHash: tokens[0] } : { kind: "malformed" };
  }

  return {
    link,
    supabaseError: ERROR_PARAMS.some((k) => query.has(k) || hash.has(k)),
    legacyCode: query.has("code"),
  };
}

/**
 * The same address without anything secret: the fragment goes whole if it
 * holds a token or an auth error, and `code`/`token_hash`/error keys leave the
 * query. Null when there is nothing to remove.
 */
export function urlWithoutAuthParams(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let changed = false;
  const hash = new URLSearchParams(fragmentOf(url));
  if (url.hash && SECRET_FRAGMENT_KEYS.some((k) => hash.has(k))) {
    url.hash = "";
    changed = true;
  }
  const hadTokenInQuery = url.searchParams.has("token_hash");
  for (const k of SECRET_QUERY_KEYS) {
    if (url.searchParams.has(k)) {
      url.searchParams.delete(k);
      changed = true;
    }
  }
  if (hadTokenInQuery) url.searchParams.delete("type");
  if (!changed) return null;
  // Relative, so replaceState can never move the page to another origin.
  return `${url.pathname}${url.search}${url.hash}`;
}

/** What the customer proved, held in memory by the reset page only. */
export interface RecoveryProof {
  userId: string;
  /** The session's `session_id` claim, which survives token refresh. */
  sessionKey: string;
  verifiedAtMs: number;
}

function sessionKeyOf(claims: Record<string, unknown>, accessToken: string): string {
  const sid = claims.session_id;
  // Without a session id, only this exact token counts. A refresh then closes
  // the form, which fails safe.
  return typeof sid === "string" && sid ? `sid:${sid}` : `tok:${accessToken}`;
}

/** A proof from the session verifyOtp(type "recovery") returned, or null. */
export function proofFromVerifiedSession(
  accessToken: string | null | undefined,
  userId: string | null | undefined,
  nowMs: number
): RecoveryProof | null {
  const claims = tokenClaims(accessToken);
  if (!accessToken || !claims || typeof claims.sub !== "string" || !claims.sub) return null;
  if (userId && userId !== claims.sub) return null;
  return { userId: claims.sub, sessionKey: sessionKeyOf(claims, accessToken), verifiedAtMs: nowMs };
}

/**
 * A proof for an old link's session (amr `recovery`), dated from when the link
 * was used, so both kinds of link close and clean up the same way. Null for
 * any other session.
 */
export function proofFromRecoverySession(accessToken: string | null | undefined): RecoveryProof | null {
  const claims = tokenClaims(accessToken);
  if (!accessToken || !claims || typeof claims.sub !== "string" || !claims.sub || !Array.isArray(claims.amr)) return null;
  let usedAt = -Infinity;
  for (const entry of claims.amr) {
    const { method, timestamp } = (entry ?? {}) as { method?: unknown; timestamp?: unknown };
    if (method === "recovery" && typeof timestamp === "number") usedAt = Math.max(usedAt, timestamp);
  }
  if (usedAt === -Infinity) return null;
  return { userId: claims.sub, sessionKey: sessionKeyOf(claims, accessToken), verifiedAtMs: usedAt * 1000 };
}

/**
 * Whether this token belongs to the user and session the proof was made for,
 * whatever its age. A refreshed token of the same session still matches; a
 * different account or a new sign-in never does.
 */
export function sessionMatchesProof(accessToken: string | null | undefined, proof: RecoveryProof | null): boolean {
  if (!proof || !accessToken) return false;
  const claims = tokenClaims(accessToken);
  return !!claims && claims.sub === proof.userId && sessionKeyOf(claims, accessToken) === proof.sessionKey;
}

/**
 * Whether the new-password form may be open for this session.
 *
 *   - an old link's session (amr `recovery`, within the window) — unchanged; or
 *   - a proof this page made, for this same user and session, within the window.
 *
 * A session on its own — password, Google, a signup code (`otp`) — is never
 * enough. Like recoverySessionOpen, this decides what the page shows; it is
 * checked again immediately before saving.
 */
export function recoveryFormOpen(
  accessToken: string | null | undefined,
  proof: RecoveryProof | null,
  nowMs: number = Date.now()
): boolean {
  if (recoverySessionOpen(accessToken, nowMs)) return true;
  if (!proof || !sessionMatchesProof(accessToken, proof)) return false;
  const age = nowMs - proof.verifiedAtMs;
  return age >= -60_000 && age <= RECOVERY_WINDOW_SECONDS * 1000;
}

/**
 * Why a check failed, only as far as the evidence goes. Supabase answers a
 * wrong, used and expired link with the same `otp_expired`, so those are one
 * case here too.
 */
export type VerifyFailure = "invalid" | "network" | "rate_limited" | "unknown";

export function classifyVerifyFailure(error: unknown): VerifyFailure {
  if (error instanceof TypeError) return "network"; // fetch itself failed
  if (!error || typeof error !== "object") return "unknown";
  const { name, status, code } = error as { name?: unknown; status?: unknown; code?: unknown };
  if (name === "AuthRetryableFetchError" || status === 0) return "network";
  if (status === 429 || code === "over_request_rate_limit") return "rate_limited";
  if (typeof status === "number" && status >= 500) return "network";
  if (code === "otp_expired" || [400, 401, 403, 404, 422].includes(status as number)) return "invalid";
  return "unknown";
}

/** Shown beside Continue when a retry may help. "invalid" has its own screen. */
export const VERIFY_FAILURE_COPY: Record<Exclude<VerifyFailure, "invalid">, string> = {
  network: "We couldn't reach our sign-in service to check your link. Check your connection and try again.",
  rate_limited: "Too many attempts just now. Please wait a few minutes and try again.",
  unknown: "Something went wrong checking your link. Please try again, or ask for a new link.",
};

export type RecoveryVerification =
  | { ok: true; proof: RecoveryProof }
  /**
   * `createdAccessToken`: Supabase accepted the link and saved a session, but
   * no proof could be made from it. The token is spent; that session is the
   * one to end.
   */
  | { ok: false; failure: VerifyFailure; createdAccessToken?: string };

/** The part of the Supabase auth client this needs, so tests can stand in. */
export interface RecoveryAuth {
  verifyOtp(params: { token_hash: string; type: "recovery" }): Promise<{
    data: { user: { id: string } | null; session: { access_token: string } | null };
    error: unknown;
  }>;
}

/**
 * Spend the token: one verifyOtp, type "recovery" only — a signup or email
 * change token hash is not a recovery token and Supabase refuses it.
 */
export async function verifyRecoveryLink(
  auth: RecoveryAuth,
  tokenHash: string,
  now: () => number = Date.now
): Promise<RecoveryVerification> {
  try {
    const { data, error } = await auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
    if (error) return { ok: false, failure: classifyVerifyFailure(error) };
    const created = data?.session?.access_token;
    const proof = proofFromVerifiedSession(created, data?.user?.id, now());
    if (proof) return { ok: true, proof };
    return created ? { ok: false, failure: "unknown", createdAccessToken: created } : { ok: false, failure: "unknown" };
  } catch (e) {
    return { ok: false, failure: classifyVerifyFailure(e) };
  }
}

export type RecoveryPhase =
  | "checking"
  | "confirm"
  | "verifying"
  | "form"
  | "invalid"
  | "otherBrowser"
  | "noLink"
  | "closed"
  /** A session lookup failed, so the page couldn't check (WP-OPS-01C7). */
  | "unavailable"
  | "saved";

/** The first screen once the URL and any existing session have been read. */
export function initialRecoveryPhase(url: RecoveryUrl, legacyRecoveryOpen: boolean): RecoveryPhase {
  if (url.link.kind === "token") return "confirm";
  if (url.link.kind === "malformed" || url.supabaseError) return "invalid";
  if (legacyRecoveryOpen) return "form";
  if (url.legacyCode) return "otherBrowser";
  return "noLink";
}
