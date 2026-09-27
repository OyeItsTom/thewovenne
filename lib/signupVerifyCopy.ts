/**
 * What the signup verification page may truthfully say.
 *
 * With email confirmation on, Supabase answers a signup for an address that
 * already has a confirmed account exactly as it answers a new one — success,
 * and no email. That is deliberate: it stops anyone learning which addresses
 * have accounts. It also means this page cannot know whether a code was sent,
 * and must not claim one was. Every sentence here is true in both cases, and
 * the page looks the same in both, so it reveals nothing either.
 *
 * The same holds for "Send another code": Supabase reports success for an
 * address that has nothing waiting to be verified, and sends nothing.
 *
 * Never branch on the signup response to say "an account already exists".
 * The response does carry a hint, but showing it would turn this form into a
 * way to check whether any address is registered.
 */
import { cPath } from "./country";

export const VERIFY_COPY = {
  intro: (email: string) =>
    `If ${email} is new to us, we've sent a 6-digit code there. Enter it below to finish creating your account.`,
  codeHint: "Six digits, from our email. It can take a minute to arrive.",
  existingAccount:
    "Already have an account with this email? We won't send a code for it. Log in instead, or reset your password if you've forgotten it.",
  resent:
    "If this email is waiting to be verified, a new code is on its way. It can take a minute to arrive.",
} as const;

/**
 * Where "Log in" goes from here. The onward path survives only if it is
 * relative — an absolute URL would make the link an open redirect.
 */
export function verifyLoginHref(from?: string | null): string {
  const onward =
    from && from.startsWith("/") && !from.startsWith("//")
      ? `?from=${encodeURIComponent(from)}`
      : "";
  return `${cPath("/login")}${onward}`;
}

export const VERIFY_RESET_HREF = cPath("/forgot-password");
