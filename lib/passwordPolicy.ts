/**
 * The password rule — one place, used by every form that sets a password:
 * customer signup, the emailed reset/set-a-password link (which is also how a
 * Google-only customer adds their first password), and the admin change page.
 *
 * LENGTH, NOT COMPOSITION. A long passphrase beats a short password with a
 * forced capital, digit and symbol, so there are no character-class rules and
 * nothing is ever trimmed: spaces count, and whatever a password manager
 * generates is accepted as typed.
 *
 * Supabase Auth must be set to the same minimum (Dashboard → Authentication →
 * Providers → Email → Minimum password length = 12, Password requirements =
 * none), so a direct API call cannot get round the forms. It only checks when a
 * password is SET; signing in with an older, shorter password still works.
 *
 * UNITS. GoTrue measures both limits with Go's len(), which counts UTF-8 BYTES.
 * The minimum here counts characters (code points), which is never more than
 * the byte count — so anything this accepts, Supabase accepts too. The maximum
 * is bcrypt's 72 bytes, checked in bytes, because "é" is two and an emoji four.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_HINT = `Use at least ${PASSWORD_MIN_LENGTH} characters. Spaces are allowed, so a short phrase works well.`;
export const PASSWORD_TOO_SHORT = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
export const PASSWORD_TOO_LONG =
  "That password is too long. Please keep it to 72 letters, or fewer if it has emoji or accented letters.";

/** Characters as a person counts them: an emoji is one, not two UTF-16 units. */
export const passwordLength = (password: string) => Array.from(password).length;

export const passwordBytes = (password: string) =>
  new TextEncoder().encode(password).length;

export function passwordPolicyProblem(password: string): string | null {
  if (passwordLength(password) < PASSWORD_MIN_LENGTH) return PASSWORD_TOO_SHORT;
  if (passwordBytes(password) > PASSWORD_MAX_BYTES) return PASSWORD_TOO_LONG;
  return null;
}
