#!/usr/bin/env node
/**
 * Emergency recovery: remove an admin's TOTP factor so they can sign in with
 * just a password and re-enrol.
 *
 * WHY THIS EXISTS
 * Supabase requires aal2 to unenroll a verified factor — which means the
 * authenticator you've lost is the only thing that could remove it. There are
 * no backup codes. Without a service-role escape hatch, a lost or wiped phone
 * locks you out of /admin permanently.
 *
 * Usage:
 *   node scripts/reset-admin-mfa.mjs                      # list factors
 *   node scripts/reset-admin-mfa.mjs --delete             # remove them all
 *   node scripts/reset-admin-mfa.mjs --email a@b.com      # a different user
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * The service role key bypasses RLS — never expose this script to the browser.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trim().startsWith("#")) {
    process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
const email =
  args.includes("--email") ? args[args.indexOf("--email") + 1] : "admin@thewovenne.com";
const doDelete = args.includes("--delete");

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data, error } = await supabase.auth.admin.listUsers();
if (error) {
  console.error("Could not list users:", error.message);
  process.exit(1);
}

const user = data.users.find((u) => u.email === email);
if (!user) {
  console.error(`No auth user with email ${email}. Users: ${data.users.map((u) => u.email).join(", ")}`);
  process.exit(1);
}

// listUsers() does NOT populate `factors` — it comes back undefined for every
// user, so reading it here reported "no MFA factors" for an account that had
// one, and --delete then deleted nothing while printing success. In the one
// situation this script exists for, that is the worst possible failure.
// getUserById does return them.
const { data: full, error: fetchError } = await supabase.auth.admin.getUserById(user.id);
if (fetchError) {
  console.error("Could not read that user:", fetchError.message);
  process.exit(1);
}
const factors = full.user?.factors ?? [];
console.log(`\n${email}  (${user.id})`);
if (factors.length === 0) {
  console.log("  no MFA factors — this account signs in with a password alone\n");
  process.exit(0);
}

for (const f of factors) {
  console.log(`  ${f.id}  ${f.factor_type}  ${f.status}  ${f.friendly_name ?? ""}`);
}

if (!doDelete) {
  console.log("\nRe-run with --delete to remove these and allow a fresh enrolment.\n");
  process.exit(0);
}

for (const f of factors) {
  const { error: delError } = await supabase.auth.admin.mfa.deleteFactor({
    userId: user.id,
    id: f.id,
  });
  console.log(delError ? `  FAILED ${f.id}: ${delError.message}` : `  deleted ${f.id}`);
}
console.log("\nDone. Sign in with your password — you'll be asked to enrol again.\n");
