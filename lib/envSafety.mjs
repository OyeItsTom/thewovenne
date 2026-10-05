/**
 * Which Supabase project is this process about to talk to, and is it allowed to?
 *
 * WHY THIS EXISTS. Until October 2026 Vercel Preview deployments were built with
 * the PRODUCTION Supabase URL and anon key, and nothing in the application knew
 * the difference. Signing in to /admin on a preview, or exercising any write
 * flow there, wrote to the live shop's database. Every script under scripts/
 * read .env.local — which also names production — and would do whatever it was
 * told to it.
 *
 * Two rules come out of that, and both live here so the app, the build and the
 * scripts cannot disagree about them:
 *
 *   1. A deployment that is not production (Vercel Preview or Development, or a
 *      local process that has declared WOVENNE_ENV=staging) must not be
 *      configured with the production project, nor with live Razorpay keys.
 *      The build and server startup refuse.
 *   2. A script that writes refuses the production project unless the operator
 *      passed --production for that one run. Staging-only scripts refuse it
 *      even then.
 *
 * THE PRODUCTION REF IS WRITTEN DOWN, NOT CONFIGURED. The thing being guarded
 * against is wrong configuration, so the guard cannot take its answer from the
 * same configuration. The ref is not a secret: it is the subdomain of the
 * Supabase URL every visitor's browser already loads.
 *
 * Plain .mjs with a .d.mts beside it, because next.config.mjs and the `node`
 * scripts import it as well as TypeScript.
 */

export const PRODUCTION_SUPABASE_REF = "wxumlixnmwgeqswknhpw";

/** The flag a writing script needs before it will touch production. */
export const PRODUCTION_FLAG = "--production";

export class EnvSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvSafetyError";
  }
}

const REF = /^[a-z0-9]{20}$/;

/** `https://<ref>.supabase.co` → ref. Anything else (localhost, placeholder) → null. */
export function refFromSupabaseUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const m = host.match(/^([a-z0-9]{20})\.supabase\.(co|in)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * A Postgres connection string → ref. Supabase gives two shapes:
 *   direct:  postgres://postgres:…@db.<ref>.supabase.co:5432/postgres
 *   pooler:  postgres://postgres.<ref>:…@aws-0-<region>.pooler.supabase.com:5432/postgres
 * The pooler names the project only in the user, so both are read.
 */
export function refFromDbUrl(dbUrl) {
  if (!dbUrl) return null;
  try {
    const u = new URL(dbUrl);
    const host = u.hostname.toLowerCase();
    const direct = host.match(/^db\.([a-z0-9]{20})\.supabase\.(co|in)$/);
    if (direct) return direct[1];
    const user = decodeURIComponent(u.username).toLowerCase();
    const pooled = user.match(/^[a-z_]+\.([a-z0-9]{20})$/);
    return pooled ? pooled[1] : null;
  } catch {
    return null;
  }
}

/**
 * A legacy Supabase API key is a JWT whose payload carries `ref`. Only the
 * payload is decoded — the signature is never needed and never logged. New
 * style keys (sb_publishable_…, sb_secret_…) carry no ref and return null.
 */
export function refFromKey(key) {
  if (!key || typeof key !== "string") return null;
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(
      typeof atob === "function"
        ? atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="))
        : Buffer.from(b64, "base64").toString("utf8")
    );
    return typeof json.ref === "string" && REF.test(json.ref) ? json.ref : null;
  } catch {
    return null;
  }
}

