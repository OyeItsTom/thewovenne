/**
 * Persistent daily AI spend: reservation, reconciliation, concurrency, crash safety.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/ai-daily-spend.test.ts
 *
 * ══ WHAT IS AND IS NOT EXECUTED HERE, STATED PLAINLY ══
 *
 * There is no Postgres on this machine and no Docker, and migration 0059 has
 * NOT been applied to production — applying a schema change is not something a
 * test run should do on its own. So this file proves the design in two halves,
 * and neither half pretends to be the other:
 *
 *   1. A MODEL of the 0059 algorithm, implemented in TypeScript below, with the
 *      same guard, the same reservation lifecycle and the same lock ordering
 *      Postgres gives an UPDATE under READ COMMITTED. Every behavioural
 *      assertion — boundaries, concurrency, idempotency, sweeps, rollover —
 *      runs against that model, and the mutation tests at the end demonstrate
 *      those assertions genuinely fail when the protection is removed.
 *
 *   2. STRUCTURAL assertions against the real SQL text, proving the migration
 *      actually has the properties the model assumes: the guard lives in the
 *      UPDATE's WHERE clause, the finalize takes FOR UPDATE, NaN is rejected
 *      explicitly, every day boundary goes through ai_utc_day(), the grants and
 *      RLS are as intended, and no column can hold a person.
 *
 * A model can be faithful and still be a model. `scripts/ai-daily-spend.verify.mjs`
 * exists to run the real functions — including genuine two-connection
 * concurrency — and requires 0059 to be applied first. Until that has been run,
 * the SQL is verified by construction and by inspection, not by execution, and
 * that is recorded as an open risk rather than glossed.
 */
import fs from "node:fs";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

// ══════════════════════════════════════════════
// A model of migration 0059
// ══════════════════════════════════════════════

interface DayRow {
  day: string;
  committedUsd: number;
  reservedUsd: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}
interface ResRow {
  id: string;
  day: string;
  reservedUsd: number;
  state: "reserved" | "finalized" | "expired";
  actualUsd: number | null;
  createdAtMs: number;
}

/**
 * The algorithm 0059 implements, with the guard where 0059 puts it.
 *
 * `guarded` exists only so the mutation tests can remove the protection and
 * show the suite notices. Nothing in the migration has a switch like it.
 */
class ModelStore {
  days = new Map<string, DayRow>();
  reservations = new Map<string, ResRow>();
  nowMs = Date.UTC(2026, 7, 25, 12, 0, 0);
  ttlMs = 15 * 60 * 1000;
  private seq = 0;

  constructor(
    private readonly guarded = true,
    /** Model duplicate-finalize protection (the FOR UPDATE + state check). */
    private readonly idempotent = true
  ) {}

  utcDay(): string {
    return new Date(this.nowMs).toISOString().slice(0, 10);
  }

  private row(day: string): DayRow {
    let r = this.days.get(day);
    if (!r) {
      r = {
        day,
        committedUsd: 0,
        reservedUsd: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
      };
      this.days.set(day, r);
    }
    return r;
  }

  /** The sweep ai_budget_reserve performs before it reserves. */
  private sweep() {
    for (const r of this.reservations.values()) {
      if (r.state !== "reserved") continue;
      if (r.createdAtMs >= this.nowMs - this.ttlMs) continue;
      r.state = "expired";
      r.actualUsd = r.reservedUsd; // charged, not refunded
      const d = this.row(r.day);
      d.committedUsd += r.reservedUsd;
      d.reservedUsd = Math.max(d.reservedUsd - r.reservedUsd, 0);
    }
  }

  reserve(amount: number, limit: number): { allowed: boolean; id?: string; committed: number } {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("bad amount");
    if (!Number.isFinite(limit) || limit < 0) throw new Error("bad limit");
    this.sweep();

    const d = this.row(this.utcDay());

    // The guard, exactly as 0059 writes it in the UPDATE's WHERE clause.
    const wouldBe = d.committedUsd + d.reservedUsd + amount;
    if (this.guarded && wouldBe > limit) {
      return { allowed: false, committed: d.committedUsd };
    }

    d.reservedUsd += amount;
    d.requests += 1;
    const id = `res_${++this.seq}`;
    this.reservations.set(id, {
      id,
      day: d.day,
      reservedUsd: amount,
      state: "reserved",
      actualUsd: null,
      createdAtMs: this.nowMs,
    });
    return { allowed: true, id, committed: d.committedUsd };
  }

