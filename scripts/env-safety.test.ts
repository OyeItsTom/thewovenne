/**
 * Preview must not reach production; writing scripts must not reach it by default.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/env-safety.test.ts
 *
 * Three layers:
 *   1. lib/envSafety.mjs — the rules, as pure functions.
 *   2. next.config.mjs — the build actually refuses (imported in a child process
 *      with a Preview environment, exactly as `next build` loads it).
 *   3. The real scripts, run as child processes against env files that NAME the
 *      production project but whose database address is 127.0.0.1:9 — so if a
 *      guard ever failed open, the script would hit a closed local port, never
 *      production. Nothing in this file can reach a network.
 *
 * Plus a static sweep: every script that writes must go through the guard.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PRODUCTION_SUPABASE_REF as PROD,
  checkAppEnvironment,
  assertAppEnvironment,
  checkScriptTarget,
  deploymentTarget,
  refFromDbUrl,
  refFromKey,
  refFromSupabaseUrl,
} from "../lib/envSafety.mjs";
import { envFilePath, parseEnvFile } from "./lib/scriptEnv.mjs";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

const STAGING = "abcdefghijklmnopqrst";
const OTHER = "zzzzzzzzzzzzzzzzzzzz";
const url = (ref: string) => `https://${ref}.supabase.co`;
/** A JWT-shaped key whose payload names `ref`. Unsigned; only the payload is ever read. */
const key = (ref: string, role = "anon") =>
  ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ iss: "supabase", ref, role })).toString("base64url"), "sig"].join(".");

console.log("\nparsing");
t("production URL → ref", refFromSupabaseUrl(url(PROD)) === PROD);
t("URL with path and trailing slash", refFromSupabaseUrl(`${url(STAGING)}/rest/v1/`) === STAGING);
t("placeholder URL → null", refFromSupabaseUrl("https://placeholder.supabase.co") === null);
t("non-Supabase host → null", refFromSupabaseUrl("http://localhost:54321") === null);
t("garbage → null", refFromSupabaseUrl("not a url") === null && refFromSupabaseUrl(undefined) === null);
t("direct DB URL → ref", refFromDbUrl(`postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres`) === PROD);
t(
  "pooler DB URL → ref from user",
  refFromDbUrl(`postgres://postgres.${PROD}:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`) === PROD
);
t("local DB URL → null", refFromDbUrl("postgres://postgres:x@localhost:5432/postgres") === null);
t("JWT key → ref", refFromKey(key(PROD)) === PROD);
t("new-style key → null", refFromKey("sb_secret_abc123") === null);
t("malformed JWT → null", refFromKey("a.b.c") === null);

console.log("\ntarget");
t("VERCEL_ENV wins", deploymentTarget({ VERCEL_ENV: "preview", WOVENNE_ENV: "production" }) === "preview");
t("WOVENNE_ENV used without Vercel", deploymentTarget({ WOVENNE_ENV: "staging" }) === "staging");
t("nothing declared → local", deploymentTarget({}) === "local");

