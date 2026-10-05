/**
 * Customers can change their own profile; nothing else can — and the profile
 * page only says "Saved." when it was.
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/profile-update.test.ts
 *
 * The database half starts from PRODUCTION'S STATE as verified on 5 October
 * 2026 — the migrations replayed, then 0002's two UPDATE policies dropped —
 * proves the defect there (a customer's own UPDATE matches nothing), applies
 * 0063 unmodified, and then checks every role through the real policies,
 * grants and is_admin(). Without embedded-postgres that half is skipped and
 * the run exits non-zero rather than passing.
 */
import fs from "node:fs";
import path from "node:path";
import { PROFILE_NOT_SAVED, profileUpdateResult } from "../lib/profileUpdate";
import { asAdmin, asRoot, asStaffPasswordOnly, asUser, failure, makeAdmin, startEngine, type Client } from "./pg-world";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

console.log("\nprofileUpdateResult — success means one row came back");
t("one row → success", profileUpdateResult([{ id: "x" }], null).ok === true);
t("database error → failure with its message", (() => {
  const r = profileUpdateResult(null, { message: "permission denied for table profiles" });
  return !r.ok && r.error === "permission denied for table profiles";
})());
t("zero rows (RLS matched nothing) → failure", (() => {
  const r = profileUpdateResult([], null);
  return !r.ok && r.error === PROFILE_NOT_SAVED;
})());
t("null data, no error → failure", !profileUpdateResult(null, null).ok);
t("not an array → failure", !profileUpdateResult({ id: "x" }, null).ok);
t("two rows → failure (an own-row update can only ever touch one)", !profileUpdateResult([{ id: "a" }, { id: "b" }], null).ok);

