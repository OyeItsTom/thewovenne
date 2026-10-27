/**
 * Cross-device password recovery (WP-OPS-01C): the token-hash link, the
 * Continue step, the in-memory proof, old PKCE links, and token redaction.
 *
 *   npx --cache <scratch>/npmcache --yes tsx@4.19.2 scripts/password-recovery.test.ts
 *
 * What is proven:
 *   1. parseRecoveryUrl / urlWithoutAuthParams — only a well-formed
 *      `#token_hash=…&type=recovery` is a link; anything else is malformed or
 *      nothing; the address bar loses every secret, relatively.
 *   2. verifyRecoveryLink against a stand-in auth client — one verifyOtp, type
 *      "recovery"; success yields a proof bound to user and session; every
 *      failure is classified only as far as the evidence goes and opens nothing.
 *   3. recoveryFormOpen — the proof, or an old link's amr `recovery`, opens the
 *      form; a password, Google or signup-code (`otp`) session never does; a
 *      session swap, a different user or the 15-minute window closes it.
 *   4. Scenarios: Mac → iPhone and iPhone → Mac with the new link (no verifier
 *      anywhere), the old link on another device, refresh, double tap, retry.
 *   5. The page's lifecycle, RUN (createRecoveryFlow with a stand-in auth
 *      client that emits events in auth-js 2.111's order): Continue, retries,
 *      double taps, Strict Mode, auth events mid-check and mid-save, another
 *      account, token refresh, the 15 minutes running out, leaving the page —
 *      and which session, if any, is signed out each time.
 *   6. The page's wiring and copy — SOURCE checks only (no DOM here): the
 *      component hands everything to the flow; one static first render.
 *   7. Sentry masking, executed: breadcrumbs (incl. console arguments), event
 *      message, exception text, page URL, query and headers.
 *
 * Sections 1–5 and 7 execute the code. Section 6 reads source text, which catches a
 * deleted or rewired line but not wrong behaviour of the same shape. None of
 * it proves delivery, real Supabase behaviour, real browsers or real
 * cross-device use; those need the owner's checks after the template change.
 *
 * Exits non-zero on failure.
 */
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  classifyVerifyFailure,
  initialRecoveryPhase,
  parseRecoveryUrl,
  proofFromRecoverySession,
  proofFromVerifiedSession,
  recoveryFormOpen,
  sessionMatchesProof,
  urlWithoutAuthParams,
  verifyRecoveryLink,
  VERIFY_FAILURE_COPY,
  type RecoveryAuth,
} from "../lib/passwordRecovery";
import { createRecoveryFlow, type RecoveryFlowAuth, type RecoveryView } from "../lib/passwordRecoveryFlow";
import { RECOVERY_WINDOW_SECONDS } from "../lib/signInMethods";
import { redactAuthSecrets, redactAuthSecretsDeep, redactBreadcrumb, redactEvent } from "../lib/redactAuthSecrets";

(globalThis as { React?: typeof React }).React = React;

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (ok) pass++;
  else fail++;
}

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const SITE = "https://www.thewovenne.com/in/reset-password";
const HEX56 = "a".repeat(20) + "0123456789abcdef0123456789abcdef0123";
const PKCE_HASH = `pkce_${HEX56}`;

