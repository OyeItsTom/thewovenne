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
 *   false                          → the "Set a password" panel
 *   true                           → the normal change-password form
 *   NULL, an error, anything else  → the normal form
 *
 * Unknown falls back to the form because that is the case that cannot mislead
 * someone who has a password: a failed lookup never tells them they have none
 * and sends them round the set-up email again. A Google-only customer who hits
 * the fallback can still use "Forgot password?" on the login page.
 */
export function hasPasswordFrom(answer: { data: unknown; error: unknown }): boolean {
  return !(answer.error == null && answer.data === false);
}
