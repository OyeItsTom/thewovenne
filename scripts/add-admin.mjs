#!/usr/bin/env node
/**
 * Create an admin account.
 *
 * Two steps, both required:
 *   1. Create the Supabase Auth user (email + temporary password, pre-confirmed
 *      so they don't need to click a verification email).
 *   2. Insert their profiles row with is_admin = true. This is NOT automatic —
 *      the handle_new_user trigger is deliberately unwired (see
 *      supabase/migrations/0002), so a user created without this step can sign
 *      in and then hit an empty dashboard.
 *
 * Usage:
 *   node scripts/add-admin.mjs --email person@example.com
 *   node scripts/add-admin.mjs --email person@example.com --password 'Chosen-Pass'
 *   node scripts/add-admin.mjs --list
 *   node scripts/add-admin.mjs --email person@example.com --revoke
 *
 * Prints the temporary password once. Share it over something better than
 * email or chat, and have them change it at /admin/account after first login.
 *
 * Reads credentials from .env.local. The service role key bypasses RLS.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const email = flag("--email");
const chosenPassword = flag("--password");
const listOnly = args.includes("--list");
const revoke = args.includes("--revoke");

const supabase = createClient(url, key, { auth: { persistSession: false } });

/** Shell-safe alphabet, 20 chars — roughly 119 bits. */
const generatePassword = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(randomBytes(20))
    .map((b) => alphabet[b % alphabet.length])
    .join("");
};

if (listOnly) {
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("email, is_admin, created_at")
    .order("created_at");
  if (error) {
    console.error("Could not read profiles:", error.message);
    process.exit(1);
  }
  const { data: authData } = await supabase.auth.admin.listUsers();
  console.log("\nAccounts\n");
  for (const p of profiles) {
    const u = authData.users.find((x) => x.email === p.email);
    const factors = (u?.factors ?? []).filter((f) => f.status === "verified").length;
    console.log(
      `  ${p.email.padEnd(30)} ${p.is_admin ? "ADMIN" : "     "}  ` +
        `MFA: ${factors ? `${factors} factor(s)` : "not enrolled"}`
    );
  }
  console.log();
  process.exit(0);
}

if (!email) {
  console.error("Pass --email person@example.com  (or --list)");
  process.exit(1);
}

const { data: existing } = await supabase.auth.admin.listUsers();
const found = existing.users.find((u) => u.email === email);

if (revoke) {
  if (!found) {
    console.error(`No auth user with email ${email}`);
    process.exit(1);
  }
  const { error } = await supabase
    .from("profiles")
    .update({ is_admin: false })
    .eq("id", found.id);
  if (error) {
    console.error("Could not revoke:", error.message);
    process.exit(1);
  }
  console.log(`\n${email} is no longer an admin. The login still exists — delete it in`);
  console.log("Supabase → Authentication → Users if you want it gone entirely.\n");
  process.exit(0);
}

const password = chosenPassword ?? generatePassword();
let userId = found?.id;

if (found) {
  console.log(`\n${email} already exists — resetting its password and granting admin.`);
  const { error } = await supabase.auth.admin.updateUserById(found.id, { password });
  if (error) {
    console.error("Could not set password:", error.message);
    process.exit(1);
  }
} else {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no verification email; you're vouching for them
  });
  if (error) {
    console.error("Could not create user:", error.message);
    process.exit(1);
  }
  userId = data.user.id;
  console.log(`\nCreated auth user ${email}`);
}

// The trigger is unwired, so the profile row is this script's responsibility.
const { error: profileError } = await supabase
  .from("profiles")
  .upsert({ id: userId, email, is_admin: true }, { onConflict: "id" });

if (profileError) {
  console.error("User exists but granting admin FAILED:", profileError.message);
  console.error("They can sign in but will see an empty dashboard. Fix with:");
  console.error(`  update profiles set is_admin = true where email = '${email}';`);
  process.exit(1);
}

console.log(`Granted admin (profiles.is_admin = true)\n`);
console.log(`  Email:              ${email}`);
console.log(`  Temporary password: ${password}\n`);
console.log("They should:");
console.log("  1. Sign in at https://www.thewovenne.com/admin/login");
console.log("  2. Enrol their own authenticator when prompted (their phone, not yours)");
console.log("  3. Change this password at /admin/account\n");
