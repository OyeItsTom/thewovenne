/**
 * The password rule: 15 characters, no composition rules, 72 bytes at most —
 * the same everywhere a password is chosen.
 *
 *   npx --cache <scratch>/npmcache --yes tsx@4.19.2 scripts/password-policy.test.ts
 *
 * What is proven:
 *   1. passwordPolicyProblem / passwordProblem — 14 refused, 15 accepted;
 *      spaces, passphrases, all-lowercase and all-digit passwords accepted;
 *      length counts characters (an emoji is one), the ceiling counts UTF-8
 *      bytes, as GoTrue does; nothing is trimmed.
 *   2. Supabase's own refusals are worded for customers (length, too long,
 *      reuse), using GoTrue v2.197.0's exact messages.
 *   3. Source rules: signup, the reset link (which is also how a Google-only
 *      customer sets a first password), the admin page and add-admin.mjs all
 *      apply the rule; signing in never does, so older shorter passwords keep
 *      working; no form caps or trims a password; no "8 characters" is left.
 *
 * Exits non-zero on failure.
 */
import fs from "node:fs";
import path from "node:path";
import {
  PASSWORD_HINT,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  passwordBytes,
  passwordLength,
  passwordPolicyProblem,
} from "../lib/passwordPolicy";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}
const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