console.log("\napp environment (rule 1)");
const prodEnv = {
  NEXT_PUBLIC_SUPABASE_URL: url(PROD),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: key(PROD),
  SUPABASE_SERVICE_ROLE_KEY: key(PROD, "service_role"),
};
t("production + production project → ok", checkAppEnvironment({ ...prodEnv, VERCEL_ENV: "production" }).problems.length === 0);
t("local + production project → ok (unchanged behaviour)", checkAppEnvironment(prodEnv).problems.length === 0);
t("preview + production URL → refused", checkAppEnvironment({ ...prodEnv, VERCEL_ENV: "preview" }).problems.length > 0);
t(
  "preview + production anon key only → refused",
  checkAppEnvironment({ VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: url(STAGING), NEXT_PUBLIC_SUPABASE_ANON_KEY: key(PROD) })
    .problems.length > 0
);
t(
  "preview + production service key behind a staging URL → refused",
  checkAppEnvironment({
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SUPABASE_URL: url(STAGING),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: key(STAGING),
    SUPABASE_SERVICE_ROLE_KEY: key(PROD, "service_role"),
  }).problems.length > 0
);
t("vercel development + production → refused", checkAppEnvironment({ ...prodEnv, VERCEL_ENV: "development" }).problems.length > 0);
t("declared staging + production → refused", checkAppEnvironment({ ...prodEnv, WOVENNE_ENV: "staging" }).problems.length > 0);
t(
  "preview + staging project → ok",
  checkAppEnvironment({
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SUPABASE_URL: url(STAGING),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: key(STAGING),
    SUPABASE_SERVICE_ROLE_KEY: key(STAGING, "service_role"),
  }).problems.length === 0
);
t(
  "preview + staging URL + another project's key → refused (mixed)",
  checkAppEnvironment({ VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: url(STAGING), NEXT_PUBLIC_SUPABASE_ANON_KEY: key(OTHER) })
    .problems.length > 0
);
t("preview + live Razorpay key → refused", checkAppEnvironment({ VERCEL_ENV: "preview", RAZORPAY_KEY_ID: "rzp_live_abc" }).problems.length > 0);
t("preview + live public Razorpay key → refused", checkAppEnvironment({ VERCEL_ENV: "preview", NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_live_abc" }).problems.length > 0);
t("preview + test Razorpay key → ok", checkAppEnvironment({ VERCEL_ENV: "preview", RAZORPAY_KEY_ID: "rzp_test_abc" }).problems.length === 0);
t("production + live Razorpay key → ok", checkAppEnvironment({ VERCEL_ENV: "production", RAZORPAY_KEY_ID: "rzp_live_abc" }).problems.length === 0);
t("preview with no Supabase vars → ok (placeholder build)", checkAppEnvironment({ VERCEL_ENV: "preview" }).problems.length === 0);
let threw = "";
try {
  assertAppEnvironment({ ...prodEnv, VERCEL_ENV: "preview" });
} catch (e) {
  threw = (e as Error).message;
}
t("assert throws a message naming the rule", threw.includes("WOVENNE ENVIRONMENT SAFETY") && threw.includes(PROD));

console.log("\nscript target (rule 2)");
t("production, no flag → refused", checkScriptTarget(prodEnv).problems.length > 0);
t("production + --production → ok", checkScriptTarget(prodEnv, { production: true }).problems.length === 0);
t(
  "production + --production but staging-only → refused",
  checkScriptTarget(prodEnv, { production: true, stagingOnly: true }).problems.length > 0
);
const stagingEnv = { NEXT_PUBLIC_SUPABASE_URL: url(STAGING), SUPABASE_DB_URL: `postgres://postgres.${STAGING}:x@h/postgres`, WOVENNE_ENV: "staging" };
t("staging → ok", checkScriptTarget(stagingEnv).problems.length === 0);
t("staging + --production → refused (flag and env disagree)", checkScriptTarget(stagingEnv, { production: true }).problems.length > 0);
t("staging-only + staging → ok", checkScriptTarget(stagingEnv, { stagingOnly: true }).problems.length === 0);
t(
  "staging-only + undeclared non-production → refused",
  checkScriptTarget({ ...stagingEnv, WOVENNE_ENV: "" }, { stagingOnly: true }).problems.length > 0
);
t(
  "staging URL + production DB URL → refused",
  checkScriptTarget({ NEXT_PUBLIC_SUPABASE_URL: url(STAGING), SUPABASE_DB_URL: `postgres://postgres:x@db.${PROD}.supabase.co:5432/postgres` })
    .problems.length > 0
);
t(
  "staging URL + production DB URL + --production → still refused",
  checkScriptTarget(
    { NEXT_PUBLIC_SUPABASE_URL: url(STAGING), SUPABASE_DB_URL: `postgres://postgres:x@db.${PROD}.supabase.co:5432/postgres` },
    { production: true }
  ).problems.length > 0
);
t("no project identifiable → refused", checkScriptTarget({ SUPABASE_DB_URL: "postgres://x@localhost/db" }).problems.length > 0);
t("no project + allowUnknown → ok", checkScriptTarget({ SUPABASE_DB_URL: "postgres://x@localhost/db" }, { allowUnknown: true }).problems.length === 0);

console.log("\nenv file selection");
t("default is .env.local", envFilePath([], {}) === ".env.local");
t("WOVENNE_ENV_FILE", envFilePath([], { WOVENNE_ENV_FILE: ".env.staging" }) === ".env.staging");
t("--env-file= beats the variable", envFilePath(["--env-file=.env.x"], { WOVENNE_ENV_FILE: ".env.staging" }) === ".env.x");
t("--env <path> (older scripts' spelling)", envFilePath(["--env", "/a/.env"], {}) === "/a/.env");
t("parse strips quotes and export", parseEnvFile('export A="1"\n# c\nB=\'2\'\nC=x=y').C === "x=y" && parseEnvFile('export A="1"').A === "1");

// ── 2. The build itself ─────────────────────────────────────────────────────
console.log("\nnext.config.mjs");
/** A child with ONLY these variables — nothing from this shell or .env.local leaks in. */
const childEnv = (extra: Record<string, string>) =>
  ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra }) as unknown as NodeJS.ProcessEnv;
const nodeEval = (code: string, env: Record<string, string>) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    env: childEnv(env),
    encoding: "utf8",
    timeout: 60_000,
  });
