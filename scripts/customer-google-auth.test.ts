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
  const { signsInWithPassword } = await import("../lib/signInMethods");
  const ids = (...p: string[]) => ({ identities: p.map((provider) => ({ provider })) });
  t("Google only → no password (set-a-password panel)", signsInWithPassword(ids("google")) === false);
  t("email only → password form", signsInWithPassword(ids("email")) === true);
  t("email + Google (linked) → password form kept", signsInWithPassword(ids("email", "google")) === true);
  t("Google + email in either order → password form", signsInWithPassword(ids("google", "email")) === true);
  t("no identities listed → password form, as before", signsInWithPassword({ identities: [] }) === true && signsInWithPassword({}) === true);
  t("an email address alone never implies a password", signsInWithPassword({ ...ids("google"), email: "a@b.c", email_confirmed_at: "x" } as never) === false);

  const settings = code(read("app/(storefront)/in/account/settings/page.tsx"));
  t("Settings decides from getUser() identities via signsInWithPassword", /auth\.getUser\(\)/.test(settings) && /hasPassword=\{user \? signsInWithPassword\(user\) : true\}/.test(settings));

  const cp = code(read("components/account/ChangePassword.tsx"));
  const googleOnly = cp.slice(cp.indexOf("function SetPasswordByEmail"));
  const passwordForm = cp.slice(cp.indexOf("export default function ChangePassword"), cp.indexOf("function SetPasswordByEmail"));
  t("Google-only branch renders the set-a-password panel before any form", /if \(!hasPassword\) return <SetPasswordByEmail email=\{email\} \/>/.test(passwordForm));
  t("Google-only panel has no Current password field", !/Current password|current-password|<AuthField/.test(googleOnly));
  t("Google-only panel: the spec wording", /You currently sign in with Google\./.test(googleOnly) && /Want to also sign in with email and password\?/.test(googleOnly));
  t("Google-only panel: exactly one action, \"Set a password\"", (googleOnly.match(/<Button\b/g) ?? []).length === 1 && /"Set a password"/.test(googleOnly) && !/<Link\b|<a\b|forgot-password/.test(googleOnly));
  t("Set a password uses Supabase's emailed recovery (requestPasswordReset), no shortcut", /requestPasswordReset\(email\)/.test(googleOnly) && !/updateUser|setNewPassword/.test(googleOnly));
  t("password form keeps Current / New / Confirm and re-verifies the current one", ["Current password", "New password", "Confirm new password"].every((l) => passwordForm.includes(`label="${l}"`)) && /signInWithPassword\(/.test(passwordForm));
  const ca = read("lib/customerAuth.ts");
  t("recovery link returns to this site's /reset-password page only", /resetPasswordForEmail\([\s\S]*redirectTo: `\$\{window\.location\.origin\}\$\{cPath\("\/reset-password"\)\}`/.test(ca));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