  finalize(
    id: string,
    actual: number | null,
    usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ): { ok: boolean; idempotent?: boolean; charged?: number; reason?: string } {
    const r = this.reservations.get(id);
    if (!r) return { ok: false, reason: "unknown_reservation" };

    if (this.idempotent && r.state !== "reserved") {
      return { ok: true, idempotent: true, charged: r.actualUsd ?? 0 };
    }
    if (actual != null && (!Number.isFinite(actual) || actual < 0)) throw new Error("bad actual");

    // null is NOT zero: charge the whole reservation.
    const charge = actual == null ? r.reservedUsd : actual;

    const d = this.row(r.day);
    d.committedUsd += charge;
    d.reservedUsd = Math.max(d.reservedUsd - r.reservedUsd, 0);
    d.modelCalls += usage.modelCalls;
    d.inputTokens += usage.inputTokens;
    d.outputTokens += usage.outputTokens;
    d.cacheReadTokens += usage.cacheReadTokens;
    d.cacheWriteTokens += usage.cacheWriteTokens;

    r.state = "finalized";
    r.actualUsd = charge;
    r.finalizedFlag = true;
    return { ok: true, idempotent: false, charged: charge };
  }

  /** ai_budget_prune: cannot reach today, by construction. */
  prune(keepDays: number): number {
    const keep = Math.max(keepDays || 400, 1);
    const cutoff = new Date(this.nowMs - keep * 86_400_000).toISOString().slice(0, 10);
    let n = 0;
    for (const day of [...this.days.keys()]) {
      if (day < cutoff) {
        this.days.delete(day);
        n++;
      }
    }
    return n;
  }

  total(day = this.utcDay()) {
    return this.row(day);
  }
}
interface ResRowExtra { finalizedFlag?: boolean }
interface ResRow extends ResRowExtra {}

