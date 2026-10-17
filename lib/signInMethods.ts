/**
 * Whether the signed-in account has a password, from the answer to
 * account_has_password() (0072): Supabase Auth's own stored-password check,
 * for the caller only.
 *
 * Not from the identities list. On 17 Oct 2026 a Google-only customer set a
 * password through the recovery link and Supabase added no `email` identity,
 * so the list said "Google only" for an account that signs in with a password.
 * Nor from the email address, its confirmation or the profile: an account that
 * joined with Google has a confirmed email and no password.
 *
 * It only chooses the WORDING of Settings → Password. Both answers lead to the
 * same emailed recovery link; neither shows a password field.
 *
 *   false                          → "Set a password"
 *   true                           → "Change password"
 *   NULL, an error, anything else  → "Change password"
 *
 * Unknown falls back to "Change password" because that is the case that cannot
 * mislead someone who has a password: a failed lookup never tells them they
 * have none. The link it sends works the same either way.
 */
export function hasPasswordFrom(answer: { data: unknown; error: unknown }): boolean {
  return !(answer.error == null && answer.data === false);
}

/**
 * How long after opening a recovery link the new-password form stays open, for
 * someone who opens it and does not save. Saving ends the session at once (see
 * ResetPasswordForm), so this only bounds an abandoned one. The link itself
 * opens straight onto the form, so a quarter of an hour is plenty.
 */
export const RECOVERY_WINDOW_SECONDS = 15 * 60;

/**
 * Whether this session came from an emailed recovery link, opened within the
 * last RECOVERY_WINDOW_SECONDS.
 *
 * /in/reset-password used to show its form to ANY session. That made the page a
 * way round the email: anyone at a signed-in browser could open it and replace
 * the password without knowing the old one or touching the inbox. Supabase
 * stamps how a session was made in the token's `amr` claim, and a recovery link
 * stamps `recovery` with the time it was used, so that is what is asked for.
 *
 * This decides what the page SHOWS. It reads the token without verifying it,
 * which is fine for that: a forged token gets a form whose save Supabase then
 * refuses. Anything unreadable, any other method, or a string-only `amr` with no
 * time on it is a no, and the page offers a fresh link instead.
 */
export function recoverySessionOpen(
  accessToken: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  const amr = tokenClaims(accessToken)?.amr;
  if (!Array.isArray(amr)) return false;
  const nowSeconds = nowMs / 1000;
  return amr.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    return (
      method === "recovery" &&
      typeof timestamp === "number" &&
      timestamp <= nowSeconds + 60 &&
      nowSeconds - timestamp <= RECOVERY_WINDOW_SECONDS
    );
  });
}

function tokenClaims(token: string | null | undefined): Record<string, unknown> | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}
