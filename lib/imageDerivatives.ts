import { createHash } from "node:crypto";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyMasterDelivery } from "./imageDelivery";
import { MASTER_CACHE_CONTROL, MAX_INPUT_PIXELS, masterUploadOptions } from "./imageNormalize";
import {
  DERIVATIVE_RECIPE,
  DERIVED_TIERS,
  IMAGE_BUCKET,
  TIER_WIDTH,
  derivedKey,
  publicObjectUrl,
  type DerivedTier,
} from "./imageVariants";

/**
 * MAKING, STORING AND REGISTERING DERIVATIVES. Server only (sharp).
 *
 * Used by the admin upload route, for every new photograph, and by
 * scripts/image-derivatives-backfill.ts, for the ones already in the catalogue.
 * One code path, so a backfilled copy and a freshly uploaded one are the same
 * bytes for the same master.
 *
 * ── THE RECIPE, AND WHY ──
 *
 * Measured on a real catalogue master (2400×3200, 3,244,382 B, 12 Oct 2026),
 * comparing what the optimizer would produce from the master against what it
 * would produce from each candidate:
 *
 *                     1080 bytes  PSNR@828   1920 bytes  PSNR@1920
 *   JPEG q90 4:4:4      550 KB     40.2 dB    1,825 KB    37.4 dB
 *   JPEG q88 4:4:4      493 KB     39.4 dB    1,658 KB    36.4 dB   ← chosen
 *   JPEG q88 4:2:0      400 KB     37.6 dB    1,370 KB    35.1 dB
 *   WebP q90            469 KB     35.7 dB    1,583 KB    37.6 dB
 *   AVIF q70            260 KB     38.5 dB      903 KB    35.8 dB
 *
 * For scale: the optimizer's OWN WebP q75 output is 33.2–33.6 dB from an ideal
 * resize. Every row above differs from the master by less than the optimizer
 * already throws away. JPEG because the optimizer decodes it fastest and every
 * toolchain reads it; 4:4:4 for the same reason the master uses it (the zari
 * border and saturated reds — see JPEG_MASTER); AVIF is smaller but took 5–12 s
 * to encode and is a format nobody has proven Vercel's optimizer takes as a
 * source. A photograph with real transparency gets lossy WebP with alpha, as
 * its master is lossless WebP.
 */
export const DERIVED_JPEG = {
  quality: 88,
  chromaSubsampling: "4:4:4" as const,
  progressive: true,
  mozjpeg: false,
};
export const DERIVED_WEBP_ALPHA = { quality: 90, alphaQuality: 100, effort: 4 };

/**
 * A copy must save at least this share of the source to be worth a second
 * object. Below it the source is already about the right size, and the
 * registry records "not_needed" so nobody downloads it again to find out.
 */
export const MIN_SAVING = 0.2;

export interface BuiltDerivative {
  tier: DerivedTier;
  status: "ready";
  buffer: Buffer;
  width: number;
  height: number;
  ext: "jpg" | "webp";
  contentType: string;
  md5: string;
}
export interface SkippedDerivative {
  tier: DerivedTier;
  status: "not_needed";
  reason: "source_narrow" | "no_saving";
}

/**
 * Build one tier from the source bytes. Width-bound, never enlarged; rotation
 * baked in and colour converted to tagged sRGB exactly as the normalizer does,
 * so a legacy camera file with EXIF orientation 6 or a P3 profile comes out the
 * right way up and the right colour.
 */
