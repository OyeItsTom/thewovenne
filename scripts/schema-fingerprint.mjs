#!/usr/bin/env node
/**
 * Does staging's schema match production's? READ-ONLY.
 *
 *   node scripts/schema-fingerprint.mjs --env-file=.env.staging > staging.json
 *   node scripts/schema-fingerprint.mjs --production            > production.json
 *   node scripts/schema-fingerprint.mjs --compare staging.json production.json
 *
 * Production was "built from hand-pasted fragments" (supabase/README.md), so
 * migrations replaying cleanly on an empty project does not by itself prove the
 * result IS production. This prints the shape of both — columns, constraints,
 * indexes, RLS, policies, function bodies (whitespace-free md5, the method that
 * closed F03), function attributes and grants, triggers, views, buckets — and
 * diffs them.
 *
 * It reads catalog metadata only, never a row of data, inside
 * `begin transaction read only`. It still goes through the same guard as every
 * script, so production needs --production: the flag is cheap, and a habit of
 * pointing tools at production without one is not.
 *
 * The output contains no secrets and no customer data, only object names and
 * hashes, so it is safe to keep in reports/.
 */
import fs from "node:fs";
import pg from "pg";
import { compareFingerprints, fingerprint } from "./lib/schemaFingerprint.mjs";

const args = process.argv.slice(2);

if (args[0] === "--compare") {
  const [a, b] = [args[1], args[2]].map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  let differences = 0;
  for (const [section, { onlyA, onlyB }] of Object.entries(compareFingerprints(a, b))) {
    console.log(`\n## ${section}`);
    for (const x of onlyA) console.log(`  only in ${args[1]}: ${x}`);
    for (const x of onlyB) console.log(`  only in ${args[2]}: ${x}`);
    differences += onlyA.length + onlyB.length;
  }
  console.log(differences ? `\n${differences} difference(s)` : "\nidentical");
  process.exit(differences ? 1 : 0);
}

const { loadScriptEnv } = await import("./lib/scriptEnv.mjs");
// allowUnknown: a plain local Postgres has no Supabase ref, and this only reads.
const env = loadScriptEnv({ argv: args, allowUnknown: true });
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();
  const out = { meta: { generated_at: new Date().toISOString() }, ...(await fingerprint(c)) };
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