const loadConfig = `await import(${JSON.stringify(path.join(process.cwd(), "next.config.mjs"))}); console.log("CONFIG LOADED");`;
const previewProd = nodeEval(loadConfig, { VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: url(PROD), NEXT_PUBLIC_SUPABASE_ANON_KEY: key(PROD) });
t(
  "preview build with production Supabase fails",
  previewProd.status !== 0 && !previewProd.stdout.includes("CONFIG LOADED") && previewProd.stderr.includes("WOVENNE ENVIRONMENT SAFETY"),
  `exit ${previewProd.status}`
);
const prodBuild = nodeEval(loadConfig, { VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: url(PROD), NEXT_PUBLIC_SUPABASE_ANON_KEY: key(PROD) });
t("production build config loads", prodBuild.status === 0 && prodBuild.stdout.includes("CONFIG LOADED"), prodBuild.stderr.slice(0, 200));
const previewStaging = nodeEval(loadConfig, { VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: url(STAGING), NEXT_PUBLIC_SUPABASE_ANON_KEY: key(STAGING) });
t("preview build with staging Supabase loads", previewStaging.status === 0 && previewStaging.stdout.includes("CONFIG LOADED"), previewStaging.stderr.slice(0, 200));
const localBuild = nodeEval(loadConfig, { NEXT_PUBLIC_SUPABASE_URL: url(PROD) });
t("undeclared local build loads (unchanged)", localBuild.status === 0 && localBuild.stdout.includes("CONFIG LOADED"));

// ── 3. The scripts, end to end ──────────────────────────────────────────────
console.log("\nscripts refuse production before connecting");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wovenne-envsafety-"));
// Names production in every variable; the only address a client could reach
// is the discard port on this machine.
const prodFile = path.join(dir, ".env.prodlike");
fs.writeFileSync(
  prodFile,
  [
    `NEXT_PUBLIC_SUPABASE_URL=${url(PROD)}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${key(PROD)}`,
    `SUPABASE_SERVICE_ROLE_KEY=${key(PROD, "service_role")}`,
    `SUPABASE_DB_URL=postgres://postgres.${PROD}:not-a-password@127.0.0.1:9/postgres`,
  ].join("\n")
);
const stagingFile = path.join(dir, ".env.staginglike");
fs.writeFileSync(
  stagingFile,
  [`WOVENNE_ENV=staging`, `NEXT_PUBLIC_SUPABASE_URL=${url(STAGING)}`, `SUPABASE_DB_URL=postgres://postgres.${STAGING}:x@127.0.0.1:9/postgres`].join("\n")
);

const run = (script: string, args: string[], extraEnv: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: childEnv(extraEnv),
    encoding: "utf8",
    timeout: 60_000,
  });