(async () => {
  console.log("\n=== 1. the rule ===");
  t("the minimum is 15 and the ceiling 72 bytes", PASSWORD_MIN_LENGTH === 15 && PASSWORD_MAX_BYTES === 72);
  t("14 characters → refused with the length message", passwordPolicyProblem("a".repeat(14)) === PASSWORD_TOO_SHORT);
  t("15 characters → accepted", passwordPolicyProblem("a".repeat(15)) === null);
  t("empty → refused", passwordPolicyProblem("") === PASSWORD_TOO_SHORT);
  t("all lowercase, no capital/number/symbol → accepted", passwordPolicyProblem("riverbanksunset") === null);
  t("all digits → accepted (no class rules either way)", passwordPolicyProblem("123456789012345") === null);
  t("passphrase with spaces → accepted", passwordPolicyProblem("correct horse battery") === null);
  t("spaces count and are not trimmed: 13 letters + 2 spaces = 15", passwordPolicyProblem(" abcdefghijklm ") === null && passwordPolicyProblem("abcdefghijklm") === PASSWORD_TOO_SHORT);
  t("15 spaces is 15 characters (nothing is stripped)", passwordLength(" ".repeat(15)) === 15);
  t("an emoji is one character: 13 letters + 1 emoji = 14 → refused", passwordLength("abcdefghijklm😀") === 14 && passwordPolicyProblem("abcdefghijklm😀") === PASSWORD_TOO_SHORT);
  t("…though it is 15 UTF-16 units — length is not String.length", "abcdefghijklm😀".length === 15);
  t("password-manager style 32 random chars → accepted", passwordPolicyProblem("x7$Lq!9vR#2mPz@4Kw&8nTb^6Yc*0Hd%") === null);

  console.log("\n=== 1b. the ceiling is bytes ===");
  t("72 ASCII bytes → accepted; 73 → too long", passwordPolicyProblem("a".repeat(72)) === null && passwordPolicyProblem("a".repeat(73)) === PASSWORD_TOO_LONG);
  t("é is 2 bytes: 36 → 72 bytes accepted; 37 → too long", passwordBytes("é".repeat(36)) === 72 && passwordPolicyProblem("é".repeat(36)) === null && passwordPolicyProblem("é".repeat(37)) === PASSWORD_TOO_LONG);
  t("Devanagari is 3 bytes: 24 → 72 accepted; 25 → too long", passwordBytes("क".repeat(24)) === 72 && passwordPolicyProblem("क".repeat(24)) === null && passwordPolicyProblem("क".repeat(25)) === PASSWORD_TOO_LONG);
  t("emoji are 4 bytes: 18 → 72 accepted; 19 → too long", passwordBytes("😀".repeat(18)) === 72 && passwordPolicyProblem("😀".repeat(18)) === null && passwordPolicyProblem("😀".repeat(19)) === PASSWORD_TOO_LONG);
  t("anything the app accepts clears Supabase's byte minimum (bytes ≥ characters)", ["a".repeat(15), "é".repeat(15), "😀".repeat(15), " ".repeat(15)].every((p) => passwordBytes(p) >= PASSWORD_MIN_LENGTH));

  console.log("\n=== 1c. passwordProblem (customer forms) ===");
  const { passwordProblem, friendlyAuthError } = await import("../lib/customerAuth");
  t("14 refused, 15 accepted", passwordProblem("a".repeat(14)) === PASSWORD_TOO_SHORT && passwordProblem("a".repeat(15)) === null);
  t("too long refused", passwordProblem("a".repeat(73)) === PASSWORD_TOO_LONG);
  t("mismatch still caught", passwordProblem("a".repeat(15), "b".repeat(15)) === "The two passwords don't match.");
  t("length is judged before the match", passwordProblem("short", "short") === PASSWORD_TOO_SHORT);
  t("a long matching passphrase passes", passwordProblem("a quiet morning walk", "a quiet morning walk") === null);

  console.log("\n=== 2. Supabase's refusals, worded ===");
  // GoTrue v2.197.0 internal/api/password.go and user.go.
  t("\"Password should be at least 15 characters.\" → the 15 message", friendlyAuthError("Password should be at least 15 characters.") === PASSWORD_TOO_SHORT);
  t("\"Password cannot be longer than 72 characters\" → the too-long message", friendlyAuthError("Password cannot be longer than 72 characters") === PASSWORD_TOO_LONG);
  t("reuse → \"already have\", not a length error", /already have/.test(friendlyAuthError("New password should be different from the old password.")) && friendlyAuthError("New password should be different from the old password.") !== PASSWORD_TOO_SHORT);
  t("a character-class rule (if one were ever set) is not called a length problem", friendlyAuthError("Password should contain at least one character of each: abc, 123") !== PASSWORD_TOO_SHORT);

  console.log("\n=== 3. where the rule applies ===");
  const signup = code(read("components/account/SignupForm.tsx"));
  const reset = code(read("components/account/ResetPasswordForm.tsx"));
  const admin = code(read("app/(admin)/admin/account/page.tsx"));
  const ca = code(read("lib/customerAuth.ts"));
  const login = code(read("components/account/LoginForm.tsx"));
  const settings = code(read("components/account/ChangePassword.tsx"));
  const addAdmin = read("scripts/add-admin.mjs");
  t("signup checks passwordProblem before signUp, shows the 15 hint", /passwordProblem\(form\.password, form\.confirm\)[\s\S]*await signUp\(/.test(signup) && /hint=\{PASSWORD_HINT\}/.test(signup));
  t("reset/set-a-password checks passwordProblem before saving, shows the 15 hint", /passwordProblem\(password, confirm\)[\s\S]*await setNewPassword\(password\)/.test(reset) && /hint=\{PASSWORD_HINT\}/.test(reset));
  t("the hint says 15 and that spaces are fine", /At least \$\{PASSWORD_MIN_LENGTH\} characters\. Spaces are fine/.test(read("lib/passwordPolicy.ts")) && PASSWORD_HINT.startsWith("At least 15 characters."));
  t("Google-only 'Set a password' has no field of its own — it emails the same reset link", !/type="password"|setNewPassword|updateUser/.test(settings) && /requestPasswordReset\(/.test(settings));
  t("the reset form still opens only for a recovery session", (reset.match(/recoverySessionOpen\(/g) ?? []).length === 2);
  t("admin page uses passwordPolicyProblem before updateUser; no 12 left", /passwordPolicyProblem\(next\)[\s\S]*updateUser\(\{/.test(admin) && !/MIN_LENGTH = 12|12\+ characters|length < 12/.test(admin) && /at least \$\{PASSWORD_MIN_LENGTH\} characters/.test(admin));
  t("admin page still verifies the current password first", /signInWithPassword\(\{[\s\S]*password: current/.test(admin));
  t("add-admin.mjs refuses a --password under 15 characters or over 72 bytes", /Array\.from\(chosenPassword\)\.length < 15/.test(addAdmin) && /Buffer\.byteLength\(chosenPassword, "utf8"\) > 72/.test(addAdmin));
  t("add-admin's generated password is 20 characters (clears 15)", /randomBytes\(20\)/.test(addAdmin));
  const logInFn = ca.slice(ca.indexOf("export async function logIn"), ca.indexOf("}", ca.indexOf("signInWithPassword")));
  t("signing in never applies the length rule — older shorter passwords keep working", !/passwordProblem|passwordPolicyProblem/.test(logInFn) && !/passwordProblem|passwordPolicyProblem|PASSWORD_MIN/.test(login));
  t("logIn and setNewPassword send the password exactly as typed (no trim)", /signInWithPassword\(\{\s*email: email\.trim\(\)\.toLowerCase\(\),\s*password,/.test(ca) && /updateUser\(\{ password \}\)/.test(ca));
  t("no password input is capped (maxLength) and new ones say new-password", ![signup, reset, admin].some((s) => /type="password"[^>]*maxLength/.test(s)) && (signup.match(/autoComplete="new-password"/g) ?? []).length === 2 && (reset.match(/autoComplete="new-password"/g) ?? []).length === 2);
  const stale = ["components/account", "app", "lib"].flatMap((d) => {
    const walk = (p: string): string[] => fs.statSync(path.join(root, p)).isDirectory() ? fs.readdirSync(path.join(root, p)).flatMap((f) => walk(path.join(p, f))) : /\.(tsx?|mjs)$/.test(p) ? [p] : [];
    return walk(d).filter((f) => /at least 8 characters|8\+ characters/i.test(read(f)));
  });
  t("no '8 characters' copy is left anywhere", stale.length === 0, stale.join(", "));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