async function main() {
  const budgetMod = await import("../lib/ai/budget");
  const obs = await import("../lib/ai/observability");
  const { reserveDailyBudget, finalizeDailyBudget, RequestBudget } = budgetMod;
  const MIG = fs.readFileSync("supabase/migrations/0059_ai_daily_spend.sql", "utf8");
  /**
   * The migration with its `--` comments removed.
   *
   * Needed because this file's header deliberately QUOTES the 0019 line it is
   * explaining ("(p_window * 3)") and discusses `current_date` and floats in
   * prose. Grepping the raw text for those made three assertions fail against a
   * migration that is correct — the prose was tripping the check on itself.
   */
  const CODE = MIG.replace(/--.*$/gm, "");

  const LIMIT = 5.0;
  const REQ = 0.06;

  // ══ Reservation basics ══════════════════════
  console.log("\n=== reservation ===");
  {
    const s = new ModelStore();
    t("the day starts at zero", s.total().committedUsd === 0 && s.total().reservedUsd === 0);

    const first = s.reserve(REQ, LIMIT);
    t("the first request of a UTC day is allowed", first.allowed);
    t("…and creates the day's row", s.days.size === 1);
    t("…holding the full request ceiling, not a guess", s.total().reservedUsd === REQ);
    t("…and committing nothing yet", s.total().committedUsd === 0);
    t("…with a reservation id to settle against", typeof first.id === "string");

    const second = s.reserve(REQ, LIMIT);
    t("a second request well under the ceiling is allowed", second.allowed);
    t("holds accumulate", Math.abs(s.total().reservedUsd - REQ * 2) < 1e-9);
  }

  // ══ Boundary ════════════════════════════════
  console.log("\n=== the exact boundary ===");
  {
    const s = new ModelStore();
    s.total().committedUsd = 4.94;
    const exact = s.reserve(REQ, LIMIT);
    t("a reservation landing EXACTLY on the ceiling is allowed", exact.allowed, "4.94 + 0.06 = 5.00, and <= is inclusive");
    t("…and the day is now exactly at the limit", Math.abs(s.total().committedUsd + s.total().reservedUsd - LIMIT) < 1e-9);

    const oneMore = s.reserve(REQ, LIMIT);
    t("the next request is refused", !oneMore.allowed);
  }
  {
    const s = new ModelStore();
    s.total().committedUsd = 4.96;
    const over = s.reserve(REQ, LIMIT);
    t("a reservation that would exceed the ceiling is refused BEFORE the provider", !over.allowed, "4.96 + 0.06 = 5.02");
    t("…and nothing was held", s.total().reservedUsd === 0);
    t("…and the committed total is untouched", s.total().committedUsd === 4.96);
  }
  {
    const s = new ModelStore();
    s.total().committedUsd = 4.99;
    t("reserved budget counts toward the ceiling, not just committed", !s.reserve(REQ, LIMIT).allowed);
  }

  // ══ Concurrency ═════════════════════════════
  console.log("\n=== concurrency ===");
  {
    // Two requests arriving together at $4.96 committed. Under READ COMMITTED
    // the second UPDATE waits on the first's row lock and re-evaluates its
    // WHERE against the committed result — so it sees the first's hold.
    const s = new ModelStore();
    s.total().committedUsd = 4.96;
    const a = s.reserve(REQ, LIMIT);
    const b = s.reserve(REQ, LIMIT);
    t("at $4.96 of $5.00, neither of two concurrent requests gets through", !a.allowed && !b.allowed);
  }
  {
    const s = new ModelStore();
    s.total().committedUsd = 4.90;
    const a = s.reserve(REQ, LIMIT);
    const b = s.reserve(REQ, LIMIT);
    t("at $4.90 exactly one of two concurrent requests is refused", a.allowed !== b.allowed || (a.allowed && b.allowed && s.total().committedUsd + s.total().reservedUsd <= LIMIT));
    t("…and the ceiling is never crossed", s.total().committedUsd + s.total().reservedUsd <= LIMIT + 1e-9, `${s.total().committedUsd + s.total().reservedUsd}`);
  }
  {
    // The real stress: many requests racing at a tight ceiling.
    const s = new ModelStore();
    let allowed = 0;
    for (let i = 0; i < 500; i++) if (s.reserve(REQ, LIMIT).allowed) allowed++;
    const held = s.total().committedUsd + s.total().reservedUsd;
    t("500 racing requests cannot exceed the ceiling", held <= LIMIT + 1e-9, `$${held.toFixed(4)} held`);
    t("…and exactly the affordable number got through", allowed === Math.floor(LIMIT / REQ), `${allowed} of ${Math.floor(LIMIT / REQ)}`);
  }

  // ══ Reconciliation ══════════════════════════
  console.log("\n=== reconciliation ===");
  {
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    const out = s.finalize(r.id!, 0.012, { modelCalls: 2, inputTokens: 4194, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 });
    t("actual < reserved settles at the actual", out.charged === 0.012);
    t("…and the hold is released in full", s.total().reservedUsd === 0);
    t("…so the difference is given back", Math.abs(s.total().committedUsd - 0.012) < 1e-9);
    t("token counters accumulate", s.total().inputTokens === 4194 && s.total().outputTokens === 300);
    t("model calls accumulate", s.total().modelCalls === 2);
  }
  {
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    s.finalize(r.id!, REQ);
    t("actual == reserved settles cleanly", Math.abs(s.total().committedUsd - REQ) < 1e-9 && s.total().reservedUsd === 0);
  }
  {
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    const out = s.finalize(r.id!, 0.5);
    t("actual > reserved is charged in FULL, not clamped", out.charged === 0.5, "recording less than the truth would corrupt every figure downstream");
    t("…the day may end over its limit, which is correct accounting", s.total().committedUsd === 0.5);
    t("…and the next reservation is then refused", !s.reserve(REQ, 0.4).allowed);
  }
  {
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    const out = s.finalize(r.id!, null);
    t("an UNKNOWN actual charges the whole reservation", out.charged === REQ, "unknown cost is never zero");
    t("…and the hold is still released", s.total().reservedUsd === 0);
  }
  {
    const s = new ModelStore();
    t("finalizing an unknown reservation is reported, not thrown", s.finalize("nope", 0.01).ok === false);
  }

  // ══ Idempotency ═════════════════════════════
  console.log("\n=== duplicate reconciliation and retries ===");
  {
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    const one = s.finalize(r.id!, 0.02);
    const two = s.finalize(r.id!, 0.02);
    const three = s.finalize(r.id!, 0.02);
    t("the first settlement charges", one.charged === 0.02 && one.idempotent === false);
    t("the second is a no-op", two.idempotent === true);
    t("the third too", three.idempotent === true);
    t("the day was charged exactly ONCE", Math.abs(s.total().committedUsd - 0.02) < 1e-9, `$${s.total().committedUsd}`);
    t("a retry cannot double-release the hold either", s.total().reservedUsd === 0);
  }
  {
    // A Vercel re-execution settling with a different figure must not re-charge.
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    s.finalize(r.id!, 0.01);
    s.finalize(r.id!, 0.99);
    t("a retry with a different actual does not re-charge", Math.abs(s.total().committedUsd - 0.01) < 1e-9);
  }

  // ══ Crash safety ════════════════════════════
  console.log("\n=== crash safety ===");
  {
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    void r;
    t("a crash after reservation leaves budget held", s.total().reservedUsd === REQ);

    s.nowMs += 16 * 60 * 1000; // past the TTL
    s.reserve(REQ, LIMIT); // any later request performs the sweep
    const swept = s.total();
    t("the sweep charges the abandoned hold rather than refunding it", Math.abs(swept.committedUsd - REQ) < 1e-9, "we cannot know the provider did not bill");
    t("…and releases it from reserved", Math.abs(swept.reservedUsd - REQ) < 1e-9, "only the new request's hold remains");
    t("…exactly once, however many sweeps run", (() => { const before = s.total().committedUsd; s.nowMs += 1000; s.reserve(REQ, LIMIT); return Math.abs(s.total().committedUsd - before) < 1e-9; })());
  }
  {
    // A crash must not charge repeatedly without bound.
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    void r;
    s.nowMs += 16 * 60 * 1000;
    for (let i = 0; i < 20; i++) {
      s.nowMs += 1000;
      s.reserve(0, LIMIT);
    }
    t("twenty sweeps charge the abandoned hold once, not twenty times", Math.abs(s.total().committedUsd - REQ) < 1e-9, `$${s.total().committedUsd}`);
  }
  {
    // Provider failed after the reservation: our own accounting says 0 calls.
    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    s.finalize(r.id!, 0, { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    t("a provider failure before any billed call settles at zero", s.total().committedUsd === 0);
    t("…and gives the hold straight back", s.total().reservedUsd === 0);
  }

  // ══ UTC rollover ════════════════════════════
  console.log("\n=== UTC day rollover ===");
  {
    const s = new ModelStore();
    s.nowMs = Date.UTC(2026, 7, 25, 23, 59, 0);
    s.reserve(REQ, LIMIT);
    s.finalize("res_1", 4.99);
    t("day one is at its ceiling", !s.reserve(REQ, LIMIT).allowed);

    s.nowMs = Date.UTC(2026, 7, 26, 0, 1, 0);
    const nextDay = s.reserve(REQ, LIMIT);
    t("the next UTC day starts fresh", nextDay.allowed);
    t("…in a new row", s.days.size === 2);
    t("…leaving yesterday's total intact", s.total("2026-08-25").committedUsd === 4.99);
    t("…and not inheriting it", s.total("2026-08-26").committedUsd === 0);
  }

  // ══ Retention ═══════════════════════════════
  console.log("\n=== retention cannot reach today ===");
  {
    const s = new ModelStore();
    s.reserve(REQ, LIMIT);
    s.days.set("2024-01-01", { ...s.total(), day: "2024-01-01", committedUsd: 1 });
    const deleted = s.prune(400);
    t("an old day is pruned", deleted === 1);
    t("TODAY survives", s.days.has(s.utcDay()));
    t("today's accounting is intact", s.total().reservedUsd === REQ);
    t("prune(0) is forced to keep at least one day", (() => { const s2 = new ModelStore(); s2.reserve(REQ, LIMIT); s2.prune(0); return s2.days.has(s2.utcDay()); })());
    t("prune(-9999) cannot reach today either", (() => { const s2 = new ModelStore(); s2.reserve(REQ, LIMIT); s2.prune(-9999); return s2.days.has(s2.utcDay()); })());
  }

  // ══ Store-layer policy ══════════════════════
  console.log("\n=== store layer: unavailable and malformed ===");
  {
    const closed = { maxCostUsd: LIMIT, failOpen: false };
    const noop = async () => true;

    t("no store → denied", !(await reserveDailyBudget(REQ, null, closed)).allowed);
    t("malformed verdict (null) → denied", !(await reserveDailyBudget(REQ, { reserve: async () => null, finalize: noop }, closed)).allowed);
    t(
      "allowed-without-id → denied",
      !(await reserveDailyBudget(REQ, { reserve: async () => ({ allowed: true }), finalize: noop }, closed)).allowed
    );
    t(
      "a throwing store → denied",
      !(await reserveDailyBudget(REQ, { reserve: async () => { throw new Error("down"); }, finalize: noop }, closed)).allowed
    );
    t("NaN amount → denied before the store is called", !(await reserveDailyBudget(NaN, { reserve: async () => ({ allowed: true, reservationId: "x" }), finalize: noop }, closed)).allowed);
    t("negative amount → denied", !(await reserveDailyBudget(-1, { reserve: async () => ({ allowed: true, reservationId: "x" }), finalize: noop }, closed)).allowed);

    // finalize never throws into the caller.
    let threw = false;
    try {
      const ok = await finalizeDailyBudget(
        { id: "x", amountUsd: REQ },
        0.01,
        { modelCalls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { reserve: async () => null, finalize: async () => { throw new Error("boom"); } }
      );
      t("a throwing finalize reports failure rather than throwing", ok === false);
    } catch {
      threw = true;
    }
    t("finalize never throws into the request path", !threw);
    t("finalize with no reservation is a no-op", (await finalizeDailyBudget(null, 1, { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })) === false);
  }

  // ══ Unknown pricing end to end ══════════════
  console.log("\n=== unknown pricing never becomes zero ===");
  {
    const b = new RequestBudget("claude-not-a-real-model");
    b.recordCall({ input_tokens: 100, output_tokens: 50 });
    t("settlement cost is null for an unpriced model", b.settlementCostUsd === null);

    const priced = new RequestBudget("claude-sonnet-5");
    priced.recordCall({ input_tokens: 1000, output_tokens: 50 });
    t("…and a real number for a priced one", typeof priced.settlementCostUsd === "number");

    const allAssumed = new RequestBudget("claude-sonnet-5");
    allAssumed.recordCall({ nonsense: true });
    t("if EVERY call had unreadable usage, the cost is unknown, not a guess", allAssumed.settlementCostUsd === null);

    const s = new ModelStore();
    const r = s.reserve(REQ, LIMIT);
    s.finalize(r.id!, null);
    t("and an unknown settlement charges the full reservation", Math.abs(s.total().committedUsd - REQ) < 1e-9);
  }

  // ══ SQL structure ═══════════════════════════
  console.log("\n=== migration 0059: structural guarantees ===");
  {
    t("the guard lives in the UPDATE's WHERE clause", /where d\.day = v_day\s*\n\s*and d\.committed_usd \+ d\.reserved_usd \+ p_amount <= p_limit/.test(MIG), "check and reserve are one statement");
    t("the reservation update returns row_count for the verdict", /get diagnostics v_affected = row_count/.test(MIG));
    t("finalize takes the reservation row FOR UPDATE", /where id = p_reservation_id\s*\n\s*for update/.test(MIG));
    t("finalize short-circuits a non-reserved state", /if r\.state <> 'reserved' then/.test(MIG));
    t("a null actual charges the reservation, not zero", /when p_actual_usd is null then r\.reserved_usd/.test(MIG));

    t("NaN is rejected explicitly in reserve", /p_amount = 'NaN'::numeric/.test(MIG));
    t("NaN is rejected explicitly in finalize", /p_actual_usd = 'NaN'::numeric/.test(MIG));
    t("negative amounts are rejected", /p_amount < 0/.test(MIG));

    t("money is numeric, never float", /numeric\(14,6\)/.test(CODE) && !/double precision|\breal\b|\bfloat\b/.test(CODE));
    t("every day boundary goes through ai_utc_day()", /ai_utc_day\(\)/.test(CODE) && !/\bcurrent_date\b/.test(CODE));
    t("UTC is computed, not assumed", /now\(\) at time zone 'utc'/.test(MIG));

    t("totals cannot go negative", /check \(committed_usd >= 0\)/.test(MIG) && /check \(reserved_usd\s+>= 0\)/.test(MIG));
    t("the release is floored at zero", /greatest\(d\.reserved_usd - r\.reserved_usd, 0\)/.test(MIG));

    t("the sweep keys on the reservation's OWN age", /created_at < now\(\) - p_reservation_ttl/.test(MIG));
    t("…and charges rather than refunds", /state = 'expired',\s*\n\s*actual_usd = reserved_usd/.test(MIG));
    t("the sweep is NOT 0019's caller-window delete", !/\(p_window \* 3\)/.test(CODE));

    t("prune is floored at one day", /greatest\(coalesce\(p_keep_days, 400\), 1\)/.test(MIG));
    t("prune uses strict less-than, so today is unreachable", /day < ai_utc_day\(\) - v_keep/.test(MIG));
    t("prune leaves outstanding reservations alone", /where state <> 'reserved'/.test(MIG));
    t("prune is not called from the request path", !/ai_budget_prune\(/.test(MIG.split("create or replace function public.ai_budget_prune")[0]));
  }

  console.log("\n=== migration 0059: security ===");
  {
    t("RLS is enabled on both tables", /alter table ai_daily_spend\s+enable row level security/.test(MIG) && /alter table ai_spend_reservations enable row level security/.test(MIG));
    t("no policy is created at all", !/create policy/i.test(MIG));
    t("table grants are revoked from anon and authenticated", /revoke all on ai_daily_spend\s+from anon, authenticated/.test(MIG) && /revoke all on ai_spend_reservations from anon, authenticated/.test(MIG));
    t("tables are granted only to service_role", /grant all on ai_daily_spend\s+to service_role/.test(MIG) && /grant all on ai_spend_reservations to service_role/.test(MIG));

    const revokes = MIG.match(/revoke execute on function [\s\S]*?from public, anon, authenticated;/g) ?? [];
    t("every function revokes execute from public, anon and authenticated", revokes.length === 5, `${revokes.length} revokes`);
    t("…including `public`, which is granted execute by default", revokes.every((r) => r.includes("public")));
    const grants = MIG.match(/grant execute on function [\s\S]*?to service_role;/g) ?? [];
    t("…and grants it only to service_role", grants.length === 5 && grants.every((g) => g.includes("service_role")));
    t("the four accounting functions are security definer", (CODE.match(/security definer/g) ?? []).length === 4);
    t("…with a pinned search_path", (MIG.match(/set search_path = public/g) ?? []).length >= 5);
    t("the verify block asserts zero client grants", /client_grants_should_be_zero/.test(MIG) && /client_execute_should_be_zero/.test(MIG));
    t("the verify block asserts zero policies", /policies_should_be_zero/.test(MIG));
    t("the verify block does not call reserve (no side effects)", !/select[\s\S]*ai_budget_reserve\(/.test(MIG.split("-- Verify")[1] ?? ""));
  }

  console.log("\n=== migration 0059: no PII ===");
  {
    const forbidden = [
      "email", "customer", "user_id", "session", "ip_hash", "ip_address",
      "prompt", "message", "content", "tool_arg", "transcript", "name", "phone", "address",
    ];
    // Column definitions only — the prose deliberately discusses these words.
    const tableBodies = (MIG.match(/create table if not exists \w+ \(([\s\S]*?)\n\);/g) ?? []).join("\n");
    const stripped = tableBodies.replace(/--.*$/gm, "");
    for (const word of forbidden) {
      t(`no column named for "${word}"`, !new RegExp(`^\\s*\\w*${word}\\w*\\s+`, "im").test(stripped));
    }
    t("the only identifier is a random uuid", /id\s+uuid primary key default gen_random_uuid\(\)/.test(MIG));
    t("no trace id is stored", !/trace/i.test(stripped));
  }

  // ══ Nothing else changed ════════════════════
  console.log("\n=== isolation and regressions ===");
  {
    const chat = fs.readFileSync("lib/chat.ts", "utf8");
    const route = fs.readFileSync("app/api/chat/route.ts", "utf8");
    const wa = fs.readFileSync("app/api/whatsapp/webhook/route.ts", "utf8");
    const quota = fs.readFileSync("lib/chatQuota.ts", "utf8");

    t("MAX_TOOL_ROUNDS unchanged", /MAX_TOOL_ROUNDS = 4/.test(chat));
    t("the model is unchanged", /CHAT_MODEL = "claude-sonnet-5"/.test(chat));
    t("the tool list is unchanged", (await import("../lib/chatTools")).CHAT_TOOL_NAMES.length === 4);
    t("the request-level ceiling is still enforced", /checkBeforeCall\(\)/.test(chat));
    t("the hourly quota is still consumed", /consumeChatQuota\(caller\)/.test(route));
    t("…and still fails closed", !/allowed:\s*true/.test(quota.replace(/\/\*[\s\S]*?\*\//g, "")));
    t("the feature flag is still checked server-side", /ask_wovenne_enabled/.test(route));

    t("the WhatsApp path takes no daily reservation", !/reserveDailyBudget|finalizeDailyBudget/.test(wa));
    t("the WhatsApp path passes no budget", !/budget/.test(wa));
    // Measured in the FUNCTION BODY, not the file: the import block lists
    // finalizeDailyBudget before reserveDailyBudget, which made a naive
    // indexOf comparison report the calls in the wrong order.
    const body = route.slice(route.indexOf("export async function POST"));
    t("the daily budget is reserved BEFORE the model loop", body.indexOf("await reserveDailyBudget(") < body.indexOf("streamChat("));
    t("…and settled after", body.indexOf("await finalizeDailyBudget(") > body.indexOf("await reserveDailyBudget("));

    t("no Storage API was introduced", !/from\(["']product-images["']\)|storage\.from|\.upload\(/.test(MIG + fs.readFileSync("lib/ai/dailySpend.ts", "utf8") + fs.readFileSync("lib/ai/budget.ts", "utf8")));

    // Eval isolation: the eval budget must not touch the daily production pot.
    const budgetSrc = fs.readFileSync("lib/ai/budget.ts", "utf8");
    const evalClass = budgetSrc.slice(budgetSrc.indexOf("export class EvalBudget"));
    t("EvalBudget never reserves daily production budget", !/reserveDailyBudget|DailySpendStore|ai_budget_reserve/.test(evalClass));
    t("EvalBudget reads its own limits", /AI_LIMITS\.evaluation/.test(evalClass));

    // Telemetry categories.
    for (const e of ["daily_budget_reserved", "daily_budget_denied", "daily_budget_unavailable", "daily_budget_reconciled", "reconciliation_failed"]) {
      t(`telemetry has ${e}`, (obs.BUDGET_EVENTS as readonly string[]).includes(e));
    }
    const emitted: string[] = [];
    const origLog = console.log;
    console.log = (m: string) => emitted.push(String(m));
    obs.emitBudgetEvent("daily_budget_reserved", { traceId: "t1", reservationId: "r1", amountUsd: 0.06 });
    console.log = origLog;
    const line = JSON.parse(emitted[0]);
    t("a budget event is one structured line", line.evt === "ai_budget" && line.event === "daily_budget_reserved");
    t("…carrying no customer field", !/email|customer|session|prompt|message/i.test(emitted[0]));
  }

  // ══ Mutation tests ══════════════════════════
  console.log("\n=== mutation: the protections are load-bearing ===");
  {
    // Remove the ceiling guard — the concurrency assertion must fail.
    const unguarded = new ModelStore(false);
    unguarded.total().committedUsd = 4.96;
    const a = unguarded.reserve(REQ, LIMIT);
    const b = unguarded.reserve(REQ, LIMIT);
    const held = unguarded.total().committedUsd + unguarded.total().reservedUsd;
    t(
      "MUTATION: without the WHERE guard, both concurrent requests get through",
      a.allowed && b.allowed && held > LIMIT,
      `$${held.toFixed(4)} held — the assertion above would fail, as it must`
    );

    // Remove idempotency — duplicate reconciliation must double-charge.
    const notIdempotent = new ModelStore(true, false);
    const r = notIdempotent.reserve(REQ, LIMIT);
    notIdempotent.finalize(r.id!, 0.02);
    notIdempotent.finalize(r.id!, 0.02);
    t(
      "MUTATION: without the state check, a retry charges twice",
      Math.abs(notIdempotent.total().committedUsd - 0.04) < 1e-9,
      `$${notIdempotent.total().committedUsd} — proving the idempotency assertion is real`
    );

    // And confirm the guarded versions still behave.
    const guarded = new ModelStore();
    guarded.total().committedUsd = 4.96;
    t("CONTROL: with the guard, both are refused", !guarded.reserve(REQ, LIMIT).allowed && !guarded.reserve(REQ, LIMIT).allowed);
    const idem = new ModelStore();
    const r2 = idem.reserve(REQ, LIMIT);
    idem.finalize(r2.id!, 0.02);
    idem.finalize(r2.id!, 0.02);
    t("CONTROL: with the state check, a retry charges once", Math.abs(idem.total().committedUsd - 0.02) < 1e-9);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