const now = Date.UTC(2026, 9, 27, 14, 0, 0);
const s = now / 1000;
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: unknown) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(claims)}.sig`;
/** A session as GoTrue issues it from verifyOtp: amr otp. */
const otpSession = (sub = "user-a", sid = "sess-1") => jwt({ sub, session_id: sid, amr: [{ method: "otp", timestamp: s }] });

(async () => {
  // ── 1. The URL ──
  console.log("\nparseRecoveryUrl");
  t("HEX56 fixture is 56 hex characters", /^[0-9a-f]{56}$/.test(HEX56));
  const good = parseRecoveryUrl(`${SITE}#token_hash=${PKCE_HASH}&type=recovery`);
  t("new link (pkce_-prefixed hash, as a PKCE client's request produces) → token", good.link.kind === "token" && good.link.tokenHash === PKCE_HASH);
  t("unprefixed hash (implicit-flow request) → token", parseRecoveryUrl(`${SITE}#token_hash=${HEX56}&type=recovery`).link.kind === "token");
  t("new link is neither an error nor an old code", !good.supabaseError && !good.legacyCode);
  t("parameter order does not matter", parseRecoveryUrl(`${SITE}#type=recovery&token_hash=${HEX56}`).link.kind === "token");
  const malformed: [string, string][] = [
    ["type signup", `#token_hash=${HEX56}&type=signup`],
    ["type email", `#token_hash=${HEX56}&type=email`],
    ["type magiclink", `#token_hash=${HEX56}&type=magiclink`],
    ["no type", `#token_hash=${HEX56}`],
    ["two types", `#token_hash=${HEX56}&type=recovery&type=recovery`],
    ["two tokens", `#token_hash=${HEX56}&token_hash=${HEX56}&type=recovery`],
    ["empty token", `#token_hash=&type=recovery`],
    ["truncated token (copied short)", `#token_hash=${HEX56.slice(0, 20)}&type=recovery`],
    ["non-hex", `#token_hash=${"z".repeat(56)}&type=recovery`],
    ["script injection", `#token_hash=%3Cscript%3E&type=recovery`],
    ["oversized fragment", `#token_hash=${HEX56}&type=recovery&pad=${"x".repeat(600)}`],
    ["unknown prefix", `#token_hash=implicit_${HEX56}&type=recovery`],
  ];
  for (const [name, frag] of malformed) t(`malformed: ${name}`, parseRecoveryUrl(SITE + frag).link.kind === "malformed");
  t("token in the QUERY is refused (it would reach the server and its logs)", parseRecoveryUrl(`${SITE}?token_hash=${HEX56}&type=recovery`).link.kind === "malformed");
  t("no fragment → none", parseRecoveryUrl(SITE).link.kind === "none");
  t("unrelated fragment → none", parseRecoveryUrl(`${SITE}#top`).link.kind === "none");
  t("garbage href → none, no throw", parseRecoveryUrl("not a url").link.kind === "none");
  t("old link's ?code= → legacyCode", parseRecoveryUrl(`${SITE}?code=abc`).legacyCode);
  t("Supabase error redirect (query) → supabaseError", parseRecoveryUrl(`${SITE}?error=access_denied&error_code=otp_expired`).supabaseError);
  t("Supabase error redirect (fragment) → supabaseError", parseRecoveryUrl(`${SITE}#error=access_denied&error_code=otp_expired&error_description=x`).supabaseError);

  console.log("\nurlWithoutAuthParams");
  t("token fragment removed, path kept, relative", urlWithoutAuthParams(`${SITE}#token_hash=${HEX56}&type=recovery`) === "/in/reset-password");
  t("malformed token fragment removed too", urlWithoutAuthParams(`${SITE}#token_hash=junk`) === "/in/reset-password");
  t("old ?code= removed", urlWithoutAuthParams(`${SITE}?code=abc`) === "/in/reset-password");
  t("error params removed, unrelated query kept", urlWithoutAuthParams(`${SITE}?utm_source=x&error=a&error_code=otp_expired&error_description=b`) === "/in/reset-password?utm_source=x");
  t("query token and its type removed", urlWithoutAuthParams(`${SITE}?token_hash=${HEX56}&type=recovery`) === "/in/reset-password");
  t("implicit-style access_token fragment removed", urlWithoutAuthParams(`${SITE}#access_token=x&refresh_token=y`) === "/in/reset-password");
  t("nothing secret → null (no history write)", urlWithoutAuthParams(SITE) === null && urlWithoutAuthParams(`${SITE}#top`) === null);
  const crossOrigin = urlWithoutAuthParams(`https://evil.example/in/reset-password?code=x`);
  t("result is always a same-origin path, never an origin", crossOrigin === "/in/reset-password");

  // ── 2. verifyRecoveryLink ──
  console.log("\nverifyRecoveryLink");
  type Call = { token_hash: string; type: string };
  const fakeAuth = (answer: () => Promise<Awaited<ReturnType<RecoveryAuth["verifyOtp"]>>>) => {
    const calls: Call[] = [];
    const auth: RecoveryAuth = {
      verifyOtp: async (p) => {
        calls.push(p);
        return answer();
      },
    };
    return { auth, calls };
  };
  const ok = (token: string, id = "user-a") => async () => ({ data: { user: { id }, session: { access_token: token } }, error: null });
  const err = (e: unknown) => async () => ({ data: { user: null, session: null }, error: e });

  {
    const { auth, calls } = fakeAuth(ok(otpSession()));
    const r = await verifyRecoveryLink(auth, PKCE_HASH, () => now);
    t("exactly one verifyOtp, with the token hash and type recovery only", calls.length === 1 && calls[0].token_hash === PKCE_HASH && calls[0].type === "recovery" && Object.keys(calls[0]).sort().join() === "token_hash,type");
    t("success → proof bound to the user and the session id", r.ok && r.proof.userId === "user-a" && r.proof.sessionKey === "sid:sess-1" && r.proof.verifiedAtMs === now);
  }
  {
    const { auth } = fakeAuth(ok(otpSession("user-a"), "user-b"));
    const r = await verifyRecoveryLink(auth, HEX56, () => now);
    t("session for a different user than reported → no proof", !r.ok && r.failure === "unknown");
  }
  {
    const { auth } = fakeAuth(async () => ({ data: { user: { id: "user-a" }, session: null }, error: null }));
    const r = await verifyRecoveryLink(auth, HEX56, () => now);
    t("success without a session → no proof", !r.ok);
  }
  {
    const { auth } = fakeAuth(ok("not-a-jwt"));
    t("unreadable session token → no proof", !(await verifyRecoveryLink(auth, HEX56, () => now)).ok);
  }
  const apiErr = (status: number, c?: string, name = "AuthApiError") => Object.assign(new Error("x"), { name, status, code: c });
  const failures: [string, unknown, string][] = [
    ["used / expired / wrong (GoTrue 403 otp_expired)", apiErr(403, "otp_expired"), "invalid"],
    ["signup token hash checked as recovery (not found → otp_expired)", apiErr(403, "otp_expired"), "invalid"],
    ["validation failure (400)", apiErr(400, "validation_failed"), "invalid"],
    ["banned user (403 user_banned)", apiErr(403, "user_banned"), "invalid"],
    ["network down (AuthRetryableFetchError, status 0)", apiErr(0, undefined, "AuthRetryableFetchError"), "network"],
    ["gateway timeout (504)", apiErr(504, undefined, "AuthRetryableFetchError"), "network"],
    ["server error (500)", apiErr(500, "unexpected_failure"), "network"],
    ["rate limited (429)", apiErr(429, "over_request_rate_limit"), "rate_limited"],
    ["unrecognised", apiErr(418, "teapot"), "unknown"],
  ];
  for (const [name, e, want] of failures) {
    const { auth } = fakeAuth(err(e));
    const r = await verifyRecoveryLink(auth, HEX56, () => now);
    t(`${name} → ${want}, no proof`, !r.ok && r.failure === want, JSON.stringify(r));
  }
  {
    const auth: RecoveryAuth = { verifyOtp: async () => { throw new TypeError("Failed to fetch"); } };
    const r = await verifyRecoveryLink(auth, HEX56, () => now);
    t("fetch throwing → network, no proof, no throw", !r.ok && r.failure === "network");
  }
  t("non-object error → unknown", classifyVerifyFailure("boom") === "unknown" && classifyVerifyFailure(null) === "unknown");
  t("retryable failures have copy; none claims a precise expiry", Object.values(VERIFY_FAILURE_COPY).every((m) => m.length > 0 && !/expired/i.test(m)));

  // ── 3. recoveryFormOpen ──
  console.log("\nrecoveryFormOpen");
  const proof = proofFromVerifiedSession(otpSession(), "user-a", now)!;
  t("proof + its own session → form", recoveryFormOpen(otpSession(), proof, now));
  t("same session after a token refresh (same session_id) → form", recoveryFormOpen(jwt({ sub: "user-a", session_id: "sess-1", amr: [{ method: "otp", timestamp: s }], iat: s + 60 }), proof, now + 60_000));
  t("generic otp session WITHOUT a proof (signup code) → no form", !recoveryFormOpen(otpSession(), null, now));
  t("password session without proof → no form", !recoveryFormOpen(jwt({ sub: "user-a", session_id: "s", amr: [{ method: "password", timestamp: s }] }), null, now));
  t("Google session without proof → no form", !recoveryFormOpen(jwt({ sub: "user-a", session_id: "s", amr: [{ method: "oauth", timestamp: s }] }), null, now));
  t("proof, but the browser now holds ANOTHER user → no form", !recoveryFormOpen(otpSession("user-b", "sess-1"), proof, now));
  t("proof, same user but a different session (signed in again elsewhere) → no form", !recoveryFormOpen(otpSession("user-a", "sess-2"), proof, now));
  t("proof, signed out → no form", !recoveryFormOpen(null, proof, now) && !recoveryFormOpen(undefined, proof, now));
  t("proof at 14 min → form", recoveryFormOpen(otpSession(), proof, now + 14 * 60_000));
  t("proof past the 15-minute window → no form", !recoveryFormOpen(otpSession(), proof, now + RECOVERY_WINDOW_SECONDS * 1000 + 1));
  t("proof from the future (clock jump) → no form", !recoveryFormOpen(otpSession(), proof, now - 5 * 60_000));
  const noSid = jwt({ sub: "user-a", amr: [{ method: "otp", timestamp: s }] });
  const proofNoSid = proofFromVerifiedSession(noSid, "user-a", now)!;
  t("no session_id claim → bound to the exact token", recoveryFormOpen(noSid, proofNoSid, now) && !recoveryFormOpen(jwt({ sub: "user-a", amr: [], x: 1 }), proofNoSid, now));
  t("old PKCE link (amr recovery, fresh) still opens without a proof", recoveryFormOpen(jwt({ sub: "user-a", amr: [{ method: "recovery", timestamp: s - 5 }] }), null, now));
  t("old PKCE link past the window → no form", !recoveryFormOpen(jwt({ sub: "user-a", amr: [{ method: "recovery", timestamp: s - RECOVERY_WINDOW_SECONDS - 1 }] }), null, now));

  console.log("\ninitialRecoveryPhase");
  const u = (href: string) => parseRecoveryUrl(href);
  t("new link → confirm (Continue), even with an old recovery session around", initialRecoveryPhase(u(`${SITE}#token_hash=${HEX56}&type=recovery`), true) === "confirm");
  t("new link with a signed-in non-recovery session → confirm, never form", initialRecoveryPhase(u(`${SITE}#token_hash=${HEX56}&type=recovery`), false) === "confirm");
  t("malformed link → invalid", initialRecoveryPhase(u(`${SITE}#token_hash=x&type=recovery`), false) === "invalid");
  t("Supabase error redirect → invalid", initialRecoveryPhase(u(`${SITE}?error_code=otp_expired`), false) === "invalid");
  t("old link exchanged here (same browser) → form", initialRecoveryPhase(u(`${SITE}?code=abc`), true) === "form");
  t("old link on another device (code, no session) → otherBrowser, not 'expired'", initialRecoveryPhase(u(`${SITE}?code=abc`), false) === "otherBrowser");
  t("no link, signed in normally → noLink", initialRecoveryPhase(u(SITE), false) === "noLink");

  // ── 4. Scenarios (stand-ins; not real devices) ──
  console.log("\nScenarios");
  {
    // Mac asked; the link is opened on an iPhone that has no verifier and no
    // session. Only the fragment travels.
    const iphoneUrl = u(`${SITE}#token_hash=${PKCE_HASH}&type=recovery`);
    const { auth, calls } = fakeAuth(ok(otpSession("user-a", "phone-sess")));
    t("Mac → iPhone: page opens on Continue, nothing verified yet", initialRecoveryPhase(iphoneUrl, false) === "confirm" && calls.length === 0);
    const r = iphoneUrl.link.kind === "token" ? await verifyRecoveryLink(auth, iphoneUrl.link.tokenHash, () => now) : null;
    t("Mac → iPhone: Continue verifies once and the form opens for that session", !!r && r.ok && calls.length === 1 && recoveryFormOpen(otpSession("user-a", "phone-sess"), r.proof, now));
  }
  {
    const macUrl = u(`${SITE}#token_hash=${PKCE_HASH}&type=recovery`);
    const { auth } = fakeAuth(ok(otpSession("user-a", "mac-sess")));
    const r = macUrl.link.kind === "token" ? await verifyRecoveryLink(auth, macUrl.link.tokenHash, () => now) : null;
    t("iPhone → Mac: same path, no dependence on the asking device", !!r && r.ok && recoveryFormOpen(otpSession("user-a", "mac-sess"), r.proof, now));
  }
  {
    // The token is spent by the first verify; a second (another tab, a retry
    // after success, the same link on the other device) is refused.
    let used = false;
    const auth: RecoveryAuth = {
      verifyOtp: async () => {
        if (used) return { data: { user: null, session: null }, error: apiErr(403, "otp_expired") };
        used = true;
        return { data: { user: { id: "user-a" }, session: { access_token: otpSession() } }, error: null };
      },
    };
    const first = await verifyRecoveryLink(auth, HEX56, () => now);
    const second = await verifyRecoveryLink(auth, HEX56, () => now);
    t("reused link: first opens, second → invalid with no proof", first.ok && !second.ok && second.failure === "invalid");
  }
  {
    let n = 0;
    const auth: RecoveryAuth = {
      verifyOtp: async () => (++n === 1
        ? { data: { user: null, session: null }, error: apiErr(0, undefined, "AuthRetryableFetchError") }
        : { data: { user: { id: "user-a" }, session: { access_token: otpSession() } }, error: null }),
    };
    const a = await verifyRecoveryLink(auth, HEX56, () => now);
    const b = await verifyRecoveryLink(auth, HEX56, () => now);
    t("network failure then retry → second attempt succeeds", !a.ok && a.failure === "network" && b.ok);
  }
  {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const { auth, calls } = fakeAuth(async () => { await gate; return { data: { user: { id: "user-a" }, session: { access_token: otpSession() } }, error: null }; });
    const pending = verifyRecoveryLink(auth, HEX56, () => now);
    let settled = false;
    pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    t("slow verification stays pending (no timeout verdict)", !settled && calls.length === 1);
    resolve();
    t("slow verification then completes → proof", (await pending).ok);
  }
  t("refresh after success: token gone from URL, proof not persisted → noLink", initialRecoveryPhase(u(SITE), false) === "noLink");

  // ── 5. The page's lifecycle, run ──
  // A stand-in for the Supabase auth client, in auth-js 2.111's order:
  // verifyOtp saves the session and emits PASSWORD_RECOVERY before it
  // resolves; signing out removes the session and emits SIGNED_OUT; a save
  // emits USER_UPDATED. Any call can be held open to force an ordering.
  console.log("\nRecovery flow (executed, stand-in auth client)");
  type Sess = { access_token: string } | null;
  type VerifyAnswer = Awaited<ReturnType<RecoveryAuth["verifyOtp"]>>;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const hold = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { gate, release };
  };
  const sidOf = (sess: Sess) => {
    if (!sess) return "none";
    const claims = JSON.parse(Buffer.from(sess.access_token.split(".")[1], "base64").toString()) as { session_id?: string };
    return claims.session_id ?? "no-sid";
  };
  const okAnswer = (token = otpSession("user-a", "rec-sess"), id = "user-a"): VerifyAnswer => ({ data: { user: { id }, session: { access_token: token } }, error: null });
  const errAnswer = (e: unknown): VerifyAnswer => ({ data: { user: null, session: null }, error: e });

  function harness(o: { href?: string; session?: Sess; verify?: () => Promise<VerifyAnswer>; save?: () => { ok: boolean; error: string | null } } = {}) {
    let href = o.href ?? `${SITE}#token_hash=${PKCE_HASH}&type=recovery`;
    let session: Sess = o.session ?? null;
    let clock = now;
    const listeners = new Set<(event: string, sess: Sess) => void>();
    const log: string[] = [];
    const phases: string[] = [];
    const views: RecoveryView[] = [];
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const getSessionGates: Promise<void>[] = [];
    let verifyGate: Promise<void> | null = null;
    let saveGate: Promise<void> | null = null;
    const emit = (event: string) => [...listeners].forEach((l) => l(event, session));
    const auth: RecoveryFlowAuth = {
      verifyOtp: async (p) => {
        log.push(`verifyOtp:${p.type}`);
        if (verifyGate) await verifyGate;
        const r = o.verify ? await o.verify() : okAnswer();
        if (!r.error && r.data.session) {
          session = r.data.session;
          emit("PASSWORD_RECOVERY");
        }
        return r;
      },
      getSession: async () => {
        const gate = getSessionGates.shift();
        if (gate) await gate;
        return { data: { session } };
      },
      onAuthStateChange: (cb) => {
        listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => void listeners.delete(cb) } } };
      },
    };
    const flow = createRecoveryFlow(
      {
        auth,
        savePassword: async () => {
          log.push("save");
          if (saveGate) await saveGate;
          const r = o.save ? o.save() : { ok: true, error: null };
          if (r.ok) emit("USER_UPDATED");
          return r;
        },
        signOutLocal: async () => {
          log.push(`signOut:${sidOf(session)}`);
          session = null;
          emit("SIGNED_OUT");
        },
        location: {
          href: () => href,
          replace: (p) => {
            log.push(`replace:${p}`);
            href = `https://www.thewovenne.com${p}`;
          },
        },
        now: () => clock,
        setTimer: (fn, ms) => {
          const timer = { fn, ms, live: true };
          timers.push(timer);
          return timer;
        },
        clearTimer: (timer) => void ((timer as { live: boolean }).live = false),
      },
      (v) => {
        views.push(v);
        phases.push(v.phase);
      }
    );
    return {
      flow,
      log,
      phases,
      views,
      listeners,
      href: () => href,
      session: () => session,
      liveTimers: () => timers.filter((x) => x.live),
      setSession(next: Sess, event?: string) {
        session = next;
        if (event) emit(event);
      },
      advance: (ms: number) => void (clock += ms),
      fireTimers: () => timers.filter((x) => x.live).forEach((x) => { x.live = false; x.fn(); }),
      holdNextGetSession() { const h = hold(); getSessionGates.push(h.gate); return h.release; },
      holdVerify() { const h = hold(); verifyGate = h.gate; return () => { verifyGate = null; h.release(); }; },
      holdSave() { const h = hold(); saveGate = h.gate; return () => { saveGate = null; h.release(); }; },
      signOuts: () => log.filter((l) => l.startsWith("signOut")),
      verifies: () => log.filter((l) => l.startsWith("verifyOtp")).length,
      saves: () => log.filter((l) => l === "save").length,
    };
  }
  type H = ReturnType<typeof harness>;
  const PW = "a quiet morning walk";
  const toForm = async (h: H) => {
    const off = h.flow.mount();
    await tick();
    await h.flow.continueWithLink();
    return off;
  };
  const otherUser = () => ({ access_token: otpSession("user-b", "b-sess") });
  const WINDOW_MS = RECOVERY_WINDOW_SECONDS * 1000;

  {
    const h = harness();
    const off = h.flow.mount();
    t("new link: the address bar is cleaned during mount, before any session lookup", h.log[0] === "replace:/in/reset-password" && !h.href().includes("token_hash"));
    t("new link: Continue shows at once; nothing verified on mount", h.flow.view().phase === "confirm" && h.verifies() === 0);
    await tick();
    t("…nor after the start-up session lookup settles", h.verifies() === 0 && h.flow.view().phase === "confirm");
    off();
    t("leaving before Continue signs nobody out", (await tick(), h.signOuts().length === 0));
  }
  {
    const h = harness();
    h.flow.mount()();
    const off = h.flow.mount();
    await tick();
    t("Strict Mode (mount, unmount, mount): one live auth listener, the link survives the cleaned URL, nothing verified", h.listeners.size === 1 && h.verifies() === 0 && h.flow.view().phase === "confirm");
    await h.flow.continueWithLink();
    t("…Continue then verifies once and opens the form; the first unmount signed nobody out", h.verifies() === 1 && h.flow.view().phase === "form" && h.signOuts().length === 0);
    off();
  }
  {
    const h = harness();
    h.flow.mount();
    await tick();
    const from = h.phases.length;
    await h.flow.continueWithLink();
    const seq = h.phases.slice(from);
    t("Continue: verifying → form, form only once verification has finished (PASSWORD_RECOVERY mid-check opens nothing)", seq[0] === "verifying" && seq.indexOf("form") === seq.length - 1 && seq.filter((p) => p === "form").length === 1, seq.join(","));
    t("verifyOtp called with type recovery", h.log.includes("verifyOtp:recovery"));
    t("the 15-minute timer is set from the moment of verification", h.liveTimers().length === 1 && h.liveTimers()[0].ms === WINDOW_MS);
  }
  {
    const h = harness();
    h.flow.mount();
    await tick();
    const release = h.holdVerify();
    const first = h.flow.continueWithLink();
    const second = h.flow.continueWithLink();
    release();
    await Promise.all([first, second, h.flow.continueWithLink()]);
    t("double tap (and a third tap after): one verifyOtp, form opens", h.verifies() === 1 && h.flow.view().phase === "form");
  }
  {
    let n = 0;
    const h = harness({ verify: async () => (++n === 1 ? errAnswer(apiErr(0, undefined, "AuthRetryableFetchError")) : okAnswer()) });
    h.flow.mount();
    await tick();
    await h.flow.continueWithLink();
    t("network failure: back to Continue with a retry note, no form", h.flow.view().phase === "confirm" && h.flow.view().notice === VERIFY_FAILURE_COPY.network && !h.phases.includes("form"));
    await h.flow.continueWithLink();
    t("…retry succeeds: second verifyOtp opens the form, note cleared", h.verifies() === 2 && h.flow.view().phase === "form" && h.flow.view().notice === null);
  }
  {
    const h = harness({ verify: async () => errAnswer(apiErr(403, "otp_expired")) });
    h.flow.mount();
    await tick();
    await h.flow.continueWithLink();
    await h.flow.continueWithLink();
    t("refused link (used/expired/wrong): 'can't be used' screen; the token is dropped, so no second request", h.flow.view().phase === "invalid" && h.verifies() === 1);
  }
  {
    const answers: [string, () => Promise<VerifyAnswer>][] = [
      ["refused 403", async () => errAnswer(apiErr(403, "otp_expired"))],
      ["network", async () => errAnswer(apiErr(0, undefined, "AuthRetryableFetchError"))],
      ["server 500", async () => errAnswer(apiErr(500))],
      ["rate limit", async () => errAnswer(apiErr(429, "over_request_rate_limit"))],
      ["unrecognised", async () => errAnswer(apiErr(418))],
      ["fetch throws", async () => { throw new TypeError("Failed to fetch"); }],
      ["success without a session", async () => ({ data: { user: { id: "user-a" }, session: null }, error: null })],
    ];
    const signedIn = { access_token: jwt({ sub: "user-c", session_id: "c-sess", amr: [{ method: "password", timestamp: s }] }) };
    let ok = true;
    for (const [name, verify] of answers) {
      const h = harness({ verify, session: signedIn });
      h.flow.mount();
      await tick();
      await h.flow.continueWithLink();
      if (h.phases.includes("form") || h.signOuts().length || h.session() !== signedIn) {
        ok = false;
        console.log(`    (${name}: ${h.phases.join(",")} ${h.signOuts().join(",")})`);
      }
    }
    t("every failed or incomplete verification: never the form, and the browser's existing sign-in is left alone", ok);
  }
  {
    // Supabase saved a session, but it is for another user than it reported.
    const h = harness({ verify: async () => okAnswer(otpSession("user-a", "stray"), "user-b") });
    h.flow.mount();
    await tick();
    await h.flow.continueWithLink();
    t("partial verification (session saved, no proof possible): 'can't be used', that session signed out here", h.flow.view().phase === "invalid" && !h.phases.includes("form") && h.signOuts().join() === "signOut:stray");
  }
  {
    const h = harness();
    const releaseStartup = h.holdNextGetSession();
    h.flow.mount();
    await h.flow.continueWithLink();
    t("start-up lookup still pending: Continue works and the form opens", h.flow.view().phase === "form");
    releaseStartup();
    await tick();
    t("…the late start-up answer does not change the screen", h.flow.view().phase === "form" && h.flow.view().signedIn);
  }
  {
    const h = harness();
    h.flow.mount();
    await tick();
    const release = h.holdVerify();
    const pending = h.flow.continueWithLink();
    h.setSession(otherUser(), "SIGNED_IN");
    t("another tab signs in mid-check: nothing opens or closes yet", h.flow.view().phase === "verifying");
    release();
    await pending;
    t("…the verified session then replaces it (as auth-js does) and the form is bound to the link's user", h.flow.view().phase === "form" && sidOf(h.session()) === "rec-sess");
  }
  {
    const h = harness();
    h.flow.mount();
    await tick();
    const releaseLookup = h.holdNextGetSession();
    const pending = h.flow.continueWithLink();
    await tick();
    h.setSession(otherUser(), "SIGNED_IN");
    releaseLookup();
    await pending;
    t("another account signs in between verification and the form: closed, never opened", h.flow.view().phase === "closed" && !h.phases.includes("form"));
    t("…and that other account is NOT signed out", h.signOuts().length === 0 && sidOf(h.session()) === "b-sess");
  }
  {
    const h = harness();
    await toForm(h);
    h.setSession({ access_token: jwt({ sub: "user-a", session_id: "rec-sess", amr: [{ method: "otp", timestamp: s }], iat: s + 300 }) }, "TOKEN_REFRESHED");
    t("token refresh of the same session (same session_id): form stays", h.flow.view().phase === "form");
    await h.flow.save(PW);
    t("…and the save goes through", h.flow.view().phase === "saved" && h.saves() === 1);
  }
  {
    const noSidToken = jwt({ sub: "user-a", amr: [{ method: "otp", timestamp: s }] });
    const h = harness({ verify: async () => okAnswer(noSidToken) });
    await toForm(h);
    h.setSession({ access_token: jwt({ sub: "user-a", amr: [{ method: "otp", timestamp: s }], iat: s + 300 }) }, "TOKEN_REFRESHED");
    t("no session_id claim: a refresh closes the form (fails safe), and the refreshed session is NOT recognised, so it stays signed in", h.flow.view().phase === "closed" && h.signOuts().length === 0);
  }
  {
    const h = harness();
    await toForm(h);
    h.setSession(otherUser(), "SIGNED_IN");
    t("another account signs in while the form is open: closed", h.flow.view().phase === "closed");
    t("…that account is not signed out", h.signOuts().length === 0 && sidOf(h.session()) === "b-sess");
    h.setSession(otherUser(), "TOKEN_REFRESHED");
    await h.flow.continueWithLink();
    await h.flow.save(PW);
    t("…later events, Continue or Save cannot reopen it or verify again", h.flow.view().phase === "closed" && h.verifies() === 1 && h.saves() === 0);
  }
  {
    const h = harness();
    await toForm(h);
    h.setSession({ access_token: otpSession("user-a", "new-sess") }, "SIGNED_IN");
    t("same customer signs in again elsewhere in this browser (new session): closed, the new session kept", h.flow.view().phase === "closed" && h.signOuts().length === 0);
  }
  {
    const h = harness();
    await toForm(h);
    h.setSession(null, "SIGNED_OUT");
    await tick();
    t("signed out in another tab: closed, no further sign-out attempted", h.flow.view().phase === "closed" && h.signOuts().length === 0);
  }
  {
    const h = harness();
    await toForm(h);
    h.advance(WINDOW_MS);
    h.fireTimers();
    await tick();
    t("15 minutes pass with the form open: closed, and the link's session signed out (local)", h.flow.view().phase === "closed" && h.signOuts().join() === "signOut:rec-sess" && h.session() === null);
    await h.flow.continueWithLink();
    t("…the cleanup's own SIGNED_OUT reopens nothing and verifies nothing", h.flow.view().phase === "closed" && h.verifies() === 1);
  }
  {
    const h = harness();
    await toForm(h);
    h.setSession(otherUser());
    h.advance(WINDOW_MS);
    h.fireTimers();
    await tick();
    t("15 minutes pass but another account now holds the browser (no event seen): closed, that account kept", h.flow.view().phase === "closed" && h.signOuts().length === 0 && sidOf(h.session()) === "b-sess");
  }
  {
    const h = harness();
    await toForm(h);
    h.advance(WINDOW_MS + 60_000);
    await h.flow.save(PW);
    await tick();
    t("save after 16 minutes (tab was asleep, timer never fired): not saved, closed, link's session signed out", h.saves() === 0 && h.flow.view().phase === "closed" && h.signOuts().join() === "signOut:rec-sess");
  }
  {
    const h = harness();
    const off = await toForm(h);
    off();
    await tick();
    t("leaving the page with the form open: the link's session is signed out (local), once", h.signOuts().join() === "signOut:rec-sess" && h.listeners.size === 0 && h.liveTimers().length === 0);
  }
  {
    const h = harness();
    const off = await toForm(h);
    h.setSession(otherUser());
    off();
    await tick();
    t("leaving the page after another account took over: nobody signed out", h.signOuts().length === 0);
  }
  {
    const h = harness();
    const off = h.flow.mount();
    await tick();
    const release = h.holdVerify();
    const pending = h.flow.continueWithLink();
    off();
    release();
    await pending;
    await tick();
    t("leaving the page mid-check: when the check completes its session is signed out, the form never opens", h.signOuts().join() === "signOut:rec-sess" && !h.phases.includes("form"));
  }
  {
    const h = harness();
    const off = await toForm(h);
    const release = h.holdSave();
    const pending = h.flow.save(PW);
    await tick();
    off();
    release();
    await pending;
    t("leaving the page mid-save: the save finishes and signs out once (no double sign-out)", h.signOuts().join() === "signOut:rec-sess" && h.flow.view().phase === "saved");
  }
  {
    const h = harness();
    await toForm(h);
    const from = h.phases.length;
    await h.flow.save(PW);
    const seq = h.phases.slice(from);
    t("successful save: its own SIGNED_OUT never flashes 'closed'; ends on 'saved'", !seq.includes("closed") && seq[seq.length - 1] === "saved", seq.join(","));
    t("…order: save, then sign-out of the link's session (local), then 'saved'", h.log.slice(-2).join() === "save,signOut:rec-sess" && !h.flow.view().saving && h.liveTimers().length === 0);
  }
  {
    let n = 0;
    const h = harness({ save: () => (++n === 1 ? { ok: false, error: "That's the password you already have. Please choose a different one." } : { ok: true, error: null }) });
    await toForm(h);
    await h.flow.save(PW);
    t("refused save: form stays with Supabase's reason, nobody signed out", h.flow.view().phase === "form" && /already have/.test(h.flow.view().saveError ?? "") && h.signOuts().length === 0 && !h.flow.view().saving);
    await h.flow.save(PW + "!");
    t("…a corrected retry saves", h.flow.view().phase === "saved" && h.flow.view().saveError === null);
  }
  {
    const h = harness({ save: () => ({ ok: false, error: "Something went wrong." }) });
    await toForm(h);
    const release = h.holdSave();
    const pending = h.flow.save(PW);
    await tick();
    h.setSession(otherUser(), "SIGNED_IN");
    release();
    await pending;
    t("refused save while another account signed in meanwhile: the real outcome shows (closed), that account kept", h.flow.view().phase === "closed" && h.signOuts().length === 0);
  }
  {
    const h = harness();
    await toForm(h);
    h.setSession(otherUser());
    await h.flow.save(PW);
    t("account swapped silently before Save: nothing saved, closed, other account kept", h.saves() === 0 && h.flow.view().phase === "closed" && h.signOuts().length === 0);
  }
  {
    const h = harness();
    await toForm(h);
    const release = h.holdSave();
    const a = h.flow.save(PW);
    const b = h.flow.save(PW);
    release();
    await Promise.all([a, b]);
    t("double Save: one password update", h.saves() === 1 && h.flow.view().phase === "saved");
  }
  {
    const signup = { access_token: otpSession("user-a", "signup-sess") };
    const h = harness({ href: SITE, session: signup });
    h.flow.mount();
    await tick();
    await h.flow.continueWithLink();
    await h.flow.save(PW);
    t("signed in by a signup code (amr otp), no link: 'open the link from your email'; nothing verified, saved or signed out", h.flow.view().phase === "noLink" && h.verifies() === 0 && h.saves() === 0 && h.signOuts().length === 0);
  }
  {
    const h = harness({ href: SITE, session: { access_token: jwt({ sub: "user-a", session_id: "p", amr: [{ method: "password", timestamp: s }] }) } });
    h.flow.mount();
    await tick();
    await h.flow.save(PW);
    t("ordinary password sign-in, no link: no form, no save", h.flow.view().phase === "noLink" && h.saves() === 0);
  }
  {
    const old = { access_token: jwt({ sub: "user-a", session_id: "old-sess", amr: [{ method: "recovery", timestamp: s - 600 }] }) };
    const h = harness({ href: `${SITE}?code=abc`, session: old });
    h.flow.mount();
    t("old link: ?code= left in place until the client has used it", !h.log.some((l) => l.startsWith("replace")));
    await tick();
    t("old link, same browser: form opens; ?code= then cleaned", h.flow.view().phase === "form" && h.log.includes("replace:/in/reset-password"));
    t("…its timer runs from when the link was used (5 of 15 minutes left)", h.liveTimers()[0]?.ms === 5 * 60_000);
    h.advance(5 * 60_000);
    h.fireTimers();
    await tick();
    t("…and when it runs out, that old-link session is signed out too", h.flow.view().phase === "closed" && h.signOuts().join() === "signOut:old-sess");
  }
  {
    const h = harness({ href: `${SITE}?code=abc` });
    h.flow.mount();
    await tick();
    t("old link on another device: 'open it where you asked', code cleaned, nothing signed out", h.flow.view().phase === "otherBrowser" && h.log.includes("replace:/in/reset-password") && h.signOuts().length === 0);
  }

  console.log("\nproof helpers");
  t("proofFromRecoverySession: only an amr `recovery` session, dated from its use", proofFromRecoverySession(jwt({ sub: "u", session_id: "x", amr: [{ method: "recovery", timestamp: s - 30 }] }))?.verifiedAtMs === (s - 30) * 1000 && proofFromRecoverySession(otpSession()) === null && proofFromRecoverySession(null) === null);
  const pr = proofFromVerifiedSession(otpSession(), "user-a", now);
  t("sessionMatchesProof ignores age but not identity", sessionMatchesProof(otpSession(), pr) && !sessionMatchesProof(otpSession("user-b"), pr) && !sessionMatchesProof(otpSession("user-a", "sess-2"), pr) && !sessionMatchesProof(null, pr) && !sessionMatchesProof(otpSession(), null));

  // ── 6. The page's wiring and copy (SOURCE checks; no DOM in this suite) ──
  console.log("\nReset page — source checks, not runtime");
  const rp = code(read("components/account/ResetPasswordForm.tsx"));
  const fl = code(read("lib/passwordRecoveryFlow.ts"));
  const ResetPasswordForm = (await import("../components/account/ResetPasswordForm")).default;
  const html = renderToStaticMarkup(createElement(ResetPasswordForm));
  t("first render (server and hydration) only says 'Checking your link…' (rendered)", /Checking your link/.test(html) && !/type="password"/.test(html) && !/expired/i.test(html));
  t("the component never verifies; Continue is the only caller of continueWithLink", !/verifyOtp|verifyRecoveryLink/.test(rp) && (rp.match(/continueWithLink/g) ?? []).length === 1 && /onClick=\{\(\) => void flowRef\.current\?\.continueWithLink\(\)\}/.test(rp));
  t("the flow verifies in exactly one place, continueWithLink", (fl.match(/verifyRecoveryLink\(/g) ?? []).length === 1 && /async function continueWithLink\(\)[\s\S]*?await verifyRecoveryLink\(deps\.auth, tokenHash, now\)/.test(fl));
  t("the component wires save to setNewPassword and sign-out to logOut (scope local)", /savePassword: setNewPassword/.test(rp) && /signOutLocal: logOut/.test(rp) && /resetForSignOut\(\)[\s\S]*signOut\(\{ scope: "local" \}\)/.test(code(read("lib/customerAuth.ts"))));
  t("the password rule is checked before the flow's save", /passwordProblem\(password, confirm\)[\s\S]*?if \(found\) return;\s*await flowRef\.current\?\.save\(password\)/.test(rp));
  t("the flow is made once and mounted from one effect (Strict Mode safe)", /flowRef\.current \?\?= createRecoveryFlow\(/.test(rp) && /return flowRef\.current\.mount\(\);/.test(rp));
  t("no analytics, console, storage or direct hash/search reads in the page or the flow", ![rp, fl].some((src) => /analytics|track\(|console\.|localStorage|sessionStorage|document\.cookie|location\.(search|hash)/.test(src)));
  t("no service role, admin API, custom endpoint or staff path", ![rp, fl].some((src) => /service_role|SERVICE_ROLE|createServiceClient|auth\.admin|fetch\(|is_staff|is_admin/.test(src)));
  t("copy: no 'logged in straight away'; the form says it signs out after saving", !/logged in straight away/i.test(rp) && /Once it's saved, we'll sign you out/.test(rp));
  t("copy: the save button says what it does", /"Save new password"/.test(rp) && !/Save and continue/.test(rp));
  t("copy: switching account is described as a switch, not a sign-out of the other account", /this browser will switch to the account this link was sent to/.test(rp) && !/signs that account out/.test(rp));
  t("the 2.5-second 'expired' timer is gone; a slow check only gets a note", !/2500|setTimeout\(\(\) => setReady/.test(rp) && /SLOW_MS = 10_000/.test(rp) && /taking longer than usual/.test(rp));
  t("no screen claims a definite expiry", !/That link has expired/.test(rp) && /may have expired, already been used/.test(rp));
  t("old link on another device gets its own honest screen", /Open this link where you asked for it/.test(rp));
  t("every dead end offers a fresh link", (rp.match(/footer=\{newLink\}/g) ?? []).length >= 4 && /href="\/in\/forgot-password"/.test(rp));
  t("signed-in browser note shows no email", !/user\.email|session\.user/.test(rp));

  const lib = code(read("lib/passwordRecovery.ts"));
  t("lib: verifyOtp called with token_hash + type 'recovery' only", /auth\.verifyOtp\(\{ token_hash: tokenHash, type: "recovery" \}\)/.test(lib) && (lib.match(/verifyOtp\(/g) ?? []).length === 2);
  t("lib + flow: no logging, storage, network or Supabase import of their own", ![lib, fl].some((src) => /console\.|localStorage|sessionStorage|document\.cookie|fetch\(|from "\.\/supabase"|@supabase/.test(src)));
  t("lib + flow: a bare `otp` amr is never accepted as recovery", ![lib, fl].some((src) => /method === "otp"|"otp"\s*\]|includes\("otp"\)/.test(src)));
  const sim = code(read("lib/signInMethods.ts"));
  t("recoverySessionOpen still demands method 'recovery' with a timestamp", /method === "recovery" &&\s*typeof timestamp === "number"/.test(sim));

  // Customer/staff and the other flows: unchanged.
  const ca = code(read("lib/customerAuth.ts"));
  t("password login still ends a staff session with the wrong-password message", /rpc\("is_staff"\)[\s\S]*signOut\(\{ scope: "local" \}\)[\s\S]*Incorrect email or password/.test(ca));
  t("signup code is still verifyOtp type 'signup' (separate from recovery)", /verifyOtp\(\{\s*email: email\.trim\(\)\.toLowerCase\(\),\s*token: token\.trim\(\),\s*type: "signup",\s*\}\)/.test(ca));
  t("reset request still resetPasswordForEmail with the /in redirect (old link keeps working)", /resetPasswordForEmail\(\s*email\.trim\(\)\.toLowerCase\(\),[\s\S]*?redirectTo: `\$\{window\.location\.origin\}\$\{cPath\("\/reset-password"\)\}`/.test(ca));
  t("Google callback untouched: still exchangeCodeForSession + staff check", /exchangeCodeForSession\(code\)/.test(read("app/api/auth/callback/route.ts")) && /rpc\("is_staff"\)/.test(read("app/api/auth/callback/route.ts")));
  t("forgot-password copy still identical for any address (no enumeration)", /If there&apos;s an account for \{email\}/.test(read("components/account/ForgotPasswordForm.tsx")));
  t("reset page stays noindex", /robots: \{ index: false, follow: false \}/.test(read("app/(storefront)/in/reset-password/page.tsx")));

  // ── 7. Redaction ──
  console.log("\nRedaction");
  const crumb = `/in/reset-password#token_hash=${PKCE_HASH}&type=recovery`;
  t("token_hash masked in a fragment", redactAuthSecrets(crumb) === "/in/reset-password#token_hash=[redacted]&type=recovery" && !redactAuthSecrets(crumb).includes(HEX56));
  t("code masked in a query", redactAuthSecrets(`${SITE}?code=abc-123&x=1`) === `${SITE}?code=[redacted]&x=1`);
  t("access/refresh tokens masked", !/secret/.test(redactAuthSecrets("/#access_token=secret1&refresh_token=secret2")));
  t("promo_code and unrelated params untouched", redactAuthSecrets("/in/checkout?promo_code=SAVE10&q=code") === "/in/checkout?promo_code=SAVE10&q=code");
  // Executed: the functions Sentry's hooks call.
  const tokenUrl = `${SITE}#token_hash=${PKCE_HASH}&type=recovery`;
  const leaks = (x: unknown) => JSON.stringify(x).includes(HEX56);
  const nav = redactBreadcrumb({ category: "navigation", data: { from: crumb, to: "/in/reset-password" } });
  t("navigation breadcrumb: from/to masked, path kept", !leaks(nav) && nav.data?.to === "/in/reset-password" && nav.category === "navigation");
  const consoleCrumb = redactBreadcrumb({ category: "console", message: `opened ${tokenUrl}`, data: { logger: "console", arguments: ["opened", tokenUrl, { href: tokenUrl }, 42] } });
  t("console breadcrumb: the message AND the logged arguments (array, nested object) masked", !leaks(consoleCrumb) && (consoleCrumb.data?.arguments as unknown[])[3] === 42 && (consoleCrumb.data?.arguments as unknown[])[0] === "opened");
  const fetchCrumb = redactBreadcrumb({ category: "fetch", data: { method: "POST", url: "https://x.supabase.co/auth/v1/verify", status_code: 403 } });
  t("fetch breadcrumb untouched when it holds nothing secret", fetchCrumb.data?.url === "https://x.supabase.co/auth/v1/verify" && fetchCrumb.data?.status_code === 403);
  const ev = redactEvent({
    message: `failed at ${tokenUrl}`,
    exception: { values: [{ type: "Error", value: `bad ${tokenUrl}` }, { type: "TypeError" }] },
    request: { url: tokenUrl, query_string: "code=abc&x=1", headers: { Referer: `${SITE}?code=abc` } },
  });
  t("event: message, exception text, page URL, query and headers masked", !leaks(ev) && ev.request?.query_string === "code=[redacted]&x=1" && !/code=abc/.test(JSON.stringify(ev)));
  t("event: error types and non-secret text kept", ev.exception?.values?.[0].type === "Error" && /^bad /.test(ev.exception?.values?.[0].value ?? "") && ev.exception?.values?.[1].value === undefined);
  class Custom { constructor(public href: string) {} }
  const inst = new Custom(tokenUrl);
  t("deep masking leaves class instances alone (no mangled diagnostics) and stops at a depth limit", redactAuthSecretsDeep(inst) === inst && redactAuthSecretsDeep({ a: { b: { c: { d: { e: tokenUrl } } } } }).a.b.c.d.e === tokenUrl && !leaks(redactAuthSecretsDeep({ a: { b: tokenUrl } })));
  const sentry = code(read("sentry.client.config.ts"));
  t("Sentry browser config uses both (source check)", /beforeBreadcrumb: \(breadcrumb\) => redactBreadcrumb\(breadcrumb\)/.test(sentry) && /beforeSend: \(event\) => redactEvent\(event\)/.test(sentry));
  t("analytics still records the path only (never query or fragment)", /A path, never a URL: no origin, no query string, no fragment/.test(read("lib/analyticsCollect.ts")) && /path: window\.location\.pathname/.test(read("lib/analyticsClient.ts")));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
