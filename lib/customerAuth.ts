import { getBrowserSupabase } from "./supabase";
import { useCartStore } from "./store";
import { cPath } from "./country";

/**
 * Customer-facing auth.
 *
 * The same Supabase Auth the admin uses — see migration 0023 for why sharing is
 * safe. Nothing here can grant admin: is_admin defaults false and
 * `grant update (email, full_name)` means an authenticated user cannot set it.
 *
 * Every function returns a readable message rather than throwing. Auth errors
 * are the ones customers actually see, and Supabase's own wording ("Invalid
 * login credentials", "Email not confirmed") is accurate but cold.
 */

/**
 * Where a signed-in customer lands.
 *
 * The homepage, not the wishlist. Landing on a saved-items page implies the
 * visit was about the wishlist, which it usually was not — people sign in to
 * carry on shopping, and an empty wishlist is a poor first thing to be shown.
 * A `?from=` on the login URL still wins, so anyone bounced off a gated page is
 * returned to it.
 */
export const AFTER_LOGIN = "/in";

export interface AuthResult {
  ok: boolean;
  error: string | null;
  /** Set when the account exists but has never confirmed its email. */
  needsVerification?: boolean;
}

/**
 * Turn Supabase's message into something a person can act on.
 *
 * Matched on substrings because the API returns messages, not stable codes.
 * Anything unrecognised is passed through rather than replaced with a generic
 * line — a wrong-but-specific message is easier to debug than "something went
 * wrong", and this is the surface where people get stuck.
 */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials"))
    return "That email and password don't match. Check the password, or reset it below.";
  if (m.includes("email not confirmed"))
    return "This email hasn't been verified yet. Check your inbox for the code we sent.";
  if (m.includes("user already registered") || m.includes("already been registered"))
    return "There's already an account with this email. Try logging in, or reset your password.";
  // Supabase sends ONE message for a wrong code and an expired one — "Token has
  // expired or is invalid" — so the two genuinely cannot be told apart here.
  // This must be tested BEFORE the bare "expired" check below, which used to
  // catch it and tell someone who had simply mistyped a digit that their code
  // had expired and to request a new one. That is advice which does not fix a
  // typo, and it sends people round a loop of fresh codes that all "expire".
  if (m.includes("expired or is invalid") || m.includes("invalid or has expired"))
    return "That code isn't right, or it has expired. Check it and try again, or ask for a new one below.";
  if (m.includes("token has expired") || m.includes("expired"))
    return "That code has expired. Ask for a new one below.";
  if (m.includes("invalid token") || m.includes("token not found"))
    return "That code isn't right. Check it and try again.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts just now. Please wait a few minutes and try again.";
  if (m.includes("password should be") || m.includes("password must"))
    return "Please choose a password of at least 8 characters.";
  if (m.includes("weak password"))
    return "That password is too easy to guess. Try a longer one.";
  return message;
}

/** Local checks, so obvious problems don't need a round trip. */
export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < 8) return "Please use at least 8 characters.";
  if (confirm !== undefined && password !== confirm)
    return "The two passwords don't match.";
  return null;
}

export async function signUp(
  email: string,
  password: string,
  fullName: string,
  marketingConsent = false
): Promise<AuthResult> {
  const { error } = await getBrowserSupabase().auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      // Read by handle_new_user (migration 0026) when it writes the profile.
      // Sent as a string because auth metadata is JSON the client controls;
      // the trigger tests it against 'true' explicitly, so nothing else counts.
      data: {
        full_name: fullName.trim(),
        marketing_consent: marketingConsent ? "true" : "false",
      },
    },
  });
  return error
    ? { ok: false, error: friendlyAuthError(error.message) }
    : { ok: true, error: null };
}

/** Confirm a signup with the emailed code. */
export async function verifySignupCode(
  email: string,
  token: string
): Promise<AuthResult> {
  const { error } = await getBrowserSupabase().auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: token.trim(),
    type: "signup",
  });
  return error
    ? { ok: false, error: friendlyAuthError(error.message) }
    : { ok: true, error: null };
}

export async function resendSignupCode(email: string): Promise<AuthResult> {
  const { error } = await getBrowserSupabase().auth.resend({
    type: "signup",
    email: email.trim().toLowerCase(),
  });
  return error
    ? { ok: false, error: friendlyAuthError(error.message) }
    : { ok: true, error: null };
}

