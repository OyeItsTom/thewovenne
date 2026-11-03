/**
 * The ONE rule for which database a release tool talks to.
 *
 * Used by scripts/run-migration.mjs (writes), scripts/security-posture.ts
 * --production (read-only) and, once #225 adopts it, scripts/run-recovery-sql.mjs
 * (writes). Before this, the migration runner read only .env.local while the
 * recovery runner preferred an exported SUPABASE_DB_URL, so one shell could aim
 * the two at different databases (A4 finding R-4).
 *
 * THE POLICY
 *   1. The target is SUPABASE_DB_URL in ./.env.local — the checkout you run
 *      from. Nothing else names it. The file must define it exactly once.
 *   2. An exported SUPABASE_DB_URL that differs from the file is refused, not
 *      ignored and not preferred: two candidate targets mean someone is
 *      confused, and a release tool must not guess which one they meant.
 *   3. Inherited libpq variables (PGHOST, PGPORT, PGOPTIONS, ...) are refused.
 *      node-postgres silently fills anything the URL leaves out from them, so
 *      they can redirect or alter a connection without appearing in the URL.
 *   4. The URL may carry no query parameters except sslmode. node-postgres
 *      honours ?host=, ?port=, ?options= and more, which would make the host
 *      the URL appears to name differ from the host actually connected to.
 *   5. The target (host, port, database, Supabase project ref) is printed
 *      before any connection. The user name and password never are.
 *   6. Write tools require --expect-host <host>, which must equal the URL's
 *      host exactly. Checked before connecting.
 *   7. The connection is built from the parsed parts, never from the raw
 *      string, so what was printed and checked is what is connected to.
 *   8. TLS is verified, never merely encrypted. Any database that is not
 *      loopback (and a loopback one that asks for sslmode=require or
 *      verify-full) is reached with the server certificate checked against
 *      the CA file named by SUPABASE_DB_SSLROOTCERT in .env.local (an absolute
 *      path; same once-only and shell rules as the URL) and the hostname
 *      checked against the certificate: libpq's sslmode=verify-full. Only that
 *      CA is trusted, not the system store. Supabase's CA is not publicly
 *      trusted; it is downloaded from the dashboard (Database Settings → SSL
 *      Configuration). sslmode values that would skip verification (prefer,
 *      allow, no-verify, verify-ca) are refused. The target line prints
 *      tls=verify-full and the CA's SHA-256 fingerprint, so a runbook can pin it.
 *
 * A refusal throws TargetRefused; callers exit 2 with its message, having
 * opened no connection.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export class TargetRefused extends Error {}

const KEY = "SUPABASE_DB_URL";
const CA_KEY = "SUPABASE_DB_SSLROOTCERT";

// libpq / node-postgres environment defaults that can change where or how a
// connection goes. Any of them set (non-empty) is refused.
export const INHERITED_PG_VARS = [
  "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
  "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGSSLMODE",
  "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY", "PGTARGETSESSIONATTRS",
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function refuse(msg) {
  throw new TargetRefused(`Refusing: ${msg} Nothing ran.`);
}

/** `key` from <cwd>/.env.local, defined at most once (exactly once when required). */
function readEnvFile(cwd, key = KEY, required = true) {
  const file = path.join(cwd, ".env.local");
  if (!fs.existsSync(file)) refuse(`${file} does not exist. The target is read from .env.local only.`);
  const defs = fs.readFileSync(file, "utf8").split("\n")
    .filter((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
  if (defs.length === 0) { if (!required) return null; refuse(`${key} is not set in ${file}.`); }
  if (defs.length > 1) refuse(`${key} is defined ${defs.length} times in ${file}; tools disagree on which one wins. Keep exactly one.`);
  const l = defs[0];
  const value = l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  if (!value) refuse(`${key} is empty in ${file}.`);
  return value;
}

/** The CA file for verify-full: PEM, one or more CA certificates, none expired. */
function readCa(caPath, line) {
  if (!path.isAbsolute(caPath)) refuse(`${CA_KEY} must be an absolute path, not ${caPath}. (${line})`);
  if (!fs.existsSync(caPath)) refuse(`${CA_KEY} names ${caPath}, which does not exist. (${line})`);
  const pem = fs.readFileSync(caPath, "utf8");
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) refuse(`${caPath} holds no PEM certificate. (${line})`);
  const fps = blocks.map((b) => {
    let c;
    try { c = new crypto.X509Certificate(b); } catch { return refuse(`${caPath} holds a certificate that does not parse. (${line})`); }
    if (!c.ca) refuse(`${caPath} holds a certificate that is not a CA (${c.subject.replace(/\n/g, ", ")}); it must be the CA that signs the server's certificate. (${line})`);
    if (new Date(c.validTo) < new Date()) refuse(`${caPath} holds a CA certificate that expired ${c.validTo}. (${line})`);
    return c.fingerprint256.replace(/:/g, "").toLowerCase();
  });
  return { pem, fps };
}

/**
 * @typedef {{ host: string, port: number, database: string, projectRef: string | null,
 *   loopback: boolean, tls: string, line: string, clientConfig: import("pg").ClientConfig }} DbTarget
 */

/**
 * Resolve and check the target. Throws TargetRefused on any violation.
 *   opts.write       true for tools that change the database
 *   opts.expectHost  the --expect-host value (required when write)
 *   opts.env         defaults to process.env (injectable for tests)
 *   opts.cwd         defaults to process.cwd()
 * @param {{ write?: boolean, expectHost?: string | null, env?: Record<string, string | undefined>, cwd?: string }} [opts]
 * @returns {DbTarget}
 */
export function resolveTarget({ write, expectHost, env = process.env, cwd = process.cwd() } = {}) {
  const inherited = INHERITED_PG_VARS.filter((k) => env[k]);
  if (inherited.length) refuse(`inherited PostgreSQL variables are set (${inherited.join(", ")}). They can silently change the connection; unset them.`);

  const url = readEnvFile(cwd);
  const shell = env[KEY];
  if (shell && shell !== url) refuse(`the shell exports a ${KEY} that differs from .env.local. Unset it (unset ${KEY}) or make them identical.`);
  const caPath = readEnvFile(cwd, CA_KEY, false);
  if (env[CA_KEY] && env[CA_KEY] !== caPath) refuse(`the shell exports a ${CA_KEY} that differs from .env.local. Unset it (unset ${CA_KEY}) or make them identical.`);

  let u;
  try { u = new URL(url); } catch { refuse(`${KEY} in .env.local is not a valid URL.`); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") refuse(`${KEY} must be a postgres:// or postgresql:// URL.`);
  const host = u.hostname.toLowerCase();
  if (!host) refuse(`${KEY} names no host.`);
  const decode = (v, what) => {
    try { return decodeURIComponent(v); } catch { return refuse(`the ${what} in ${KEY} is not valid percent-encoding.`); }
  };
  const database = decode(u.pathname.replace(/^\//, ""), "database name");
  if (!database) refuse(`${KEY} names no database.`);
  const user = decode(u.username, "user name");
  if (!user) refuse(`${KEY} names no user.`);

  const extra = [...u.searchParams.keys()].filter((k) => k !== "sslmode");
  if (extra.length) refuse(`${KEY} carries query parameters (${extra.join(", ")}); only sslmode is allowed, because others can change the host, port or session.`);
  const sslmode = u.searchParams.get("sslmode");
  const loopback = LOOPBACK.has(host);
  if (sslmode && !["disable", "require", "verify-full"].includes(sslmode)) refuse(`sslmode=${sslmode} is not supported: it would not verify the server's certificate. Omit it, or use verify-full.`);
  if (sslmode === "disable" && !loopback) refuse(`sslmode=disable is only allowed for a loopback database, not ${host}.`);

  const port = u.port ? Number(u.port) : 5432;
  const ref = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1] ?? /^postgres\.([a-z0-9]+)$/.exec(user)?.[1] ?? null;
  const base = `target: host=${host} port=${port} database=${database} project_ref=${ref ?? "n/a"}`;

  // Rule 8. require is treated as verify-full (never encrypted-but-unverified).
  const verify = !loopback || sslmode === "require" || sslmode === "verify-full";
  let ssl = false;
  let tls = "off";
  if (verify) {
    if (!caPath) refuse(`${host} must be reached with its TLS certificate verified: set ${CA_KEY}=<absolute path to the CA certificate> in .env.local (Supabase: Database Settings → SSL Configuration). (${base})`);
    if (net.isIP(host)) refuse(`${host} is an IP address; use the hostname, which the server certificate names. (${base})`);
    const { pem, fps } = readCa(caPath, base);
    ssl = { ca: pem, rejectUnauthorized: true, servername: host, minVersion: "TLSv1.2" };
    tls = `verify-full ca_sha256=${fps.join(",")}`;
  }

  const target = { host, port, database, projectRef: ref, loopback, tls };
  target.line = `${base} tls=${tls}`;

  if (write && !expectHost) refuse(`--expect-host <host> is required for a tool that writes. (${target.line})`);
  if (expectHost && expectHost.toLowerCase() !== host) refuse(`host is ${host}, expected ${expectHost}. (${target.line})`);

  // Explicit parts only: nothing for node-postgres to fill in from the
  // environment (rule 3 already refused those variables) or from the string.
  target.clientConfig = { host, port, database, user, password: decode(u.password, "password"), ssl };
  Object.defineProperty(target, "clientConfig", { enumerable: false }); // keep the password out of any accidental log
  return target;
}

/**
 * Parse `--expect-host <host>`; a missing value is an error, not "absent".
 * @param {string[]} args
 * @returns {string | null}
 */
export function expectHostArg(args) {
  const at = args.indexOf("--expect-host");
  if (at < 0) return null;
  const v = args[at + 1];
  if (!v || v.startsWith("--")) throw new TargetRefused("Refusing: --expect-host needs a host after it. Nothing ran.");
  return v;
}