export async function buildDerivative(
  source: Buffer,
  tier: DerivedTier,
  opts: { hasRealAlpha: boolean }
): Promise<BuiltDerivative | SkippedDerivative> {
  const target = TIER_WIDTH[tier];
  const meta = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
  if (!meta.width || !meta.height) throw new Error("source has no dimensions");
  const rotated = (meta.orientation ?? 1) >= 5;
  const displayWidth = rotated ? meta.height : meta.width;
  if (displayWidth <= target) return { tier, status: "not_needed", reason: "source_narrow" };

  const pipeline = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
    .rotate()
    .toColourspace("srgb")
    .withIccProfile("srgb")
    .resize({ width: target, withoutEnlargement: true, kernel: "lanczos3" });

  const buffer = opts.hasRealAlpha
    ? await pipeline.webp(DERIVED_WEBP_ALPHA).toBuffer()
    : await pipeline.jpeg(DERIVED_JPEG).toBuffer();

  // Verify the output before anything is stored — never register a truncated
  // or wrongly sized file as a product photograph.
  const check = await sharp(buffer).metadata();
  if (!check.width || !check.height || buffer.byteLength === 0) {
    throw new Error("derivative output unreadable");
  }
  if (check.width !== target) throw new Error(`derivative width ${check.width}, expected ${target}`);

  if (buffer.byteLength > source.byteLength * (1 - MIN_SAVING)) {
    return { tier, status: "not_needed", reason: "no_saving" };
  }
  return {
    tier,
    status: "ready",
    buffer,
    width: check.width,
    height: check.height,
    ext: opts.hasRealAlpha ? "webp" : "jpg",
    contentType: opts.hasRealAlpha ? "image/webp" : "image/jpeg",
    md5: createHash("md5").update(buffer).digest("hex"),
  };
}

/** Whether an alpha channel is actually used, or merely present. */
export async function usesAlpha(source: Buffer): Promise<boolean> {
  const meta = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (!meta.hasAlpha) return false;
  try {
    const { channels } = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).ensureAlpha().stats();
    const alpha = channels[channels.length - 1];
    return alpha ? alpha.min < 255 : false;
  } catch {
    // Unreadable statistics are not a reason to flatten possible transparency.
    return true;
  }
}

export type TierOutcome =
  | {
      tier: DerivedTier;
      status: "ready";
      key: string;
      width: number;
      height: number;
      bytes: number;
      md5: string;
      /** The object already existed and was verified to be these bytes. */
      duplicate: boolean;
    }
  | { tier: DerivedTier; status: "not_needed"; reason: SkippedDerivative["reason"] }
  | { tier: DerivedTier; status: "failed"; reason: string };

export interface DerivativeReport {
  /** complete = every tier ready or not needed; partial = some failed; failed = none usable. */
  status: "complete" | "partial" | "failed";
  tiers: TierOutcome[];
  /** Registry rows written (or already present). False if the registry write failed. */
  registered: boolean;
  registryError?: string;
}

export interface DerivativeDeps {
  /** A client allowed to upload to the bucket (an admin session, or service role in the backfill). */
  storage: SupabaseClient;
  /** A client allowed to insert registry rows (the same admin session, or service role). */
  registry: SupabaseClient;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  supabaseUrl?: string;
}

/**
 * Build, store, verify and register both tiers for one master.
 *
 * NOTHING HERE TOUCHES THE MASTER. It is read (from the buffer the caller
 * already has) and never written, moved or deleted, whatever happens below.
 *
 * IDEMPOTENT. Names are deterministic and uploads are upsert:false, so a retry
 * finds the object already there; that only counts as success once a ranged GET
 * shows the stored object is THESE bytes (MD5 ETag) — a name is not proof.
 * Registry rows are inserted with ON CONFLICT DO NOTHING.
 *
 * EVERY TIER IS INDEPENDENT. One failing never stops the other, and a failed
 * tier is simply absent from the registry — the storefront keeps using the
 * master for that use, and the backfill's next run retries it.
 */