export async function logIn(email: string, password: string): Promise<AuthResult> {
  const supabase = getBrowserSupabase();
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (!error) {
    // Admin and customer accounts live in one Supabase project, so a correct
    // admin password authenticates here perfectly well. That is not a hole in
    // the database — RLS still governs everything — but it is wrong for this
    // form: staff signing in through the shop's login lands them in a customer
    // account area that is not theirs.
    //
    // The session is ended immediately and the message is the SAME as a wrong
    // password. Saying "that's an admin account" would confirm which addresses
    // are staff to anyone who tried a few.
    const { data: isAdmin } = await supabase.rpc("is_admin");
    if (isAdmin === true) {
      await supabase.auth.signOut({ scope: "local" });
      return {
        ok: false,
        error: "Incorrect email or password.",
      };
    }
    return { ok: true, error: null };
  }
  return {
    ok: false,
    error: friendlyAuthError(error.message),
    needsVerification: error.message.toLowerCase().includes("email not confirmed"),
  };
}

/**
 * Send a reset link.
 *
 * A link rather than a code, unlike signup: the link carries a recovery token
 * that establishes a session when clicked, and doing that with a code would
 * mean exchanging tokens by hand alongside Supabase's own flow. The user is
 * also usually on a different device from the one they were locked out of, so
 * leaving the page costs nothing here.
 */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const { error } = await getBrowserSupabase().auth.resetPasswordForEmail(
    email.trim().toLowerCase(),
    // cPath, not a bare "/reset-password". Since the storefront moved under a
    // market prefix (#69) that path has no route of its own, so middleware
    // answers it with a 308 to /in/reset-password — and Supabase carries the
    // recovery token in the URL FRAGMENT, which a browser does not resend
    // across a redirect. The token was being dropped in transit, the page had
    // no session to work with, and the customer ended up on the homepage
    // wondering where the form was.
    { redirectTo: `${window.location.origin}${cPath("/reset-password")}` }
  );
  return error
    ? { ok: false, error: friendlyAuthError(error.message) }
    : { ok: true, error: null };
}

/** Set a new password, using the session the recovery link established. */
export async function setNewPassword(password: string): Promise<AuthResult> {
  const { error } = await getBrowserSupabase().auth.updateUser({ password });
  return error
    ? { ok: false, error: friendlyAuthError(error.message) }
    : { ok: true, error: null };
}

/**
 * Change the marketing preference for the signed-in customer.
 *
 * Writes to their own profile row, which RLS restricts to them and 0026's
 * column grant limits to this field and their name. Consent is theirs to give
 * and withdraw; nobody else can set it on their behalf.
 */
/**
 * Save the address orders usually go to.
 *
 * A suggestion for next time, not a record of anything already ordered:
 * every order carries its own copy of the address it was placed with, so
 * changing this can never redirect a parcel already on its way.
 */
export async function setDefaultAddress(
  address: Record<string, string>,
  phone: string
): Promise<AuthResult> {
  const supabase = getBrowserSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You need to be logged in." };

  // .select() so a write that matched NOTHING is distinguishable from one that
  // worked. An UPDATE filtered to a row RLS will not show you reports success
  // and changes nothing, so without this the panel says "Saved" over a profile
  // that never changed — the same trap that hid the Homepage Content bug (#77).
  const { data, error } = await supabase
    .from("profiles")
    .update({ default_address: address, default_phone: phone })
    .eq("id", user.id)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data?.length) {
    return {
      ok: false,
      error: "We couldn't save that to your account. Please try again.",
    };
  }
  return { ok: true, error: null };
}

export async function setMarketingConsent(
  consent: boolean
): Promise<AuthResult> {
  const supabase = getBrowserSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You need to be logged in." };

  const { error } = await supabase
    .from("profiles")
    .update({
      marketing_consent: consent,
      // Records when they agreed. Withdrawal clears it — an old timestamp
      // against a false flag would misread as historic consent.
      marketing_consent_at: consent ? new Date().toISOString() : null,
    })
    .eq("id", user.id);

  return error
    ? { ok: false, error: error.message }
    : { ok: true, error: null };
}

export async function logOut(): Promise<void> {
  // Empty the cart FIRST, and here rather than only in CartSync's auth
  // listener. The cart lives in localStorage and outlives the session, so on a
  // shared device it is the next person's to read. CartSync also reconciles on
  // SIGNED_OUT, but that listener is only mounted under the storefront layout
  // and the sign-out may be followed immediately by navigation — this is the
  // guarantee that does not depend on either.
  useCartStore.getState().resetForSignOut();

  // Local scope only: a global sign-out would end the session on every device,
  // which is not what "log out" means on a shop.
  await getBrowserSupabase().auth.signOut({ scope: "local" });
}
