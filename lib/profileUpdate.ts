/**
 * What an UPDATE of the signed-in customer's own profile row actually did.
 *
 * Only a result naming exactly one row is success. With RLS, an UPDATE that no
 * policy lets through is not an error: PostgREST answers 200 with an empty list
 * and nothing has changed. Reading "no error" as "saved" is how the profile page
 * said "Saved." over a name that never changed while production was missing its
 * UPDATE policies (0063) — the same trap as #77. Callers must therefore ask for
 * the row back (`.select("id")`) and pass the answer here.
 */
export const PROFILE_NOT_SAVED = "We couldn't save that to your account. Please try again.";

export function profileUpdateResult(
  data: unknown,
  error: { message: string } | null
): { ok: boolean; error: string | null } {
  if (error) return { ok: false, error: error.message };
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, error: PROFILE_NOT_SAVED };
  return { ok: true, error: null };
}
