/**
 * The signup verification page tells the truth without revealing who has an
 * account.
 *
 * WHAT THIS PROTECTS. Supabase answers a signup for an already-registered
 * address as if it were new — success, no email — so that nobody can use the
 * form to learn which addresses have accounts. The page used to say "We've
 * sent a code to …" regardless, and a returning customer waited for a code that
 * was never coming, with no way back to logging in.
 *
 * Two rules, asserted here:
 *   1. Nothing on the page claims a code was sent; every sentence holds whether
 *      or not the address was new, and a way to log in or reset is always shown.
 *   2. Nothing reads the signup response to tell the two cases apart — the
 *      account-enumeration protection stays intact.
 *
 *   npx tsx scripts/signup-verify-copy.test.ts
 *
 * Exits non-zero on failure.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { VERIFY_COPY, VERIFY_RESET_HREF, verifyLoginHref } from "../lib/signupVerifyCopy";

let passed = 0;
let failed = 0;
function t(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
}

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// Comments explain the old wording; only code counts.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const verifyForm = code(read("components/account/VerifyForm.tsx"));
const signupForm = code(read("components/account/SignupForm.tsx"));
const customerAuth = code(read("lib/customerAuth.ts"));
const copyModule = code(read("lib/signupVerifyCopy.ts"));

console.log("\nwording is true whether or not a code was sent");
const intro = VERIFY_COPY.intro("someone@example.test");
t("intro is conditional", /^If someone@example\.test is new to us, we've sent/.test(intro), intro);
t("intro names the address it was asked about", intro.includes("someone@example.test"));
t("resend confirmation is conditional", VERIFY_COPY.resent.startsWith("If "), VERIFY_COPY.resent);
t("code hint does not claim an email was just sent", !/just sent|we sent|we've sent/i.test(VERIFY_COPY.codeHint), VERIFY_COPY.codeHint);
t("existing-account line is phrased as a question to the reader, not a finding",
  VERIFY_COPY.existingAccount.startsWith("Already have an account with this email?"));
const everything = [intro, VERIFY_COPY.resent, VERIFY_COPY.codeHint, VERIFY_COPY.existingAccount].join(" ");
t("no sentence states that an account exists or is registered",
  !/(an|your) account (already )?exists|already (registered|exists)|is registered/i.test(everything));

console.log("\nthe page uses that wording, and nothing else");
t("no unconditional 'We've sent a code to' left in the page", !/We've sent a code to/.test(verifyForm));
t("no 'from the email we just sent' left in the page", !/email we just sent/.test(verifyForm));
t("no unconditional 'A new code is on its way' left in the page", !/>\s*A new code is on its way/.test(verifyForm));
t("intro comes from VERIFY_COPY", verifyForm.includes("VERIFY_COPY.intro(email)"));
t("resend confirmation comes from VERIFY_COPY", verifyForm.includes("VERIFY_COPY.resent"));
t("code hint comes from VERIFY_COPY", verifyForm.includes("VERIFY_COPY.codeHint"));
t("existing-account line is shown", verifyForm.includes("VERIFY_COPY.existingAccount"));
t("the existing-account line is not conditional on anything", !/&&\s*\(?\s*<p>\{VERIFY_COPY\.existingAccount/.test(verifyForm));

console.log("\nthe way back is always there");
t("Log in link", /href=\{verifyLoginHref\(from\)\}[\s\S]{0,120}Log in/.test(verifyForm));
t("Reset password link", /href=\{VERIFY_RESET_HREF\}[\s\S]{0,120}Reset your password/.test(verifyForm));
t("login goes to /in/login", verifyLoginHref(null) === "/in/login", verifyLoginHref(null));
t("reset goes to /in/forgot-password", VERIFY_RESET_HREF === "/in/forgot-password", VERIFY_RESET_HREF);
t("a relative onward path is carried to login", verifyLoginHref("/in/checkout") === "/in/login?from=%2Fin%2Fcheckout", verifyLoginHref("/in/checkout"));
t("an absolute onward URL is dropped (no open redirect)", verifyLoginHref("https://evil.example/x") === "/in/login");
t("a protocol-relative onward URL is dropped", verifyLoginHref("//evil.example/x") === "/in/login");
t("the email is not put in the login or reset link", !/verifyLoginHref\([^)]*email/.test(verifyForm) && !/VERIFY_RESET_HREF\s*\+/.test(verifyForm));

console.log("\naccount-enumeration protection is untouched");
t("signUp does not read the returned user", /const \{ error \} = await getBrowserSupabase\(\)\.auth\.signUp\(/.test(customerAuth));
t("nothing inspects identities", !/identities/.test(customerAuth + signupForm + verifyForm + copyModule));
t("resend does not read the returned data", /const \{ error \} = await getBrowserSupabase\(\)\.auth\.resend\(/.test(customerAuth));
t("signup always continues to the same verify page on success",
  /router\.push\(\s*`\/in\/verify\?email=/.test(signupForm) &&
  !/already (registered|exists)|account (already )?exists|is registered/i.test(signupForm));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