export async function makeAndStoreDerivatives(
  sourceKey: string,
  source: Buffer,
  deps: DerivativeDeps
): Promise<DerivativeReport> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let hasRealAlpha: boolean;
  try {
    hasRealAlpha = await usesAlpha(source);
  } catch (error) {
    return {
      status: "failed",
      tiers: DERIVED_TIERS.map((tier) => ({ tier, status: "failed" as const, reason: describe(error) })),
      registered: false,
    };
  }

  const tiers: TierOutcome[] = [];
  for (const tier of DERIVED_TIERS) {
    tiers.push(await oneTier(sourceKey, source, tier, hasRealAlpha, deps, fetchImpl));
  }

  const rows = tiers
    .filter((t) => t.status !== "failed")
    .map((t) =>
      t.status === "ready"
        ? {
            source_path: sourceKey,
            tier: t.tier,
            recipe: DERIVATIVE_RECIPE,
            status: "ready",
            derived_path: t.key,
            width: t.width,
            height: t.height,
            bytes: t.bytes,
            md5: t.md5,
            source_bytes: source.byteLength,
          }
        : {
            source_path: sourceKey,
            tier: t.tier,
            recipe: DERIVATIVE_RECIPE,
            status: "not_needed",
            derived_path: null,
            width: null,
            height: null,
            bytes: null,
            md5: null,
            source_bytes: source.byteLength,
          }
    );

  let registered = true;
  let registryError: string | undefined;
  if (rows.length > 0) {
    try {
      const { error } = await deps.registry
        .from("image_derivatives")
        .upsert(rows, { onConflict: "source_path,tier,recipe", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    } catch (error) {
      registered = false;
      registryError = describe(error);
    }
  }

  const failed = tiers.filter((t) => t.status === "failed").length;
  const status = failed === 0 ? "complete" : failed === tiers.length ? "failed" : "partial";
  return { status, tiers, registered, ...(registryError ? { registryError } : {}) };
}

async function oneTier(
  sourceKey: string,
  source: Buffer,
  tier: DerivedTier,
  hasRealAlpha: boolean,
  deps: DerivativeDeps,
  fetchImpl: typeof fetch
): Promise<TierOutcome> {
  let built: BuiltDerivative | SkippedDerivative;
  try {
    built = await buildDerivative(source, tier, { hasRealAlpha });
  } catch (error) {
    return { tier, status: "failed", reason: `encode: ${describe(error)}` };
  }
  if (built.status === "not_needed") return { tier, status: "not_needed", reason: built.reason };

  const key = derivedKey(sourceKey, tier, built.ext);
  let duplicate = false;
  try {
    const { error } = await deps.storage.storage
      .from(IMAGE_BUCKET)
      .upload(key, built.buffer, masterUploadOptions(built.contentType));
    if (error) {
      if (!isDuplicate(error)) return { tier, status: "failed", reason: `upload: ${error.message}` };
      duplicate = true;
    }
  } catch (error) {
    return { tier, status: "failed", reason: `upload: ${describe(error)}` };
  }

  const url = publicObjectUrl(key, deps.supabaseUrl);
  if (!url) return { tier, status: "failed", reason: "no storage URL configured" };
  const served = await verifyMasterDelivery(
    url,
    { byteLength: built.buffer.byteLength, md5: built.md5, maxAge: Number(MASTER_CACHE_CONTROL) },
    fetchImpl
  );
  if (!served.ok) {
    return { tier, status: "failed", reason: `verify: ${served.failure} — ${served.detail}` };
  }
  // A duplicate must be PROVEN to be these bytes. Identity "unverified" on a new
  // object is still acceptable (the bytes were just written by us); on a
  // duplicate it is not.
  if (duplicate && served.delivery.identity !== "md5") {
    return { tier, status: "failed", reason: "verify: existing object could not be shown to be these bytes" };
  }
  return {
    tier,
    status: "ready",
    key,
    width: built.width,
    height: built.height,
    bytes: built.buffer.byteLength,
    md5: built.md5,
    duplicate,
  };
}

export function isDuplicate(error: { message?: string; statusCode?: string }): boolean {
  const message = (error?.message ?? "").toLowerCase();
  return error?.statusCode === "409" || message.includes("already exists") || message.includes("duplicate");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
