/**
 * Whether an account has a password at all, from the identities Supabase
 * validated in getUser(). Never from the email address, its confirmation, the
 * profile or anything the browser sent: an account that joined with Google has
 * a confirmed email and still no password.
 *
 *   email only          → true   (the form, as it always was)
 *   email + Google      → true   (linking Google takes nothing away)
 *   Google only         → false  (a "current password" it could never fill in)
 *
 * Supabase gives an account an `email` identity when it signs up with a
 * password. Whether it also adds one when a Google-only account sets its first
 * password depends on a Supabase Auth setting (behind an experimental flag in
 * v2.197.0), so that case is verified live rather than assumed.
 */
export function signsInWithPassword(user: {
  identities?: { provider: string }[] | null;
}): boolean {
  // No identities listed is treated as password-capable: the panel then works
  // exactly as it always has.
  if (!user.identities || user.identities.length === 0) return true;
  return user.identities.some((i) => i.provider === "email");
}
