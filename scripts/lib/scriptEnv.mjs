/**
 * The one way a writing script learns its credentials — and where it refuses.
 *
 * Every script that changes a database or a bucket calls this BEFORE it opens a
 * connection. It reads exactly one env file, puts its values into process.env
 * (overriding whatever the shell had), works out which Supabase project that
 * file names, and exits with status 2 if the script may not run there:
 *
 *   production, no --production       → refused
 *   production, staging-only script   → refused, no override exists
 *   not production, but --production  → refused (flag and env disagree)
 *
 * Which file:
 *   --env-file=<path>  or  --env-file <path>  or  --env <path>
 *   else $WOVENNE_ENV_FILE
 *   else .env.local   (which today names production — so the default refuses)
 *
 * Staging work is therefore: `--env-file=.env.staging`, or
 * `WOVENNE_ENV_FILE=.env.staging`.
 */
import fs from "node:fs";
import { PRODUCTION_FLAG, checkScriptTarget } from "../../lib/envSafety.mjs";

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim().replace(/^export\s+/, "");
    out[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function envFilePath(argv, env = process.env, fallback = ".env.local") {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--env-file=")) return a.slice("--env-file=".length);
    if ((a === "--env-file" || a === "--env") && argv[i + 1]) return argv[i + 1];
  }
  return env.WOVENNE_ENV_FILE || fallback;
}

function refuse(problems, where) {
  console.error(`\nREFUSED — environment safety (${where}).`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("  See docs/staging.md.\n");
  process.exit(2);
}

function announce(result, where) {
  const label = result.isProduction
    ? `PRODUCTION (${result.ref})`
    : result.ref
      ? `non-production project ${result.ref}`
      : "a database with no Supabase project";
  console.error(`target: ${label} — from ${where}`);
}

/**
 * Load the env file and check it. Returns the file's values; process.env holds
 * them too.
 */
export function loadScriptEnv({
  argv = process.argv.slice(2),
  stagingOnly = false,
  allowUnknown = false,
  defaultFile = ".env.local",
} = {}) {
  const file = envFilePath(argv, process.env, defaultFile);
  if (!fs.existsSync(file)) {
    console.error(`\nNo env file at ${file}. Pass --env-file=<path>.\n`);
    process.exit(1);
  }
  const values = parseEnvFile(fs.readFileSync(file, "utf8"));
  // Only the file decides. A stale exported SUPABASE_DB_URL in the shell must
  // not quietly outrank the file the operator named.
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL", "WOVENNE_ENV"]) {
    if (!(k in values)) delete process.env[k];
  }
  Object.assign(process.env, values);

  const result = checkScriptTarget(values, {
    production: argv.includes(PRODUCTION_FLAG),
    stagingOnly,
    allowUnknown,
  });
  if (result.problems.length) refuse(result.problems, file);
  announce(result, file);
  return values;
}

/**
 * For scripts whose env is already in process.env (`npx tsx --env-file=…`).
 * Same rules; nothing is loaded.
 */
export function guardProcessEnv({ argv = process.argv.slice(2), stagingOnly = false } = {}) {
  const result = checkScriptTarget(process.env, { production: argv.includes(PRODUCTION_FLAG), stagingOnly });
  if (result.problems.length) refuse(result.problems, "process environment");
  announce(result, "process environment");
  return result;
}
