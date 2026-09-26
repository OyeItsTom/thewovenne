/**
 * Whether a product master is being served the way the public will see it.
 *
 * ── WHY GET, AND NOT HEAD ──
 *
 * On the hosted service HEAD is not evidence. Measured on 26 September 2026
 * against a harmless test object: HEAD answered `cache-control: no-cache` for
 * every object whatever was stored, and answered `x-robots-tag: none` for an
 * object whose stored metadata and GET both said `all`. So this asks the way a
 * crawler asks — a GET — and asks for ONE byte, so a 5 MB master is not
 * downloaded to read its headers.
 *
 * ── WHAT A RESPONSE CAN AND CANNOT PROVE ──
 *
 *   readable   status 206, or 200 from a server that ignored the Range header.
 *   length     Content-Range's total on a 206, Content-Length on a 200. When the
 *              server gives neither, the length is unknown, not wrong.
 *   identity   The storage backend's ETag for a single-part upload is the MD5 of
 *              the bytes (checked on the hosted service against three objects,
 *              and on all 128 masters' listed ETags, none of them multipart). So
 *              a plain 32-hex strong ETag is compared with the master's MD5. A
 *              multipart ETag ("…-2"), a weak one, or none at all proves nothing
 *              either way — identity is then UNVERIFIED, which is reported,
 *              never passed off as verified.
 *   headers    X-Robots-Tag must not forbid indexing; Cache-Control must carry
 *              max-age=31536000. A CDN may add directives (`public`); extra
 *              directives are fine, a wrong or missing max-age is not.
 *
 * ── WHAT `cache: "no-store"` DOES NOT DO ──
 *
 * It keeps Next's own fetch cache out of the way. It does NOT bypass Supabase's
 * CDN. For a brand-new key that does not matter — nothing can be cached under a
 * name that did not exist — and for a duplicate, the CDN's answer is exactly
 * what the public would get, which is the point.
 */

export type DeliveryFailure =
  /** No usable response: a network error, or any status but 200/206. */
  | "unreadable"
  /** The served length differs from the master's: demonstrably other bytes. */
  | "length_mismatch"
  /** An MD5 ETag that is not the master's MD5: demonstrably other bytes. */
  | "identity_mismatch";

export type DeliveryWarning =
  /** The ETag was multipart, weak or absent, so bytes could not be compared. */
  | "identity_unverified"
  /** Neither Content-Range nor Content-Length said how big the object is. */
  | "length_unknown"
  /** X-Robots-Tag forbids indexing (`none`, `noindex`, `noimageindex`). */
  | "not_indexable"
  /** Cache-Control is missing, malformed, or carries a different max-age. */
  | "cache_control_unexpected";

export interface MasterDelivery {
  /** "verified" only when there is nothing at all to warn about. */
  status: "verified" | "warning";
  identity: "md5" | "unverified";
  indexable: boolean;
  robotsTag: string | null;
  cacheControl: string | null;
  /** False when the server answered the ranged GET with the whole object. */
  rangeHonoured: boolean;
  warnings: DeliveryWarning[];
}

export type DeliveryCheck =
  | { ok: true; delivery: MasterDelivery }
  | { ok: false; failure: DeliveryFailure; httpStatus: number | null; detail: string };

export interface ExpectedMaster {
  byteLength: number;
  /** Lower-case hex MD5 of the exact bytes that were uploaded. */
  md5: string;
  /** The max-age the upload asked for, in seconds. */
  maxAge: number;
}

interface HeaderSource {
  get(name: string): string | null;
}

const BLOCKING_RULES = new Set(["none", "noindex", "noimageindex"]);
/** Rules that take a value after a colon — `max-image-preview: none` is not `none`. */
const PARAMETRIC_RULE = /^(max-snippet|max-image-preview|max-video-preview|unavailable_after)\s*:/i;

/**
 * Whether an X-Robots-Tag value forbids indexing an image, for any crawler.
 * Handles comma-separated rules and a user-agent prefix (`googlebot: noindex`).
 */