console.log("\nthe profile form and its write");
const form = fs.readFileSync("components/account/ProfileForm.tsx", "utf8");
const auth = fs.readFileSync("lib/customerAuth.ts", "utf8");
const saveFn = auth.slice(auth.indexOf("export async function saveProfileName"), auth.indexOf("export async function setMarketingConsent"));
t("ProfileForm saves through saveProfileName", /await saveProfileName\(/.test(form));
t("ProfileForm no longer writes profiles itself", !/from\("profiles"\)/.test(form) && !/\.update\(/.test(form));
t("ProfileForm shows Saved only after an ok result",
  /if \(!result\.ok\) return setError\(result\.error\);\s*setSaved\(true\)/.test(form));
t("saveProfileName asks for the row back", /\.select\("id"\)/.test(saveFn));
t("saveProfileName decides through profileUpdateResult", /return profileUpdateResult\(data, error\)/.test(saveFn));
t("saveProfileName writes only full_name", /\.update\(\{ full_name: name\.trim\(\) \}\)/.test(saveFn));
const addr = auth.slice(auth.indexOf("export async function setDefaultAddress"), auth.indexOf("export async function saveProfileName"));
t("address save already checks the row came back (left unchanged)", /\.select\("id"\)/.test(addr) && /!data\?\.length/.test(addr));

const MIGRATION = fs.readFileSync(path.join("supabase", "migrations", "0063_restore_profiles_update_policies.sql"), "utf8");

(async () => {
  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database half — embedded-postgres not found (set PG_HARNESS_DIR)");
    console.log(`\n${pass} passed, ${fail} failed (DB SKIPPED)\n`);
    process.exit(fail ? 1 : 2);
  }
  try {
    await engine.database("w");
    const c = await engine.connect("w");

    const customer = async (email: string) => {
      await asRoot(c);
      const id = (await c.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id as string;
      // 0023's trigger creates the profile; make sure, as production would have it.
      await c.query("insert into profiles (id, email) values ($1, $2) on conflict (id) do nothing", [id, email]);
      await c.query("update profiles set full_name = 'Original' where id = $1", [id]);
      return id;
    };
    const rename = async (target: string, name = "Changed") =>
      (await c.query("update profiles set full_name = $2 where id = $1 returning id", [target, name])).rowCount;
    const nameOf = async (id: string) => {
      await asRoot(c);
      return (await c.query("select full_name from profiles where id = $1", [id])).rows[0]?.full_name;
    };
    const policies = async () => {
      await asRoot(c);
      return (await c.query(
        "select policyname||'|'||cmd||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') p from pg_policies where schemaname='public' and tablename='profiles' order by 1"
      )).rows.map((r) => r.p as string);
    };

    const alice = await customer("alice@example.test");
    const bob = await customer("bob@example.test");
    const admin = await makeAdmin(c, "staff@example.test");
    const intended = await policies();

    console.log("\nproduction's state: the UPDATE policies missing");
    await asRoot(c);
    await c.query('drop policy "Users update own profile" on profiles');
    await c.query('drop policy "Admins update any profile" on profiles');
    const allPoliciesBefore = (await c.query("select schemaname||tablename||policyname||coalesce(qual,'')||coalesce(with_check,'') p from pg_policies order by 1")).rows.map((r) => r.p);
    await asUser(c, alice, "aal1");
    t("defect reproduced: a customer's own UPDATE matches nothing", (await rename(alice)) === 0);
    await asAdmin(c, admin);
    t("defect reproduced: an aal2 admin's UPDATE matches nothing", (await rename(bob)) === 0);

    console.log("\n0063 refuses an unexpected schema");
    for (const [label, setup, undo] of [
      ["an unexpected UPDATE policy", `create policy "Anyone update" on profiles for update to authenticated using (true)`, `drop policy "Anyone update" on profiles`],
      ["a customer able to UPDATE is_admin", `grant update (is_admin) on profiles to authenticated`, `revoke update (is_admin) on profiles from authenticated`],
      ["a changed SELECT policy", `alter policy "Users read own profile" on profiles using (true)`, `alter policy "Users read own profile" on profiles using (id = auth.uid())`],
      ["a same-named UPDATE policy with a different rule", `create policy "Users update own profile" on profiles for update to authenticated using (true) with check (true)`, `drop policy "Users update own profile" on profiles`],
    ] as const) {
      await asRoot(c);
      await c.query(setup);
      await c.query("begin");
      const msg = await failure(() => c.query(MIGRATION));
      await c.query("rollback");
      t(`refused: ${label}`, msg.includes("MIGRATION_0063_PRECONDITION_FAILED"), msg.slice(0, 120));
      await c.query(undo);
    }

    console.log("\napply 0063");
    await asRoot(c);
    await c.query("begin");
    const applied = await failure(() => c.query(MIGRATION));
    await c.query(applied ? "rollback" : "commit");
    t("0063 applies cleanly to production's state", applied === "", applied);
    t("profiles policies are exactly 0002's four again", JSON.stringify(await policies()) === JSON.stringify(intended), (await policies()).join(" ; "));
    const allPoliciesAfter = (await c.query("select schemaname||tablename||policyname||coalesce(qual,'')||coalesce(with_check,'') p from pg_policies order by 1")).rows.map((r) => r.p);
    const added = allPoliciesAfter.filter((p) => !allPoliciesBefore.includes(p));
    const removed = allPoliciesBefore.filter((p) => !allPoliciesAfter.includes(p));
    t("no other policy anywhere changed (only the two added)", removed.length === 0 && added.length === 2 && added.every((p) => p.startsWith("publicprofiles")));
    await c.query("begin");
    const again = await failure(() => c.query(MIGRATION));
    await c.query(again ? "rollback" : "commit");
    t("re-running 0063 on the restored state is accepted and changes nothing", again === "" && JSON.stringify(await policies()) === JSON.stringify(intended), again);

    console.log("\nwho can update a profile");
    await asUser(c, alice, "aal1");
    t("1. a customer can update their own profile", (await rename(alice, "Alice Renamed")) === 1);
    t("   …and it is stored", (await nameOf(alice)) === "Alice Renamed");
    await asUser(c, alice, "aal1");
    t("   …including the delivery address and phone",
      (await c.query("update profiles set default_address = '{\"line1\":\"x\"}', default_phone = '1' where id = $1 returning id", [alice])).rowCount === 1);
    await asUser(c, alice, "aal1");
    t("2. a customer cannot update another customer's profile", (await rename(bob, "hijacked")) === 0);
    t("   …which is unchanged", (await nameOf(bob)) === "Original");
    await asUser(c, alice, "aal1");
    t("2b. a customer cannot move their row onto another id",
      (await failure(() => c.query("update profiles set id = $2 where id = $1", [alice, bob]))).includes("permission denied"));
    await asUser(c, alice, "aal1");
    t("2c. a customer still cannot make themselves an admin",
      (await failure(() => c.query("update profiles set is_admin = true where id = $1", [alice]))).includes("permission denied"));
    t("    …and is not one", (await (async () => { await asRoot(c); return (await c.query("select is_admin from profiles where id=$1", [alice])).rows[0].is_admin; })()) === false);
    await asAdmin(c, admin);
    t("3. an admin (staff, two-factor session) can update a customer's profile", (await rename(bob, "Bob By Admin")) === 1);
    t("   …and it is stored", (await nameOf(bob)) === "Bob By Admin");
    await asStaffPasswordOnly(c, admin);
    t("4a. staff with only a password (aal1) cannot update a customer's profile", (await rename(bob, "nope")) === 0);
    await c.query("set role anon");
    await c.query("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '{\"role\":\"anon\"}', false)");
    const anonMsg = await failure(() => rename(bob, "nope"));
    const anonRows = anonMsg ? 0 : await rename(bob, "nope").catch(() => 0);
    t("4b. an anonymous caller cannot update any profile", anonMsg !== "" || anonRows === 0, anonMsg.slice(0, 80));
    t("    …nothing changed", (await nameOf(bob)) === "Bob By Admin");
    await asUser(c, "00000000-0000-0000-0000-000000000000", "aal1");
    t("4c. a signed-in user with no profile updates nothing", (await rename(bob, "nope")) === 0);

    await c.end();
  } finally {
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
