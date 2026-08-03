import { getBrowserSupabase } from "./supabase";

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

/** Where a signed-in customer lands. */
export const AFTER_LOGIN = "/account/wishlist";

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
    { redirectTo: `${window.location.origin}/reset-password` }
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
  // Local scope only: a global sign-out would end the session on every device,
  // which is not what "log out" means on a shop.
  await getBrowserSupabase().auth.signOut({ scope: "local" });
}