/** Every Supabase project the environment names, by the variable that names it. */
export function supabaseRefs(env) {
  const found = {
    NEXT_PUBLIC_SUPABASE_URL: refFromSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: refFromKey(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: refFromKey(env.SUPABASE_SERVICE_ROLE_KEY),
    SUPABASE_DB_URL: refFromDbUrl(env.SUPABASE_DB_URL),
  };
  return Object.fromEntries(Object.entries(found).filter(([, ref]) => ref));
}

/**
 * What this process says it is.
 *   VERCEL_ENV wins — Vercel sets it on every build and function.
 *   Otherwise WOVENNE_ENV, which .env.staging sets to "staging".
 *   Otherwise "local": an undeclared developer machine, unrestricted, as before.
 */
export function deploymentTarget(env) {
  const vercel = (env.VERCEL_ENV || "").trim().toLowerCase();
  if (vercel) return vercel;
  const declared = (env.WOVENNE_ENV || "").trim().toLowerCase();
  if (declared) return declared;
  return "local";
}

/** Targets that are allowed to name production. Everything else that is declared is not. */
const MAY_USE_PRODUCTION = new Set(["production", "local"]);

/**
 * Rule 1, as data. `problems` is empty when the environment is safe.
 */
export function checkAppEnvironment(env) {
  const target = deploymentTarget(env);
  const refs = supabaseRefs(env);
  const problems = [];

  if (!MAY_USE_PRODUCTION.has(target)) {
    const pointing = Object.entries(refs)
      .filter(([, ref]) => ref === PRODUCTION_SUPABASE_REF)
      .map(([name]) => name);
    if (pointing.length > 0) {
      problems.push(
        `${target} must not use the production Supabase project (${PRODUCTION_SUPABASE_REF}), ` +
          `but ${pointing.join(", ")} ${pointing.length === 1 ? "names" : "name"} it. ` +
          `Point the ${target} environment at the staging project.`
      );
    }
  }

  // Real money. Outside production only Razorpay's test mode is acceptable.
  if (!MAY_USE_PRODUCTION.has(target)) {
    const live = ["RAZORPAY_KEY_ID", "NEXT_PUBLIC_RAZORPAY_KEY_ID"].filter((k) =>
      (env[k] || "").trim().startsWith("rzp_live_")
    );
    if (live.length > 0) {
      problems.push(`${target} must use Razorpay TEST keys (rzp_test_…), but ${live.join(", ")} ${live.length === 1 ? "is" : "are"} live.`);
    }
  }

  // A staging URL with a production service-role key would read as "staging"
  // and act as production. Any two variables that disagree are refused — on
  // the non-production side only: production's build must not grow a new way
  // to fail, and a mismatched key there fails on its own at the first request.
  const distinct = [...new Set(Object.values(refs))];
  if (!MAY_USE_PRODUCTION.has(target) && distinct.length > 1) {
    problems.push(
      `Supabase variables name different projects: ` +
        Object.entries(refs).map(([k, v]) => `${k}=${v}`).join(", ") +
        `. They must all belong to one project.`
    );
  }

  return { target, refs, problems };
}

/** Rule 1, enforced. Throws before anything is built or served. */
export function assertAppEnvironment(env) {
  const result = checkAppEnvironment(env);
  if (result.problems.length > 0) {
    throw new EnvSafetyError(
      `\n\nWOVENNE ENVIRONMENT SAFETY — refusing to start (${result.target}).\n` +
        result.problems.map((p) => `  • ${p}`).join("\n") +
        `\n\nSee docs/staging.md.\n`
    );
  }
  return result;
}

/**
 * Rule 2, as data.
 *   production:  the operator passed --production
 *   stagingOnly: the script never runs on production, flag or not
 *
 * A script must be able to name its project: with no Supabase variable at all
 * there is nothing to check, and that is refused rather than waved through. A
 * plain local Postgres (the test harnesses) is allowed by `allowUnknown`.
 */
export function checkScriptTarget(env, { production = false, stagingOnly = false, allowUnknown = false } = {}) {
  const refs = supabaseRefs(env);
  const distinct = [...new Set(Object.values(refs))];
  const problems = [];

  if (distinct.length > 1) {
    problems.push(
      `Supabase variables name different projects (` +
        Object.entries(refs).map(([k, v]) => `${k}=${v}`).join(", ") +
        `). Fix the env file before running anything.`
    );
    return { ref: null, isProduction: false, problems };
  }

  const ref = distinct[0] ?? null;
  const isProduction = ref === PRODUCTION_SUPABASE_REF;

  if (!ref && !allowUnknown) {
    problems.push("No Supabase project could be identified from NEXT_PUBLIC_SUPABASE_URL or SUPABASE_DB_URL.");
  } else if (isProduction && stagingOnly) {
    problems.push(
      `This script only runs against staging, and the env names PRODUCTION (${ref}). ` +
        `There is no override.`
    );
  } else if (stagingOnly && deploymentTarget(env) !== "staging") {
    // Not production is not the same as staging. A staging-only script wants a
    // positive declaration, so an unrelated project cannot be wiped by accident.
    problems.push("This script only runs against staging, and the env file does not declare WOVENNE_ENV=staging.");
  } else if (isProduction && !production) {
    problems.push(
      `The env names PRODUCTION (${ref}). Nothing was run. ` +
        `If you really mean production, run it again with ${PRODUCTION_FLAG}.`
    );
  } else if (!isProduction && production) {
    problems.push(
      `${PRODUCTION_FLAG} was passed but the env names ${ref ?? "no Supabase project"}, not production. ` +
        `Refusing — the flag and the env disagree about where this is going.`
    );
  }

  if (!isProduction && deploymentTarget(env) === "production") {
    problems.push("WOVENNE_ENV/VERCEL_ENV says production but the Supabase project is not production.");
  }

  return { ref, isProduction, problems };
}
