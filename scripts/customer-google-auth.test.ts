/**
 * Customer "Continue with Google": safe returns, every callback outcome, the
 * minimum scopes, and the admin door kept separate.
 *
 *   npx --cache <scratch>/npmcache --yes tsx@4.19.2 scripts/customer-google-auth.test.ts
 *
 * What is proven:
 *   1. safeNext — the one rule for "where may a customer be sent after signing
 *      in". The old per-form checks let `//host` (login) and `/\host` (signup,
 *      verify) through; both are open redirects.
 *   2. resolveOAuthReturn — the Google callback's decisions, against a double:
 *      cancel, provider error, no code, failed exchange, no user, unverified
 *      email, staff, staff-check failure, success. Every non-success ends the
 *      session it may have made, and nothing ever leaves the site.
 *   3. Source rules: no extra Google scopes, no People API, no demographic
 *      fields; the admin login has no Google path; the callback is under /api
 *      so the country redirect cannot drop the code; analytics gets no auth
 *      identifiers.
 *   4. Settings → Password: no password field for any account; one button that
 *      emails Supabase's recovery link; account_has_password picks only the
 *      words ("Change password" / "Set a password").
 *   5. /in/reset-password opens its form only for a session made by that link
 *      (amr `recovery`, within the hour); any other session is sent for a link.
 *
 * Exits non-zero on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { safeNext } from "../lib/safeRedirect";
import {
  OAUTH_FAILURE_COPY,
  isOAuthFailure,
  oauthFailureHref,
  resolveOAuthReturn,
  type OAuthReturnDeps,
} from "../lib/oauthReturn";
import { isUnprefixed } from "../lib/country";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (ok) pass++;
  else fail++;
}

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

// ── 1. safeNext ─────────────────────────────────
console.log("\nsafeNext — customer destinations only");
const accepted: [string, string][] = [
  ["/in", "/in"],
  ["/in/checkout", "/in/checkout"],
  ["/in/account/orders", "/in/account/orders"],
  ["/in/product/kerala-kasavu?size=M#reviews", "/in/product/kerala-kasavu?size=M#reviews"],
  ["/in/shop?q=a%2Fb", "/in/shop?q=a%2Fb"],
];
for (const [input, want] of accepted) {
  const got = safeNext(input);
  t(`accepts ${input}`, got === want, `got ${got}`);
}
const rejected: (string | null | undefined)[] = [
  null,
  undefined,
  "",
  "in/checkout",
  "//evil.example",
  "//evil.example/in",
  "/\\evil.example",
  "\\/evil.example",
  "/\\/evil.example",
  "https://evil.example/in",
  "http:evil.example",
  "javascript:alert(1)",
  " /in",
  "/in\n//evil.example",
  "/in\t",
  "/in\u0000",
  "/admin",
  "/admin/dashboard",
  "/ADMIN/mfa",
  "/api/auth/callback?next=/in",
  "/API/x",
  "/" + "a".repeat(600),
];
for (const input of rejected) {
  const got = safeNext(input);
  t(`rejects ${JSON.stringify(input)?.slice(0, 40)}`, got === "/in", `got ${got}`);
}
t("custom fallback is used on rejection", safeNext("//x", "") === "");
// Whatever is accepted resolves to this site, checked the way a browser would.
for (const [input] of accepted) {
  t(`${input} resolves to this origin`, new URL(safeNext(input), "https://www.thewovenne.com").origin === "https://www.thewovenne.com");
}

// ── 2. resolveOAuthReturn ───────────────────────
console.log("\nGoogle callback outcomes");

type Calls = { exchange: number; signOut: number; isStaff: number };
function double(over: Partial<{
  exchangeOk: boolean;
  user: { email: string | null; emailConfirmed: boolean } | null;
  staff: boolean | null;
}> = {}): { deps: OAuthReturnDeps; calls: Calls } {
  const calls: Calls = { exchange: 0, signOut: 0, isStaff: 0 };
  const deps: OAuthReturnDeps = {
    async exchange() {
      calls.exchange++;
      return { ok: over.exchangeOk ?? true };
    },
    async getUser() {
      return over.user === undefined ? { email: "customer@example.com", emailConfirmed: true } : over.user;
    },
    async isStaff() {
      calls.isStaff++;
      return over.staff === undefined ? false : over.staff;
    },
    async signOut() {
      calls.signOut++;
    },
  };
  return { deps, calls };
}
const qs = (o: Record<string, string>) => new URLSearchParams(o);

(async () => {
  {
    const { deps, calls } = double();
    const to = await resolveOAuthReturn(qs({ code: "c", next: "/in/checkout" }), deps);
    t("new or same-email customer → onward destination (checkout)", to === "/in/checkout", to);
    t("  …no sign-out on success", calls.signOut === 0);
  }
  {
    const { deps } = double();
    const to = await resolveOAuthReturn(qs({ code: "c" }), deps);
    t("no next → /in", to === "/in", to);
  }
  {
    const { deps } = double();
    const to = await resolveOAuthReturn(qs({ code: "c", next: "//evil.example" }), deps);
    t("unsafe next after a GOOD sign-in still stays on site → /in", to === "/in", to);
  }
  {
    const { deps } = double();
    const to = await resolveOAuthReturn(qs({ code: "c", next: "/admin/dashboard" }), deps);
    t("customer sign-in never delivers to /admin", to === "/in", to);
  }
  {
    const { deps, calls } = double();
    const to = await resolveOAuthReturn(
      qs({ error: "access_denied", error_description: "The user denied", next: "/in/checkout" }),
      deps
    );
    t("Google cancel → login?oauth=cancelled, onward kept", to === "/in/login?oauth=cancelled&from=%2Fin%2Fcheckout", to);
    t("  …no exchange attempted", calls.exchange === 0);
    t("  …provider text not passed on", !to.includes("denied"));
  }
  {
    const { deps } = double();
    const to = await resolveOAuthReturn(qs({ error: "server_error", error_description: "x" }), deps);
    t("provider/config error → oauth=failed", to === "/in/login?oauth=failed", to);
  }
  {
    const { deps, calls } = double();
    const to = await resolveOAuthReturn(qs({}), deps);
    t("no code → oauth=failed", to === "/in/login?oauth=failed", to);
    t("  …no exchange attempted", calls.exchange === 0);
  }
  {
    const { deps } = double({ exchangeOk: false });
    const to = await resolveOAuthReturn(qs({ code: "used", next: "/in/account" }), deps);
    t("failed exchange (other browser / reused code) → oauth=failed, onward kept", to === "/in/login?oauth=failed&from=%2Fin%2Faccount", to);
  }
  {
    const { deps, calls } = double({ user: null });
    const to = await resolveOAuthReturn(qs({ code: "c" }), deps);
    t("no user after exchange → oauth=failed and signed out", to === "/in/login?oauth=failed" && calls.signOut === 1, to);
  }
  {
    const { deps, calls } = double({ user: { email: "x@example.com", emailConfirmed: false } });
    const to = await resolveOAuthReturn(qs({ code: "c" }), deps);
    t("unverified email → oauth=unverified and signed out", to === "/in/login?oauth=unverified" && calls.signOut === 1, to);
    t("  …staff not even asked", calls.isStaff === 0);
  }
  {
    const { deps, calls } = double({ user: { email: null, emailConfirmed: true } });
    const to = await resolveOAuthReturn(qs({ code: "c" }), deps);
    t("no email at all → oauth=unverified and signed out", to === "/in/login?oauth=unverified" && calls.signOut === 1, to);
  }
  {
    const { deps, calls } = double({ staff: true });
    const to = await resolveOAuthReturn(qs({ code: "c", next: "/in/checkout" }), deps);
    t("staff via Google → generic oauth=failed and signed out", to.startsWith("/in/login?oauth=failed") && calls.signOut === 1, to);
  }
  {
    const { deps, calls } = double({ staff: null });
    const to = await resolveOAuthReturn(qs({ code: "c" }), deps);
    t("staff check unanswerable → fails closed, signed out", to === "/in/login?oauth=failed" && calls.signOut === 1, to);
  }

  console.log("\nFailure copy and links");
  t("every reason has customer copy", (["cancelled", "failed", "unverified"] as const).every((r) => OAUTH_FAILURE_COPY[r].length > 20));
  t("copy never mentions staff or admin", !Object.values(OAUTH_FAILURE_COPY).some((c) => /staff|admin/i.test(c)));
  t("isOAuthFailure rejects arbitrary values", !isOAuthFailure("<script>") && !isOAuthFailure(undefined) && isOAuthFailure("failed"));
  t("failure href drops an unsafe onward path", oauthFailureHref("failed", "//evil.example") === "/in/login?oauth=failed");

  // ── 3. Source rules ───────────────────────────
  console.log("\nScopes, privacy, admin separation");
  const customerAuth = code(read("lib/customerAuth.ts"));
  const google = customerAuth.slice(customerAuth.indexOf("startGoogleSignIn"));
  const googleFn = google.slice(0, google.indexOf("\n}\n"));
  t("Google sign-in requests no extra scopes", !/scopes\s*:/.test(googleFn));
  t("provider is google, return is /api/auth/callback", /provider:\s*"google"/.test(googleFn) && /\/api\/auth\/callback/.test(googleFn));
  t("return destination goes through safeNext", /safeNext\(from/.test(googleFn));

  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []
    );
  const appSource = ["app", "components", "lib"].flatMap(walk).map((f) => [f, code(read(f))] as const);
  const offenders = appSource.filter(([, s]) =>
    /people\.googleapis|googleapis\.com\/auth\/(user\.|contacts|birthday)|user\.gender|user\.birthday|genderFrom|inferGender/i.test(s)
  );
  t("no People API, gender, birthday or contacts anywhere", offenders.length === 0, offenders.map(([f]) => f).join(", "));

  const oauthUsers = appSource.filter(([, s]) => /signInWithOAuth|linkIdentity/.test(s)).map(([f]) => f);
  t("signInWithOAuth used only by lib/customerAuth (no linkIdentity)", oauthUsers.length === 1 && oauthUsers[0] === path.join("lib", "customerAuth.ts"), oauthUsers.join(", "));
  const adminSource = appSource.filter(([f]) => f.startsWith(path.join("app", "(admin)")) || f.startsWith(path.join("components", "admin")));
  t("admin pages offer no Google path", !adminSource.some(([, s]) => /startGoogleSignIn|GoogleSignInButton|signInWithOAuth|oauth/i.test(s)), adminSource.filter(([, s]) => /startGoogleSignIn|GoogleSignInButton|signInWithOAuth|oauth/i.test(s)).map(([f]) => f).join(", "));

  t("callback lives under /api (no country redirect)", isUnprefixed("/api/auth/callback") && fs.existsSync(path.join(root, "app/api/auth/callback/route.ts")));
  const middleware = read("middleware.ts");
  t("middleware matcher still excludes /api", /\(\?!api\|/.test(middleware));
  const route = code(read("app/api/auth/callback/route.ts"));
  t("callback validates with getUser and checks is_staff", /auth\.getUser\(\)/.test(route) && /rpc\("is_staff"\)/.test(route));
  t("callback never logs the code, tokens or provider text", !/console\.\w+\([^)]*(code|token|error_description|message)/.test(route.replace(/error\.name/g, "")));
  t("callback response is not cacheable", /no-store/.test(route));

  // The referrer classifier legitimately says "google / organic"; the rule is
  // that no auth event exists for a browser to report, so nothing about a
  // sign-in — email, Google ID, auth UID, name — has a way in.
  const { CLIENT_EVENT_TYPES } = await import("../lib/analyticsCollect");
  t("analytics has no auth/login/signup event types", !CLIENT_EVENT_TYPES.some((e: string) => /auth|login|sign|google|oauth|account/i.test(e)), CLIENT_EVENT_TYPES.join(","));
  const authSurfaces = ["lib/customerAuth.ts", "lib/oauthReturn.ts", "app/api/auth/callback/route.ts", "components/account/GoogleSignInButton.tsx", "components/account/LoginForm.tsx", "components/account/SignupForm.tsx"];
  t("auth surfaces send nothing to analytics", !authSurfaces.some((f) => /analytics|track\(/i.test(code(read(f)))));

  const loginForm = code(read("components/account/LoginForm.tsx"));
  t("password login unchanged: signInWithPassword path still via logIn()", /await logIn\(email, password\)/.test(loginForm));
  t("login redirect uses safeNext (the //host hole)", /safeNext\(from, AFTER_LOGIN\)/.test(loginForm) && !/from\.startsWith\("\/"\)/.test(loginForm));
  for (const f of ["components/account/SignupForm.tsx", "components/account/VerifyForm.tsx", "lib/signupVerifyCopy.ts"]) {
    t(`${f} uses safeNext`, /safeNext\(/.test(code(read(f))) && !/startsWith\("\/\/"\)/.test(code(read(f))));
  }
  t("staff refusal on the password form still in place", /rpc\("is_staff"\)[\s\S]*Incorrect email or password/.test(read("lib/customerAuth.ts")));
  const button = code(read("components/account/GoogleSignInButton.tsx"));
  t("Google button is off unless NEXT_PUBLIC_GOOGLE_SIGN_IN is exactly \"true\"", /NEXT_PUBLIC_GOOGLE_SIGN_IN === "true"/.test(button) && /if \(!GOOGLE_SIGN_IN_ENABLED\) return null/.test(button));
  t("login and signup show Google only through the gated block", ["components/account/LoginForm.tsx", "components/account/SignupForm.tsx"].every((f) => { const s = code(read(f)); return /<GoogleSignInBlock/.test(s) && !/<GoogleSignInButton/.test(s); }));
  const gate = read("components/cart/CheckoutGate.tsx");
  t("guest checkout still offered first", /Continue as guest/.test(gate) && gate.indexOf("Continue as guest") < gate.indexOf("Create an account"));

  // ── 4. Settings → Password, by sign-in method ──
  console.log("\nSettings password panel");
  const { hasPasswordFrom } = await import("../lib/signInMethods");
  const rpc = (data: unknown, error: unknown = null) => hasPasswordFrom({ data, error });
  t("Google-only, no password (rpc false) → \"Set a password\"", rpc(false) === false);
  t("Google-only AFTER setting a password (rpc true) → \"Change password\"", rpc(true) === true);
  t("password-only account (rpc true) → \"Change password\"", rpc(true) === true);
  t("Google + password account (rpc true) → \"Change password\"", rpc(true) === true);
  t("unknown (rpc NULL: no live session) → \"Change password\", never a false \"no password\"", rpc(null) === true);
  t("rpc error (e.g. before 0072 is applied) → \"Change password\"", rpc(null, { message: "x" }) === true && rpc(false, { message: "x" }) === true);
  t("anything but an exact false → \"Change password\"", [undefined, 0, "", "false", {}].every((v) => rpc(v) === true));

  const settings = code(read("app/(storefront)/in/account/settings/page.tsx"));
  t("Settings asks the database (account_has_password), not the identities list",
    /hasPasswordFrom\(await supabase\.rpc\("account_has_password"\)\)/.test(settings) && !/identities/.test(settings) && /hasPassword=\{hasPassword\}/.test(settings));
  t("account_has_password is called without arguments (it can only answer for the caller)", !/rpc\("account_has_password",/.test(settings));
  const sql = read("supabase/migrations/0072_account_has_password.sql");
  t("0072: no parameters, auth.uid() only, live session required, boolean only",
    /create function public\.account_has_password\(\)\s*returns boolean/.test(sql) && /u\.id = auth\.uid\(\)/.test(sql) && /from auth\.sessions s/.test(sql) && !/returns (table|setof|text|jsonb)/i.test(sql));
  t("0072: EXECUTE revoked from public and anon, granted to authenticated",
    /revoke execute on function public\.account_has_password\(\) from public, anon;/.test(sql) && /grant execute on function public\.account_has_password\(\) to authenticated;/.test(sql));

  const cp = code(read("components/account/ChangePassword.tsx"));
  t("Settings → Password has no password field of any kind", !/<AuthField|<input|type="password"|Current password|current-password|new-password/.test(cp));
  t("Settings → Password never re-signs-in or writes a password", !/signInWithPassword|updateUser|setNewPassword|rpc\(/.test(cp));
  t("one action for every account: Supabase's emailed recovery link to the account's own address", (cp.match(/<Button\b/g) ?? []).length === 1 && /requestPasswordReset\(email\)/.test(cp) && !/<Link\b|<a\b|forgot-password/.test(cp));
  t("has a password → \"Change password\" with the spec wording", /"Use a secure email link to change your password\."/.test(cp) && /"Change password"/.test(cp));
  t("Google only → \"Set a password\" with the spec wording", /"You currently sign in with Google\. You can also create a password for this account\."/.test(cp) && /"Set a password"/.test(cp));
  t("hasPassword picks the wording only (both branches share the one send())", (cp.match(/async function send\(/g) ?? []).length === 1 && !/if \(!hasPassword\) return/.test(cp));
  t("sent: says where the link went, and to open it in this browser", /We&apos;ve emailed a link to/.test(cp) && /in\s+this browser/.test(cp));
  const ca = read("lib/customerAuth.ts");
  t("recovery link returns to this site's /reset-password page only", /resetPasswordForEmail\([\s\S]*redirectTo: `\$\{window\.location\.origin\}\$\{cPath\("\/reset-password"\)\}`/.test(ca));
  t("Forgot password? still sends the same link", /requestPasswordReset\(/.test(code(read("components/account/ForgotPasswordForm.tsx"))));
  const { friendlyAuthError } = await import("../lib/customerAuth").catch(() => ({ friendlyAuthError: null as null | ((m: string) => string) }));
  if (friendlyAuthError) {
    t("a second click inside Supabase's cooldown gets a plain message", /wait a minute/.test(friendlyAuthError("For security purposes, you can only request this after 52 seconds.")));
    // Supabase's own wording (GoTrue v2.197 api_user.go / password checks).
    t("reusing the current password → \"already have\", not a length error", /already have/.test(friendlyAuthError("New password should be different from the old password.")) && !/8 characters/.test(friendlyAuthError("New password should be different from the old password.")));
    t("too short → the length message", /at least 8 characters/.test(friendlyAuthError("Password should be at least 8 characters.")));
    t("a character-class rule is passed through, not called a length problem", !/8 characters/.test(friendlyAuthError("Password should contain at least one character of each: abc, 123")));
  } else {
    t("a second click inside Supabase's cooldown gets a plain message", /for security purposes"\) && m\.includes\("only request this after"\)\)\s*return "We've just sent a link\. Please wait a minute/.test(ca));
  }

  // ── 5. The new-password page only opens for a recovery link ──
  console.log("\nReset page");
  const { recoverySessionOpen, RECOVERY_WINDOW_SECONDS } = await import("../lib/signInMethods");
  const now = Date.UTC(2026, 9, 17, 14, 0, 0);
  const s = now / 1000;
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = (claims: unknown) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(claims)}.sig`;
  const amr = (...e: unknown[]) => jwt({ sub: "u", amr: e });
  t("recovery link used just now → form", recoverySessionOpen(amr({ method: "recovery", timestamp: s - 5 }), now));
  t("recovery link used 14 min ago → form", recoverySessionOpen(amr({ method: "recovery", timestamp: s - 14 * 60 }), now));
  t("recovery link opened over 15 min ago (abandoned) → no form", RECOVERY_WINDOW_SECONDS === 15 * 60);
  t("recovery link used past the window → no form", !recoverySessionOpen(amr({ method: "recovery", timestamp: s - RECOVERY_WINDOW_SECONDS - 1 }), now));
  t("password session → no form (a signed-in browser is not proof)", !recoverySessionOpen(amr({ method: "password", timestamp: s - 5 }), now));
  t("Google session → no form", !recoverySessionOpen(amr({ method: "oauth", timestamp: s - 5 }), now));
  t("signup-code session → no form", !recoverySessionOpen(amr({ method: "otp", timestamp: s - 5 }), now));
  t("password session that also has a fresh recovery entry → form", recoverySessionOpen(amr({ method: "password", timestamp: s - 900 }, { method: "recovery", timestamp: s - 5 }), now));
  t("timestamp far in the future → no form", !recoverySessionOpen(amr({ method: "recovery", timestamp: s + 3600 }), now));
  t("string-only amr (no time) → no form", !recoverySessionOpen(jwt({ amr: ["recovery"] }), now));
  t("no session / garbage token / no amr → no form", [null, undefined, "", "x", "a.b.c", "a.!!!.c", jwt({ sub: "u" }), jwt(null), jwt({ amr: "recovery" })].every((tk) => !recoverySessionOpen(tk as string, now)));
  t("base64url payloads with - and _ decode", recoverySessionOpen(jwt({ pad: "??>>~~", amr: [{ method: "recovery", timestamp: s }] }), now));

  const rp = code(read("components/account/ResetPasswordForm.tsx"));
  t("reset page opens its form only for a recovery session, never for any session", (rp.match(/recoverySessionOpen\(/g) ?? []).length === 2 && !/if \(data\.session\) setReady|\|\| session\) setReady/.test(rp));
  t("reset page asks for New + Confirm only", ["New password", "Confirm new password"].every((l) => rp.includes(`label="${l}"`)) && !/Current password|current-password/.test(rp));
  t("reset page saves through updateUser on that session (setNewPassword), nothing custom", /await setNewPassword\(password\)/.test(rp) && !/service_role|SERVICE_ROLE|admin\.|fetch\(/.test(rp));
  const afterSave = rp.slice(rp.indexOf("await setNewPassword(password)"), rp.indexOf("if (saved)"));
  t("ONE USE: a saved password ends the recovery session before the confirmation shows", /if \(!result\.ok\)[\s\S]*return;[\s\S]*await logOut\(\);[\s\S]*setSaved\(true\)/.test(afterSave));
  t("ONE USE: a failed save keeps the session (they can fix the password and retry)", /if \(!result\.ok\) \{[^}]*return;\s*\}/.test(afterSave) && !/if \(!result\.ok\) \{[^}]*logOut/.test(afterSave));
  t("after saving: 'Your password is saved', signed out, links to sign in and the shop", /Your password is saved/.test(rp) && /signed you out/.test(rp) && /href="\/in\/login\?from=%2Fin%2Faccount%2Fsettings"/.test(rp) && /href="\/in"/.test(rp));
  t("logOut ends only this device's session (scope local) and clears the cart", /resetForSignOut\(\)[\s\S]*signOut\(\{ scope: "local" \}\)/.test(code(read("lib/customerAuth.ts"))));
  t("expired / used / other-browser link → explains and offers a fresh link", /That link has expired/.test(rp) && /href="\/in\/forgot-password"/.test(rp) && /browser you asked for them in/.test(rp));
  t("reset page sends nothing to analytics and never prints the URL", !/analytics|track\(|location\.(href|search|hash)|console\./.test(rp));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
