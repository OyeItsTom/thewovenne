/**
 * The daily spend store, backed by migration 0059.
 *
 * ══ WHY THIS IS A THIN FILE ══
 *
 * Every decision that matters — the ceiling check, the atomicity, the
 * idempotency, what an unknown cost is charged — lives in the database, in the
 * functions 0059 defines. That is deliberate: those are the guarantees that
 * have to hold under concurrency, and a guarantee enforced in application code
 * is a guarantee that holds only for the instances running that code. Two
 * serverless instances cannot coordinate; one Postgres row can.
 *
 * So this file translates, and does not decide. It reads a jsonb verdict and
 * turns it into a typed one. The single piece of judgement it exercises is that
 * a transport failure means UNAVAILABLE rather than allowed — and even that is
 * really the caller's policy, applied in lib/ai/budget.ts.
 *
 * ══ SERVICE ROLE, AND NOTHING ELSE ══
 *
 * 0059 revokes execute from public, anon and authenticated. Only the service
 * role can call these functions, and the service key exists only on the server.
 * A browser holding an anon key that guessed the function name gets a
 * permission error, not a counter it can move.
 */

import { createServiceClient } from "../supabase";
import type { DailySpendStore, ReserveResult } from "./budget";

/** Shape of the jsonb ai_budget_reserve returns. */
interface ReserveRow {
  allowed?: unknown;
  reservation_id?: unknown;
  committed?: unknown;
  reserved?: unknown;
  limit?: unknown;
}

/** Shape of the jsonb ai_budget_finalize returns. */
interface FinalizeRow {
  ok?: unknown;
  idempotent?: unknown;
  charged?: unknown;
  reason?: unknown;
}

/**
 * A number that came back from PostgREST.
 *
 * `numeric` arrives as a STRING over the wire, not a number — the driver will
 * not silently narrow it, because it can hold more precision than a double.
 * Parsing it is therefore required rather than defensive, and a value that will
 * not parse is reported as null so it can be treated as unknown instead of
 * becoming NaN and poisoning a comparison.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function createSupabaseDailySpendStore(): DailySpendStore {
  return {
    async reserve(amountUsd: number, limitUsd: number): Promise<ReserveResult | null> {
      const supabase = createServiceClient();
      const { data, error } = await supabase.rpc("ai_budget_reserve", {
        p_amount: amountUsd,
        p_limit: limitUsd,
      });

      if (error) {
        console.error("ai_budget_reserve failed:", error.message);
        // NOT "allowed". The caller decides what an unreadable budget means, and
        // its default is to refuse.
        return null;
      }

      const row = (data ?? {}) as ReserveRow;

      // A reply we cannot read is a reply we do not trust. Treating a malformed
      // verdict as permission would be the same mistake as treating an unknown
      // cost as zero.
      if (typeof row.allowed !== "boolean") {
        console.error("ai_budget_reserve returned no usable verdict:", JSON.stringify(data));
        return null;
      }

      if (!row.allowed) {
        return {
          allowed: false,
          committedUsd: toNumber(row.committed),
          limitUsd: toNumber(row.limit),
        };
      }

      // Allowed, but with no id there is nothing to reconcile against later —
      // which would leak the reservation for the whole TTL. Safer to refuse.
      if (typeof row.reservation_id !== "string" || row.reservation_id.length === 0) {
        console.error("ai_budget_reserve allowed a request without a reservation id");
        return null;
      }

      return {
        allowed: true,
        reservationId: row.reservation_id,
        committedUsd: toNumber(row.committed),
        limitUsd: toNumber(row.limit),
      };
    },

    async finalize(
      reservationId: string,
      actualUsd: number | null,
      usage: {
        modelCalls: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      }
    ): Promise<boolean> {
      const supabase = createServiceClient();

      // null goes through as null, and 0059 charges the whole reservation for
      // it. Coercing it to 0 here — the obvious tidy-up — would be the exact bug
      // this whole design exists to avoid.
      const { data, error } = await supabase.rpc("ai_budget_finalize", {
        p_reservation_id: reservationId,
        p_actual_usd: actualUsd,
        p_model_calls: usage.modelCalls,
        p_input_tokens: usage.inputTokens,
        p_output_tokens: usage.outputTokens,
        p_cache_read_tokens: usage.cacheReadTokens,
        p_cache_write_tokens: usage.cacheWriteTokens,
      });

      if (error) {
        // The reservation stays outstanding and the sweep in ai_budget_reserve
        // will charge it in full after the TTL. Budget is temporarily consumed;
        // it is never lost track of.
        console.error(`ai_budget_finalize failed for ${reservationId}:`, error.message);
        return false;
      }

      const row = (data ?? {}) as FinalizeRow;
      if (row.ok !== true) {
        console.error(
          `ai_budget_finalize refused ${reservationId}: ${String(row.reason ?? "unknown")}`
        );
        return false;
      }
      return true;
    },
  };
}
