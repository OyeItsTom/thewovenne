/**
 * The analytics switch (analytics_config.collecting, migration 0068).
 *
 *   node scripts/analytics-switch.mjs status
 *   node scripts/analytics-switch.mjs on
 *   node scripts/analytics-switch.mjs off
 *
 * The one place collection is turned on or off for EVERY event source —
 * browser events through /api/events and purchases from settlement alike.
 * While it is off, nothing is written. No API role can change it: this runs as
 * the database owner from SUPABASE_DB_URL in .env.local, in one transaction,
 * and prints the state before and after plus how many analytics events exist —
 * so "is it off?" is always one command away.
 */
import fs from "node:fs";
import pg from "pg";

const action = process.argv[2];
if (!["status", "on", "off"].includes(action)) {
  console.error("usage: node scripts/analytics-switch.mjs status|on|off");
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
if (!env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL is not set in .env.local");
  process.exit(1);
}

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
const state = async () =>
  (await client.query(`
    select c.collecting, c.changed_at, c.changed_by,
           (select count(*) from public.analytics_events)::int as events,
           (select count(*) from public.analytics_events where traffic = 'customer')::int as customer_events
      from public.analytics_config c where c.id`)).rows[0] ?? { collecting: false, note: "no config row — reads as OFF" };

try {
  await client.connect();
  await client.query("begin");
  console.log("before:", await state());
  if (action !== "status") {
    await client.query(
      "update public.analytics_config set collecting = $1, changed_at = now(), changed_by = current_user where id",
      [action === "on"]
    );
    console.log("after: ", await state());
  }
  await client.query("commit");
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error("failed:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
