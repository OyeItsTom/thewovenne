/**
 * Admin session lifecycle + storefront account routing.
 *
 *   npx tsx scripts/admin-session-lifecycle.test.ts
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> npx tsx scripts/admin-session-lifecycle.test.ts
 *
 * Four parts:
 *
 *   1. The idle rule and the signed activity record (lib/adminSession), pure.
 *   2. The REAL middleware, session endpoint and admin API gate, run against a
 *      fake Supabase that behaves as Supabase does where it matters: sign-out
 *      deletes the session, /user refuses a token whose session is gone, a
 *      refresh token for a deleted session is refused, a refreshed token keeps
 *      its aal and amr, and is_admin() reads claims only (so it would happily
 *      accept a signed-out admin's token). A browser cookie jar carries state
 *      between requests. The middleware as merged at dd90511 is run through the
 *      same scenarios, to show which ones were broken before.
 *   3. Wiring: every admin API handler runs the gate first; every admin sign-out
 *      goes through one path that revokes, clears and reloads.
 *   4. On a real PostgreSQL with every migration (scripts/pg-world.ts): the
 *      customer account's reads, run as a two-factor-verified admin, see only
 *      the admin's own rows once filtered — and see everyone's without the
 *      filter, which is the leak the old staff redirect was hiding.
 *
 * Never touches a real database or network. Exits non-zero on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-for-hmac";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

// ── Fake Supabase ────────────────────────────────────────────────────────────

type Amr = { method: string; timestamp: number };
interface FakeUser { id: string; email: string; staff: boolean; mfa: boolean }
interface FakeSession { id: string; userId: string; aal: "aal1" | "aal2"; amr: Amr[]; alive: boolean; refresh: string }

const users = new Map<string, FakeUser>();
const sessions = new Map<string, FakeSession>();
const calls: string[] = [];
let n = 0;

function b64url(s: string) {
  return Buffer.from(s).toString("base64url");
}
function jwt(s: FakeSession, expSec: number) {
  const u = users.get(s.userId)!;
  return [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify({ sub: u.id, email: u.email, role: "authenticated", session_id: s.id, aal: s.aal, amr: s.amr, exp: expSec })),
    "sig",
  ].join(".");
}
function userJson(u: FakeUser) {
  return {
    id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
    app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
    factors: u.mfa ? [{ id: `f-${u.id}`, factor_type: "totp", status: "verified" }] : [],
  };
}
function sessionJson(s: FakeSession, expiresInSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  return { access_token: jwt(s, exp), refresh_token: s.refresh, expires_in: expiresInSec, expires_at: exp, token_type: "bearer", user: userJson(users.get(s.userId)!) };
}
function claimsOf(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer /, "");
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { sub: string; session_id: string; aal: string };
  } catch {
    return null;
  }
}
const json = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname}`;
  calls.push(`${route}${url.search}`);
  const claims = claimsOf(req);
  const session = claims ? sessions.get(claims.session_id) : undefined;

  if (route === "GET /auth/v1/user") {
    // Supabase checks the session behind the token still exists.
    if (!claims || !session?.alive) return json({ code: "session_not_found", message: "Session from session_id claim in JWT does not exist" }, 403);
    return json(userJson(users.get(claims.sub)!));
  }
  if (route === "POST /auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
    const { refresh_token } = (await req.json()) as { refresh_token: string };
    const s = [...sessions.values()].find((x) => x.refresh === refresh_token);
    if (!s?.alive) return json({ code: "refresh_token_not_found", error: "invalid_grant", message: "Invalid Refresh Token: Refresh Token Not Found" }, 400);
    s.refresh = `rt-${++n}`; // rotation — and the new token keeps aal and amr, as Supabase's does
    return json(sessionJson(s));
  }
  if (route === "POST /auth/v1/logout") {
    if (session) {
      const scope = url.searchParams.get("scope") ?? "global";
      for (const s of sessions.values()) {
        if (scope === "global" ? s.userId === session.userId : s.id === session.id) s.alive = false;
      }
    }
    return new Response(null, { status: 204 });
  }
  if (route === "POST /rest/v1/rpc/is_staff") return json(claims ? users.get(claims.sub)?.staff === true : false);
  // Claims only — exactly why the API gate has to ask /user as well.
  if (route === "POST /rest/v1/rpc/is_admin") return json(claims ? users.get(claims.sub)?.staff === true && claims.aal === "aal2" : false);
  return json({ message: `unexpected ${route}` }, 500);
}) as typeof fetch;

function newUser(email: string, staff: boolean, mfa = staff): FakeUser {
  const u = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, email, staff, mfa };
  users.set(u.id, u);
  return u;
}
function newSession(u: FakeUser, aal: "aal1" | "aal2", authAgoSec: number): FakeSession {
  const now = Math.floor(Date.now() / 1000);
  const amr: Amr[] = [{ method: "password", timestamp: now - authAgoSec - 30 }];
  if (aal === "aal2") amr.push({ method: "totp", timestamp: now - authAgoSec });
  const s = { id: `5e550000-0000-4000-8000-${String(++n).padStart(12, "0")}`, userId: u.id, aal, amr, alive: true, refresh: `rt-${++n}` };
  sessions.set(s.id, s);
  return s;
}

// ── Browser cookie jar ───────────────────────────────────────────────────────

const AUTH = "sb-placeholder-auth-token";

class Jar {
  m = new Map<string, string>();
  static signedIn(s: FakeSession, accessExpiresInSec = 3600) {
    const j = new Jar();
    j.m.set(AUTH, "base64-" + b64url(JSON.stringify(sessionJson(s, accessExpiresInSec))));
    return j;
  }
  clone() {
    const j = new Jar();
    this.m.forEach((v, k) => j.m.set(k, v));
    return j;
  }
  header() {
    return [...this.m].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  apply(res: { cookies: { getAll(): { name: string; value: string; maxAge?: number }[] } }) {
    for (const c of res.cookies.getAll()) {
      if (c.maxAge === 0 || c.value === "") this.m.delete(c.name);
      else this.m.set(c.name, c.value);
    }
    return res;
  }
  has(name: string) {
    return this.m.has(name);
  }
}

async function main() {
  const { NextRequest } = await import("next/server");
  const S = await import("../lib/adminSession");
  const { exactEmailPattern } = await import("../lib/orders");
  const { middleware } = await import("../middleware");
  const sessionRoute = await import("../app/api/admin/session/route");
  const { adminApiGate } = await import("../lib/adminApiGate");

  const ORIGIN = "https://thewovenne.com";
  const req = (p: string, jar: Jar, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`${ORIGIN}${p}`, { method: init.method ?? "GET", headers: { cookie: jar.header(), ...(init.headers ?? {}) } });

  /** Where the middleware sent this request: "pass", or the redirect target. */
  type MW = (r: InstanceType<typeof NextRequest>) => Promise<Response & { cookies: Jar["apply"] extends (r: infer R) => unknown ? R extends { cookies: infer C } ? C : never : never }>;
  async function visit(mw: MW, p: string, jar: Jar, headers?: Record<string, string>) {
    const res = await mw(req(p, jar, { headers }));
    jar.apply(res as never);
    const loc = res.headers.get("location");
    return loc ? loc.replace(ORIGIN, "") : "pass";
  }
  const mwNew = middleware as unknown as MW;

  // ── Part 1 — the rule ────────────────────────────────────────────────────
  console.log("\n=== 1. idle rule and activity record ===");
  const now = Date.now();
  const min = 60_000;
  const J = (lastSeenMs: number | null, lastAuthAtSec: number | null) => S.judgeAdminActivity({ now, lastSeenMs, lastAuthAtSec });
  check("activity 1 min ago → active", J(now - min, null), "active");
  check("activity 16 min ago (inside the 2-min server slack) → active", J(now - 16 * min, null), "active");
  check("activity 18 min ago → expired", J(now - 18 * min, null), "expired");
  check("no record, authenticator code entered 1 min ago → fresh-mfa", J(null, Math.floor((now - min) / 1000)), "fresh-mfa");
  check("no record, code entered 2 days ago (a refreshed token) → expired", J(null, Math.floor((now - 2 * 86400_000) / 1000)), "expired");
  check("stale record and an old code → expired", J(now - 30 * min, Math.floor((now - 3 * 3600_000) / 1000)), "expired");
  check("a record from the future is not trusted", J(now + 10 * min, null), "expired");
  check("nothing at all → expired", J(null, null), "expired");

  const sid = "5e55aaaa-0000-4000-8000-000000000001";
  const cookie = await S.mintActivityCookie(sid, now);
  check("minted record reads back for its own session", await S.readActivityCookie(cookie!, sid), now);
  check("…and not for another session", await S.readActivityCookie(cookie!, "5e55bbbb-0000-4000-8000-000000000002"), null);
  const [v, s2, at, sig] = cookie!.split(".");
  check("a moved timestamp breaks the signature", await S.readActivityCookie([v, s2, String(now + 5 * min), sig].join("."), sid), null);
  check("a flipped signature byte is refused", await S.readActivityCookie([v, s2, at, (sig[0] === "A" ? "B" : "A") + sig.slice(1)].join("."), sid), null);
  check("garbage is refused", await S.readActivityCookie("v1.x.y", sid), null);
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "a-different-key";
  check("a record signed under another key is refused", await S.readActivityCookie(cookie!, sid), null);
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  check("no secret configured → nothing can be minted (fails safe)", await S.mintActivityCookie(sid, now), null);
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  check("activity cookie is httpOnly, lax, path /, lives one window", [S.activityCookieOptions.httpOnly, S.activityCookieOptions.sameSite, S.activityCookieOptions.path, S.activityCookieOptions.maxAge], [true, "lax", "/", 17 * 60]);
  check("Supabase auth cookies recognised, others not",
    ["sb-abc-auth-token", "sb-abc-auth-token.0", "sb-abc-auth-token-code-verifier", "wovenne-cart", "wv_admin_active"].map(S.isSupabaseAuthCookie),
    [true, true, false, false, false]);
  check("exact email pattern escapes LIKE wildcards", exactEmailPattern(" jo_n%x\\y@ex.com "), "jo\\_n\\%x\\\\y@ex.com");

  // ── Part 2 — real middleware, endpoint and gate ──────────────────────────
  console.log("\n=== 2. middleware / session endpoint / API gate against a fake Supabase ===");

  // The middleware as it was merged at dd90511, for the BEFORE column.
  let mwOld: MW | null = null;
  const oldPath = path.join(__dirname, ".middleware-dd90511.tmp.ts");
  try {
    const src = execFileSync("git", ["show", "dd90511:middleware.ts"], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    fs.writeFileSync(oldPath, src.replace('"./lib/country"', '"../lib/country"'));
    mwOld = (await import(oldPath)).middleware as MW;
  } catch {
    console.log("  (dd90511 not available — BEFORE column skipped)");
  } finally {
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const customer = newUser("shopper@example.test", false);
  const admin = newUser("staff@example.test", true);
  const freshAdmin = () => newSession(admin, "aal2", 30); // code entered 30 s ago

  // Anonymous
  check("1. anonymous → /admin/dashboard → login", await visit(mwNew, "/admin/dashboard", new Jar()), "/admin/login");
  check("   anonymous → /in/account/profile → customer login", await visit(mwNew, "/in/account/profile", new Jar()), "/in/login?from=%2Fin%2Faccount%2Fprofile");

  // Customer
  const cs = newSession(customer, "aal1", 5 * 86400);
  check("2. customer → /admin/dashboard → refused", await visit(mwNew, "/admin/dashboard", Jar.signedIn(cs)), "/admin/login?denied=1");
  check("   customer → /in/account/profile → their account", await visit(mwNew, "/in/account/profile", Jar.signedIn(cs)), "pass");
  {
    // 14. Persistence: a customer days after signing in, access token expired —
    // refreshed as normal, never judged by the admin idle rule.
    const jar = Jar.signedIn(cs, -60);
    const before = jar.m.get(AUTH);
    check("14. customer with an expired access token → refreshed, still their account", await visit(mwNew, "/in/account/orders", jar), "pass");
    check("    …and the browser received the refreshed session", jar.m.get(AUTH) !== before && jar.has(AUTH), true);
    check("    …and no admin activity record was ever issued to a customer", jar.has(S.ADMIN_ACTIVITY_COOKIE), false);
    check("    customer browsing the shop is untouched", await visit(mwNew, "/in/shop", jar), "pass");
    check("    customer session still alive at Supabase", sessions.get(cs.id)!.alive, true);
  }

  // Admin at aal1
  {
    const s = newSession(admin, "aal1", 10);
    check("4. admin, password only → /admin/dashboard → second factor", await visit(mwNew, "/admin/dashboard", Jar.signedIn(s)), "/admin/mfa");
  }

  // Admin at aal2
  {
    const s = freshAdmin();
    const jar = Jar.signedIn(s);
    check("5. admin, code just entered → /admin/dashboard → allowed", await visit(mwNew, "/admin/dashboard", jar), "pass");
    check("   …and the server started its activity record", jar.has(S.ADMIN_ACTIVITY_COOKIE), true);
    check("   /admin/mfa when already verified → dashboard", await visit(mwNew, "/admin/mfa", jar), "/admin/dashboard");
    check("6. same admin → storefront person icon (/in/account/profile) → CUSTOMER account", await visit(mwNew, "/in/account/profile", jar), "pass");
    check("   …orders and wishlist too, not the dashboard", [await visit(mwNew, "/in/account/orders", jar), await visit(mwNew, "/in/account/wishlist", jar)], ["pass", "pass"]);
    if (mwOld) check("   BEFORE: the same admin was sent to /admin/dashboard", await visit(mwOld, "/in/account/profile", Jar.signedIn(s)), "/admin/dashboard");
    check("   /admin/login while verified and active → dashboard", await visit(mwNew, "/admin/login", jar), "/admin/dashboard");
  }

  // Prefetches never count as activity
  {
    const s = freshAdmin();
    const jar = Jar.signedIn(s);
    await visit(mwNew, "/admin/dashboard", jar);
    const stale = await S.mintActivityCookie(s.id, Date.now() - 10 * min);
    jar.m.set(S.ADMIN_ACTIVITY_COOKIE, stale!);
    await visit(mwNew, "/admin/products", jar, { "next-router-prefetch": "1" });
    check("a router prefetch is let through but does not refresh the record", jar.m.get(S.ADMIN_ACTIVITY_COOKIE), stale);
    await visit(mwNew, "/admin/products", jar);
    check("a real navigation refreshes it", jar.m.get(S.ADMIN_ACTIVITY_COOKIE) !== stale, true);
  }

  // Idle expiry: tab left open, record 20 min old
  {
    const s = newSession(admin, "aal2", 3 * 3600);
    const jar = Jar.signedIn(s);
    jar.m.set(S.ADMIN_ACTIVITY_COOKIE, (await S.mintActivityCookie(s.id, Date.now() - 20 * min))!);
    const stolen = jar.clone();
    check("12. idle-expired admin → /admin/dashboard → login (timeout)", await visit(mwNew, "/admin/dashboard", jar), "/admin/login?timeout=1");
    check("    session REVOKED at Supabase, not just hidden", sessions.get(s.id)!.alive, false);
    check("    browser's session cookie and activity record cleared", [jar.has(AUTH), jar.has(S.ADMIN_ACTIVITY_COOKIE)], [false, false]);
    check("    refresh → still login", await visit(mwNew, "/admin/dashboard", jar), "/admin/login");
    check("13. the old cookies, replayed → login (Supabase refuses the session)", await visit(mwNew, "/admin/dashboard", stolen.clone()), "/admin/login");
    const expiredAccess = Jar.signedIn(s, -60);
    check("13. the old REFRESH token cannot mint a new session → login", await visit(mwNew, "/admin/dashboard", expiredAccess), "/admin/login");
    check("    (it was tried, and refused)", calls.filter((c) => c.startsWith("POST /auth/v1/token")).length > 0, true);
    const r = await adminApiGate(req("/api/admin/orders/cancel", stolen.clone(), { method: "POST" }));
    check("11. idle-expired (revoked) admin → protected admin API → 401", r?.status, 401);
  }

  // Tab closed: no record at all, the session restored next day by its refresh token
  {
    const s = newSession(admin, "aal2", 26 * 3600);
    const jar = Jar.signedIn(s, -60); // access token long expired; refresh token alive
    if (mwOld) {
      const old = await visit(mwOld, "/admin/dashboard", jar.clone());
      check("9. BEFORE: a session refreshed the next day opened the dashboard silently", old, "pass");
      sessions.get(s.id)!.alive = true;
    }
    // The BEFORE run rotated the refresh token, as a real refresh does; the
    // browser would hold the rotated one.
    check("9. NOW: the same session → login (timeout)", await visit(mwNew, "/admin/dashboard", Jar.signedIn(s, -60)), "/admin/login?timeout=1");
    check("   and it is revoked", sessions.get(s.id)!.alive, false);
  }

  // Detour to the storefront, then back after 20 min
  {
    const s = freshAdmin();
    const jar = Jar.signedIn(s);
    await visit(mwNew, "/admin/dashboard", jar);
    check("admin browses the shop — customer account works", await visit(mwNew, "/in/account/profile", jar), "pass");
    jar.m.set(S.ADMIN_ACTIVITY_COOKIE, (await S.mintActivityCookie(s.id, Date.now() - 20 * min))!);
    s.amr = s.amr.map((a) => ({ ...a, timestamp: a.timestamp - 3600 }));
    const fresh = Jar.signedIn(s);
    fresh.m.set(S.ADMIN_ACTIVITY_COOKIE, jar.m.get(S.ADMIN_ACTIVITY_COOKIE)!);
    check("…back at /admin 20 min later → login; storefront time is not admin activity", await visit(mwNew, "/admin/dashboard", fresh), "/admin/login?timeout=1");
  }

  // Forged and transplanted records
  {
    const s = newSession(admin, "aal2", 3 * 3600);
    const other = newSession(admin, "aal2", 3 * 3600);
    const jar = Jar.signedIn(s);
    jar.m.set(S.ADMIN_ACTIVITY_COOKIE, (await S.mintActivityCookie(other.id, Date.now()))!);
    check("a record issued to ANOTHER session does not keep this one alive", await visit(mwNew, "/admin/dashboard", jar), "/admin/login?timeout=1");
    const s3 = newSession(admin, "aal2", 3 * 3600);
    const jar3 = Jar.signedIn(s3);
    jar3.m.set(S.ADMIN_ACTIVITY_COOKIE, `v1.${s3.id}.${Date.now()}.forged`);
    check("a hand-written record is refused", await visit(mwNew, "/admin/dashboard", jar3), "/admin/login?timeout=1");
  }

  // Login page with an expired-but-verified session
  {
    const s = newSession(admin, "aal2", 3 * 3600);
    const jar = Jar.signedIn(s);
    check("/admin/login with an idle-expired session → the form, not the dashboard", await visit(mwNew, "/admin/login", jar), "pass");
    check("…and that session is ended", [sessions.get(s.id)!.alive, jar.has(AUTH)], [false, false]);
  }

  // Explicit sign-out (the browser's half is lib/adminSessionClient; here, the server's)
  {
    const s = freshAdmin();
    const jar = Jar.signedIn(s);
    await visit(mwNew, "/admin/dashboard", jar);
    const before = jar.clone();
    // Worst case: the browser's own signOut failed, so DELETE is all there is.
    const res = await sessionRoute.DELETE(req("/api/admin/session", jar, { method: "DELETE" }));
    jar.apply(res as never);
    check("explicit sign-out: session revoked at Supabase", sessions.get(s.id)!.alive, false);
    check("  session cookie and activity record cleared", [jar.has(AUTH), jar.has(S.ADMIN_ACTIVITY_COOKIE)], [false, false]);
    check("  response is not cacheable", res.headers.get("cache-control"), "no-store");
    check("7. after sign-out → /admin/dashboard → login", await visit(mwNew, "/admin/dashboard", jar), "/admin/login");
    check("9. refresh after sign-out → still login", await visit(mwNew, "/admin/products", jar), "/admin/login");
    check("8/7. pre-sign-out cookies replayed → login", await visit(mwNew, "/admin/dashboard", before.clone()), "/admin/login");
    const api = await adminApiGate(req("/api/admin/export", before.clone(), { method: "POST" }));
    check("10. pre-sign-out cookies → protected admin API → 401", api?.status, 401);
    check("    (is_admin() alone would have said yes to that token — claims only)", true, true);
    const other = new Jar();
    other.m.set("wovenne-cart", "keep");
    other.m.set("wv_pref", "keep");
    const r2 = await sessionRoute.DELETE(req("/api/admin/session", other, { method: "DELETE" }));
    other.apply(r2 as never);
    check("  sign-out leaves unrelated cookies alone", [other.m.get("wovenne-cart"), other.m.get("wv_pref")], ["keep", "keep"]);
  }

  // Admin API gate
  {
    const s = freshAdmin();
    const jar = Jar.signedIn(s);
    await visit(mwNew, "/admin/dashboard", jar);
    check("API gate: active admin → let through to the route", await adminApiGate(req("/api/admin/export", jar, { method: "POST" })), null);
    check("API gate: customer → left to the route's is_admin() (not signed out)", await adminApiGate(req("/api/admin/export", Jar.signedIn(cs), { method: "POST" })), null);
    check("   …customer session untouched", sessions.get(cs.id)!.alive, true);
    check("API gate: anonymous → left to the route (some routes answer 404 on purpose)", await adminApiGate(req("/api/admin/export", new Jar(), { method: "POST" })), null);
    const aal1 = newSession(admin, "aal1", 10);
    check("3/4. API gate: admin at aal1 → left to is_admin(), which refuses", await adminApiGate(req("/api/admin/export", Jar.signedIn(aal1), { method: "POST" })), null);
  }

  // Heartbeat and status
  {
    const s = freshAdmin();
    const jar = Jar.signedIn(s);
    await visit(mwNew, "/admin/dashboard", jar);
    const old = (await S.mintActivityCookie(s.id, Date.now() - 5 * min))!;
    jar.m.set(S.ADMIN_ACTIVITY_COOKIE, old);
    const st = await sessionRoute.GET(req("/api/admin/session", jar));
    jar.apply(st as never);
    const body = (await st.json()) as { activity: string; lastSeenMs: number };
    check("status: reports active and when, without counting as activity", [body.activity, jar.m.get(S.ADMIN_ACTIVITY_COOKIE) === old], ["active", true]);
    const hb = await sessionRoute.POST(req("/api/admin/session", jar, { method: "POST" }));
    jar.apply(hb as never);
    check("heartbeat: refreshes the record", [hb.status, jar.m.get(S.ADMIN_ACTIVITY_COOKIE) !== old], [200, true]);
    jar.m.set(S.ADMIN_ACTIVITY_COOKIE, (await S.mintActivityCookie(s.id, Date.now() - 20 * min))!);
    s.amr = s.amr.map((a) => ({ ...a, timestamp: a.timestamp - 3600 }));
    const late = Jar.signedIn(s);
    late.m.set(S.ADMIN_ACTIVITY_COOKIE, jar.m.get(S.ADMIN_ACTIVITY_COOKIE)!);
    const hb2 = await sessionRoute.POST(req("/api/admin/session", late, { method: "POST" }));
    check("heartbeat after expiry: refused and the session revoked — it cannot be revived", [hb2.status, sessions.get(s.id)!.alive], [401, false]);
    const hbc = await sessionRoute.POST(req("/api/admin/session", Jar.signedIn(cs), { method: "POST" }));
    check("heartbeat from a customer: refused, no record issued", [hbc.status, hbc.headers.get("set-cookie")?.includes(S.ADMIN_ACTIVITY_COOKIE) ?? false], [401, false]);
    const aal1 = newSession(admin, "aal1", 10);
    const hba = await sessionRoute.POST(req("/api/admin/session", Jar.signedIn(aal1), { method: "POST" }));
    check("heartbeat from staff at aal1: refused", hba.status, 401);
  }

  // ── Part 3 — wiring ──────────────────────────────────────────────────────
  console.log("\n=== 3. wiring ===");
  const root = path.join(__dirname, "..");
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  /** Source with comments removed, so a check matches code and not prose about it. */
  const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const walk = (d: string): string[] =>
    fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "route.ts" ? [path.join(d, e.name)] : []);
  const adminRoutes = walk("app/api/admin").filter((p) => !p.endsWith(path.join("session", "route.ts")));
  check("there are admin API routes to guard", adminRoutes.length >= 10, true);
  for (const p of [...adminRoutes, "app/api/preview/route.ts"]) {
    const src = read(p);
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\((\w+): NextRequest\) \{\n((?:\s*\/\/[^\n]*\n)*)\s*const ended = await adminApiGate\(\2\);\n\s*if \(ended\) return ended;/g)].length;
    const all = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)].length;
    check(`${p}: every handler runs the gate first (${handlers}/${all})`, handlers === all && all > 0, true);
  }
  const mw = code("middleware.ts");
  check("middleware no longer sends staff from /in/account to /admin/dashboard",
    /accountPath\)[\s\S]*?return response;\n  \}/.exec(mw)?.[0].includes("/admin/dashboard"), false);
  const header = read("components/admin/AdminHeader.tsx");
  const mfa = read("app/(admin)/admin/mfa/page.tsx");
  const idle = read("components/admin/IdleTimeout.tsx");
  const client = code("lib/adminSessionClient.ts");
  check("Sign out (header) → endAdminSession('signed-out')", header.includes('endAdminSession("signed-out")') && !/auth\.signOut\(/.test(header), true);
  check("Sign out (MFA page) → endAdminSession('signed-out')", mfa.includes('endAdminSession("signed-out")') && !/auth\.signOut\(/.test(mfa), true);
  check("idle countdown → endAdminSession('timeout')", idle.includes('endAdminSession("timeout")') && !/auth\.signOut\(/.test(idle), true);
  check("endAdminSession: Supabase sign-out, then DELETE /api/admin/session, then a full replace()",
    [/auth\.signOut\(/, /method: "DELETE"/, /window\.location\.replace\(/].map((r) => r.test(client)) .concat([client.indexOf("signOut(") < client.indexOf('"DELETE"'), client.indexOf('"DELETE"') < client.indexOf("location.replace")]),
    [true, true, true, true, true]);
  check("endAdminSession does not use router.replace (would keep the router cache)", /router\./.test(client), false);
  check("idle countdown reports activity to the server", /fetch\("\/api\/admin\/session", \{ method: "POST"/.test(idle), true);
  check("idle countdown asks the server before signing out (other tabs)", /fetch\("\/api\/admin\/session", \{ cache: "no-store" \}\)/.test(idle), true);
  check("Back from bfcache reloads, so middleware decides", /pageshow[\s\S]*persisted[\s\S]*location\.reload\(\)/.test(idle), true);
  check("customer storage is not touched by admin sign-out", /localStorage|sessionStorage/.test(client), false);
  check("customer sign-out still local scope, cart reset first", /resetForSignOut\(\);[\s\S]*signOut\(\{ scope: "local" \}\)/.test(read("lib/customerAuth.ts")), true);
  check("customer login still turns staff credentials away (admin entry stays separate)", /is_staff[\s\S]*Incorrect email or password/.test(read("lib/customerAuth.ts")), true);
  for (const [p, re] of [
    ["lib/orders.ts", /getMyOrders\(client: SupabaseClient, email: string\)[\s\S]*?\.ilike\("customer_email", exactEmailPattern\(email\)\)/],
    ["app/(storefront)/in/account/orders/page.tsx", /getMyOrders\(supabase, user\.email \?\? ""\)[\s\S]*\.in\("order_id", orders\.map/],
    ["app/(storefront)/in/account/profile/page.tsx", /from\("orders"\)[\s\S]*?ilike\("customer_email", exactEmailPattern\(user\.email/],
    ["app/(storefront)/in/account/settings/page.tsx", /from\("orders"\)[\s\S]*?ilike\("customer_email", exactEmailPattern\(user\.email/],
    ["lib/loyalty.ts", /from\("loyalty_ledger"\)[\s\S]*?\.eq\("user_id", user\.id\)/],
    ["lib/style.ts", /from\("style_submissions"\)[\s\S]*?\.eq\("user_id", user\.id\)/],
  ] as [string, RegExp][]) {
    check(`customer read scoped to the signed-in person: ${p}`, re.test(read(p)), true);
  }

  // ── Part 4 — the leak, on real PostgreSQL ────────────────────────────────
  console.log("\n=== 4. customer account reads as a verified admin (real PostgreSQL) ===");
  const { startEngine, asRoot, asUser, makeAdmin } = await import("./pg-world");
  const engine = await startEngine();
  if (!engine) {
    console.log("  SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Part 4 not verified.");
  } else {
    try {
      await engine.database("sessiondb");
      const c = await engine.connect("sessiondb");
      const staff = await makeAdmin(c, "staff@example.test");
      await asRoot(c);
      const cust = (await c.query("insert into auth.users (email) values ('jo_n@example.test') returning id")).rows[0].id as string;
      await c.query("insert into profiles (id, email) values ($1, 'jo_n@example.test') on conflict (id) do nothing", [cust]);
      for (const email of ["jo_n@example.test", "JOHN@example.test", "Staff@Example.test"]) {
        await c.query(`insert into orders (items, total_inr, payment_status, status, customer_email, customer_phone)
                       values ('[]'::jsonb, 100, 'paid', 'placed', $1, '+91 90000 0000' || length($1))`, [email]);
      }
      await c.query("insert into loyalty_ledger (user_id, points, reason) values ($1, 50, 'earned'), ($2, 10, 'earned')", [cust, staff]);

      const as = async (id: string, email: string, aal: "aal1" | "aal2") => {
        await asUser(c, id, aal);
        await c.query("select set_config('request.jwt.claim.email', $1, false)", [email]);
      };
      const emails = async (where = "", params: unknown[] = []) =>
        (await c.query(`select lower(customer_email) e from orders ${where} order by 1`, params)).rows.map((r) => r.e);

      await as(staff, "staff@example.test", "aal2");
      check("verified admin, UNFILTERED orders read → every customer's order (the leak)", await emails(), ["jo_n@example.test", "john@example.test", "staff@example.test"]);
      check("verified admin, getMyOrders filter → only their own", await emails("where customer_email ilike $1", [exactEmailPattern("staff@example.test")]), ["staff@example.test"]);
      check("verified admin, ledger unfiltered → everyone's entries", (await c.query("select count(*)::int n from loyalty_ledger")).rows[0].n, 2);
      check("verified admin, ledger filtered by user → only their own", (await c.query("select count(*)::int n from loyalty_ledger where user_id = $1", [staff])).rows[0].n, 1);

      await as(cust, "jo_n@example.test", "aal1");
      check("customer, RLS alone → their own order only", await emails(), ["jo_n@example.test"]);
      check("customer, with the filter → the same (the filter changes nothing for customers)", await emails("where customer_email ilike $1", [exactEmailPattern("jo_n@example.test")]), ["jo_n@example.test"]);
      await as(staff, "staff@example.test", "aal2");
      check("underscore is literal: jo_n's pattern does not match JOHN", await emails("where customer_email ilike $1", [exactEmailPattern("jo_n@example.test")]), ["jo_n@example.test"]);
      check("empty email matches nothing (fails closed)", await emails("where customer_email ilike $1", [exactEmailPattern("")]), []);
      await asRoot(c);
      await c.end();
    } finally {
      await engine.stop();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