const migration = "supabase/migrations/0061_is_staff.sql";
let r = run("scripts/run-migration.mjs", [migration, `--env-file=${prodFile}`]);
t("run-migration: production, no flag → exit 2, nothing connected", r.status === 2 && r.stderr.includes("REFUSED") && !/ECONNREFUSED|FAILED/.test(r.stderr + r.stdout), `exit ${r.status}`);
r = run("scripts/run-migration.mjs", [migration], { WOVENNE_ENV_FILE: prodFile });
t("run-migration: production via WOVENNE_ENV_FILE → exit 2", r.status === 2);
r = run("scripts/run-migration.mjs", [migration, `--env-file=${prodFile}`, "--production"]);
t(
  "run-migration: production + --production → passes the guard (then fails on the closed local port)",
  r.status !== 2 && /target: PRODUCTION/.test(r.stderr) && /FAILED|ECONNREFUSED/.test(r.stderr + r.stdout),
  `exit ${r.status}`
);
r = run("scripts/run-migration.mjs", [migration, `--env-file=${stagingFile}`, "--production"]);
t("run-migration: staging + --production → exit 2", r.status === 2);
r = run("scripts/run-migration.mjs", [migration, "--env-file", stagingFile]);
t("run-migration: --env-file <space> path is not mistaken for the migration", r.status !== 2 && /non-production project/.test(r.stderr), `exit ${r.status}`);

for (const s of ["scripts/add-admin.mjs", "scripts/reset-admin-mfa.mjs", "scripts/restore-cost-prices.mjs", "scripts/cancel-guard.verify.mjs", "scripts/style-security.test.mjs"]) {
  r = run(s, [`--env-file=${prodFile}`, "--list"]);
  t(`${path.basename(s)}: production, no flag → exit 2`, r.status === 2 && r.stderr.includes("REFUSED"), `exit ${r.status}`);
}

r = run("scripts/staging.mjs", ["bootstrap", `--env-file=${prodFile}`, "--production"]);
t("staging.mjs: production even with --production → exit 2", r.status === 2 && r.stderr.includes("no override"), `exit ${r.status}`);
r = run("scripts/staging.mjs", ["reset", "--yes"], { WOVENNE_ENV_FILE: prodFile });
t("staging.mjs reset: production → exit 2", r.status === 2);
fs.rmSync(dir, { recursive: true, force: true });

// ── Static sweep ────────────────────────────────────────────────────────────
console.log("\nevery writing script is guarded");
const GUARDED = [
  "run-migration.mjs",
  "add-admin.mjs",
  "reset-admin-mfa.mjs",
  "restore-cost-prices.mjs",
  "seed-policy-pages.mjs",
  "seo-5e-drafts.mjs",
  "ai-daily-spend.verify.mjs",
  "brand-knowledge.verify.mjs",
  "cancel-guard.verify.mjs",
  "derived-stock.verify.mjs",
  "in-person-consent.verify.mjs",
  "style-media.verify.mjs",
  "style-notify.verify.mjs",
  "style-resubmit.verify.mjs",
  "style-security.test.mjs",
  "staging.mjs",
  "schema-fingerprint.mjs",
  "backfill-execute.ts",
  "backfill-delete-execute.ts",
  "c6-normalize-execute.ts",
  "c7-reclaim-execute.ts",
  "orphan-delete-execute.ts",
];
for (const f of GUARDED) {
  const src = fs.readFileSync(path.join("scripts", f), "utf8");
  t(`${f} calls the guard`, /loadScriptEnv\(|guardProcessEnv\(/.test(src));
}
// A script that reads .env.local by hand AND writes (a service-role client,
// a pg client, or a storage call) is a new unguarded path.
const READ_ONLY_OK = new Set([
  // read env for API keys or read-only planning; none opens a writing client
  "ai-budget.test.ts",
  "ai-observability.test.ts",
  "ai-trace-demo.ts",
  "ai-budget-baseline.ts",
  "ai-cost-baseline.ts",
  "chat-loop.test.ts",
  "chat-tools.test.ts",
  "order-tool.test.ts",
  "concierge-live.ts",
  "pg-world.ts",
]);
for (const f of fs.readdirSync("scripts")) {
  if (!/\.(m?js|ts)$/.test(f) || GUARDED.includes(f) || READ_ONLY_OK.has(f) || f === "env-safety.test.ts") continue;
  const src = fs.readFileSync(path.join("scripts", f), "utf8");
  const readsLocalEnv = /readFileSync\([^)]*\.env\.local/.test(src);
  if (readsLocalEnv) t(`${f} reads .env.local by hand — must use loadScriptEnv`, false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
