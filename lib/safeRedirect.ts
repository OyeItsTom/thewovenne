/**
 * Where a customer may be sent after signing in.
 *
 * ONE RULE, IN ONE PLACE. The login, signup, verify and Google return paths
 * each carried their own `from.startsWith("/")` check, and they had drifted:
 * the login form accepted `//evil.example` (a protocol-relative URL — another
 * site), and the others accepted `/\evil.example`, which browsers also read as
 * `//`. Either is an open redirect a phishing link can point anywhere.
 *
 * So a destination is accepted only when ALL of these hold:
 *   - it is a path on this site — resolving it against a dummy origin leaves
 *     the origin unchanged, which rules out `//host`, `/\host`, `https:` and
 *     every other way of naming a different host;
 *   - it contains no backslash, whitespace or control character, which
 *     browsers strip or reinterpret before they navigate;
 *   - it is a CUSTOMER destination: never /admin (a customer sign-in must not
 *     deliver anyone to the admin entry path) and never /api (the Google
 *     callback itself, or anything else that is not a page).
 *
 * Anything else becomes the fallback. Pure, with no imports, so the same
 * function runs in the browser, in the route handler and in the tests.
 */
export const DEFAULT_AFTER_LOGIN = "/in";

const PROBE_ORIGIN = "https://wovenne.invalid";

export function safeNext(
  candidate: string | null | undefined,
  fallback: string = DEFAULT_AFTER_LOGIN
): string {
  if (typeof candidate !== "string") return fallback;
  if (candidate.length === 0 || candidate.length > 512) return fallback;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(candidate)) return fallback;

  let url: URL;
  try {
    url = new URL(candidate, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;

  const path = url.pathname.toLowerCase();
  for (const blocked of ["/admin", "/api"]) {
    if (path === blocked || path.startsWith(`${blocked}/`)) return fallback;
  }

  // Rebuilt from the parsed URL, so what is returned is exactly what was
  // checked — never the raw string with something the parser normalised away.
  return `${url.pathname}${url.search}${url.hash}`;
}
