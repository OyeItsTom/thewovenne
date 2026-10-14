import { safeNext, DEFAULT_AFTER_LOGIN } from "./safeRedirect";

/**
 * How a Google sign-in that did not finish is reported back to the customer.
 *
 * The callback sends a short reason code to the login page — never Google's or
 * Supabase's own error text, which is written for developers and can carry
 * identifiers. The page turns the code into a sentence a customer can act on.
 */
export type OAuthFailure = "cancelled" | "failed" | "unverified";

export const OAUTH_FAILURE_COPY: Record<OAuthFailure, string> = {
  cancelled:
    "Google sign-in was cancelled. You can try again, or log in with your email and password.",
  failed:
    "We couldn't sign you in with Google just now. Please try again, or log in with your email and password.",
  unverified:
    "Your Google account didn't share a verified email address, so we couldn't sign you in with it. Please log in with your email and password instead.",
};

export function isOAuthFailure(value: unknown): value is OAuthFailure {
  return value === "cancelled" || value === "failed" || value === "unverified";
}

/** The login page, saying what went wrong, still holding the onward path. */
export function oauthFailureHref(reason: OAuthFailure, next?: string | null): string {
  const onward = safeNext(next);
  const from = onward === DEFAULT_AFTER_LOGIN ? "" : `&from=${encodeURIComponent(onward)}`;
  return `/in/login?oauth=${reason}${from}`;
}

/**
 * What the Google callback does with what came back — kept free of Next and of
 * Supabase so every branch can be tested. The route supplies the four calls.
 *
 * Returns the path to send the browser to. Every path out is either the safe
 * onward destination (signed in) or the login page with a reason (not signed
 * in, and any session that was made has been ended).
 */
export interface OAuthReturnDeps {
  exchange(code: string): Promise<{ ok: boolean }>;
  getUser(): Promise<{ email: string | null; emailConfirmed: boolean } | null>;
  /** true / false, or null when the question could not be answered. */
  isStaff(): Promise<boolean | null>;
  signOut(): Promise<void>;
}

export async function resolveOAuthReturn(
  params: URLSearchParams,
  deps: OAuthReturnDeps
): Promise<string> {
  const next = safeNext(params.get("next"));
  const fail = (reason: OAuthFailure) => oauthFailureHref(reason, next);

  // Google's "Cancel" comes back as error=access_denied; anything else in
  // `error` is a provider or configuration failure. The description is never
  // shown or passed on — it is provider text, sometimes with identifiers.
  const providerError = params.get("error");
  if (providerError) return fail(providerError === "access_denied" ? "cancelled" : "failed");

  const code = params.get("code");
  if (!code) return fail("failed");

  // Most common failure: the return opened in a different browser from the one
  // that started (no code-verifier cookie), or the code was used twice.
  if (!(await deps.exchange(code)).ok) return fail("failed");

  const user = await deps.getUser();
  if (!user) {
    // Exchanged but unconfirmable: whatever was written is cleared.
    await deps.signOut();
    return fail("failed");
  }

  // Orders belong to an account through its VERIFIED email (0023). A session
  // without one cannot be tied to anything, so it is ended, not kept.
  if (!user.email || !user.emailConfirmed) {
    await deps.signOut();
    return fail("unverified");
  }

  // Staff are refused exactly as the password form refuses them, with the same
  // generic outcome so the page does not reveal which addresses are staff.
  // "Could not ask" fails closed too. This is the customer door, not the
  // boundary: is_admin() demands a two-factor, live session regardless.
  const staff = await deps.isStaff();
  if (staff !== false) {
    await deps.signOut();
    return fail("failed");
  }

  return next;
}
