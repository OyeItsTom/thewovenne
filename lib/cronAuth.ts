import crypto from "node:crypto";

/**
 * Is this request from our scheduler (or an operator holding the same secret)?
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the project has
 * a CRON_SECRET variable; an authorised manual run sends the same header.
 *
 * FAILS CLOSED. No secret configured, or one shorter than 32 characters, means
 * nobody is authorised — a missing variable must never open the endpoint.
 * Compared in constant time over fixed-length digests, so neither the length
 * nor the content of the secret leaks through timing. Neither value is ever
 * logged or returned.
 */
export const CRON_SECRET_MIN_LENGTH = 32;

export function cronAuthorised(authorization: string | null, secret: string | undefined): boolean {
  if (typeof secret !== "string" || secret.length < CRON_SECRET_MIN_LENGTH) return false;
  if (typeof authorization !== "string") return false;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return false;
  const given = crypto.createHash("sha256").update(match[1], "utf8").digest();
  const expected = crypto.createHash("sha256").update(secret, "utf8").digest();
  return crypto.timingSafeEqual(given, expected);
}