export function robotsForbidIndexing(value: string | null): boolean {
  if (!value) return false;
  return value.split(",").some((raw) => {
    let rule = raw.trim();
    if (PARAMETRIC_RULE.test(rule)) return false;
    const colon = rule.indexOf(":");
    if (colon !== -1) rule = rule.slice(colon + 1).trim();
    if (PARAMETRIC_RULE.test(rule)) return false;
    return BLOCKING_RULES.has(rule.toLowerCase());
  });
}

function servedLength(status: number, headers: HeaderSource): number | null {
  if (status === 206) {
    const range = headers.get("content-range");
    const match = range ? /^bytes\s+\d+-\d+\/(\d+)$/i.exec(range.trim()) : null;
    return match ? Number(match[1]) : null;
  }
  const length = headers.get("content-length");
  return length && /^\d+$/.test(length.trim()) ? Number(length.trim()) : null;
}

/** A plain strong 32-hex ETag, unquoted and lower-cased; anything else is null. */
function md5Etag(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.startsWith("W/")) return null;
  const inner = value.replace(/^"(.*)"$/, "$1");
  return /^[0-9a-f]{32}$/i.test(inner) ? inner.toLowerCase() : null;
}

function maxAgeOf(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  for (const directive of cacheControl.split(",")) {
    const match = /^\s*max-age\s*=\s*"?(\d+)"?\s*$/i.exec(directive);
    if (match) return Number(match[1]);
  }
  return null;
}

/** The decision, from a response's status and headers alone. Pure. */
export function assessMasterDelivery(
  status: number,
  headers: HeaderSource,
  expected: ExpectedMaster
): DeliveryCheck {
  if (status !== 200 && status !== 206) {
    return { ok: false, failure: "unreadable", httpStatus: status, detail: `public GET answered ${status}` };
  }

  const warnings: DeliveryWarning[] = [];

  const length = servedLength(status, headers);
  if (length === null) {
    warnings.push("length_unknown");
  } else if (length !== expected.byteLength) {
    return {
      ok: false,
      failure: "length_mismatch",
      httpStatus: status,
      detail: `served ${length} bytes, the master is ${expected.byteLength}`,
    };
  }

  const etag = md5Etag(headers.get("etag"));
  let identity: MasterDelivery["identity"] = "unverified";
  if (etag === null) {
    warnings.push("identity_unverified");
  } else if (etag !== expected.md5.toLowerCase()) {
    return {
      ok: false,
      failure: "identity_mismatch",
      httpStatus: status,
      detail: `served MD5 ${etag}, the master is ${expected.md5}`,
    };
  } else {
    identity = "md5";
  }

  const robotsTag = headers.get("x-robots-tag");
  const indexable = !robotsForbidIndexing(robotsTag);
  if (!indexable) warnings.push("not_indexable");

  const cacheControl = headers.get("cache-control");
  if (maxAgeOf(cacheControl) !== expected.maxAge) warnings.push("cache_control_unexpected");

  return {
    ok: true,
    delivery: {
      status: warnings.length === 0 ? "verified" : "warning",
      identity,
      indexable,
      robotsTag,
      cacheControl,
      rangeHonoured: status === 206,
      warnings,
    },
  };
}

/**
 * One ranged GET of the public URL, judged by assessMasterDelivery.
 *
 * The body is never read: it is cancelled as soon as the headers are in, so a
 * server that ignores Range cannot turn a header check into a full download.
 * `fetchImpl` is injectable so every response shape can be tested without a
 * network.
 */
export async function verifyMasterDelivery(
  url: string,
  expected: ExpectedMaster,
  fetchImpl: typeof fetch = fetch
): Promise<DeliveryCheck> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      failure: "unreadable",
      httpStatus: null,
      detail: `public GET failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    await response.body?.cancel();
  } catch {
    // Nothing was going to be read anyway.
  }
  return assessMasterDelivery(response.status, response.headers, expected);
}
