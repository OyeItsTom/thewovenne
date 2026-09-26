import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { verifyMasterDelivery } from "@/lib/imageDelivery";
import { createRSCClient } from "@/lib/supabaseRSC";
import {
  ImageRejected,
  JPEG_MASTER,
  MASTER_CACHE_CONTROL,
  MAX_INPUT_PIXELS,
  NORMALIZER_VERSION,
  assertAcceptedFormat,
  assertUsableBytes,
  assertUsableSource,
  masterEncoding,
  masterKey,
  masterUploadOptions,
  stagingKey,
  targetSize,
} from "@/lib/imageNormalize";

/**
 * Turn a camera original into the master the catalogue actually serves.
 *
 * WHY A SERVER ROUTE AND NOT THE BROWSER. The browser was measured first,
 * because lib/stylePhoto.ts already normalizes customer photographs on the
 * device and doing the same here would mean the huge original never reached
 * storage at all. It lost on quality: a canvas cannot choose its chroma
 * subsampling, and at 4:2:0 the zari border scored 0.9729 against this
 * pipeline's 0.9898, the saturated red 0.9677 against 0.9894 — the two things
 * this shop sells. Even at quality 0.95 it did not catch up, and the file was
 * larger. So the encoding happens here, where 4:4:4 is available.
 *
 * WHY THE FILE IS NOT POSTED HERE. A serverless request body caps out around
 * 4.5MB and these originals are 13–27MB. The browser uploads straight to
 * Supabase — which it is already allowed to do — and this route is told only
 * which staged object to fetch. That also means a dropped connection during the
 * upload costs a staged object, not a half-processed product.
 *
 * MEASURED ON THIS CATALOGUE'S OWN PHOTOGRAPHS: 50 megapixels, 2.2–2.5s,
 * ~220MB RSS. Comfortable inside the Node runtime's limits, which is the reason
 * this is allowed to be a route at all.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const BUCKET = "product-images";

/** Peak memory is bounded by doing one photograph at a time. */
sharp.cache(false);
sharp.concurrency(1);

interface Body {
  stagingId?: string;
  ext?: string;
}

export async function POST(request: NextRequest) {
  const supabase = createRSCClient();

  /*
   * ADMIN BEFORE ANYTHING ELSE — before the body is read, before a byte is
   * fetched, before sharp is asked to decode anything. This is the same check
   * and the same 404 the rest of the admin surface uses: a stranger should not
   * be able to tell the difference between "not allowed" and "not there".
   */
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  let staged: string;
  try {
    const body = (await request.json()) as Body;
    // The caller sends an id and an extension. The KEY is built here, from
    // values matched against a fixed pattern — see stagingKey for why that is
    // the whole path defence rather than a blocklist of tricks.
    staged = stagingKey(body.stagingId ?? "", body.ext ?? "");
  } catch (error) {
    return reject(error, "bad_request");
  }

  let source: Buffer;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(staged);
    if (error || !data) {
      return NextResponse.json(
        { error: "That upload could not be found. Please try again." },
        { status: 404 }
      );
    }
    source = Buffer.from(await data.arrayBuffer());
  } catch {
    return NextResponse.json(
      { error: "That upload could not be read. Please try again." },
      { status: 502 }
    );
  }

  let masterPath: string;
  let bytesOut: number;
  let masterMd5: string;
  let duplicate: boolean;
  let width: number;
  let height: number;

  try {
    assertUsableBytes(source.byteLength);
    // The container's own signature, not the extension the caller chose.
    assertAcceptedFormat(source);

    const probe = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const meta = await probe.metadata();
    if (!meta.width || !meta.height) {
      throw new ImageRejected("That photograph could not be read.", "no_dimensions");
    }

    // Orientation 5–8 mean the stored pixels are rotated relative to how the
    // photograph is meant to be seen. Every measurement below is taken on the
    // DISPLAYED shape; this catalogue really does contain 1, 6 and 8.
    const rotated = (meta.orientation ?? 1) >= 5;
    const display = {
      width: rotated ? meta.height : meta.width,
      height: rotated ? meta.width : meta.height,
    };
    assertUsableSource(display);

    const target = targetSize(display);
    const hasRealAlpha = Boolean(meta.hasAlpha) && (await usesAlpha(source));
    const encoding = masterEncoding(hasRealAlpha);

    const pipeline = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      // Bakes the rotation into the pixels, so the master no longer depends on
      // EXIF being read correctly by anything downstream.
      .rotate()
      /*
       * CONVERT, NEVER MERELY STRIP. Every camera original in this catalogue is
       * DCI-P3. Dropping the profile leaves wide-gamut numbers wearing no label,
       * which the optimizer and the browser both read as sRGB — measured at up
       * to −10 red and +8 blue on a saturated saree, a visible shift. Converting
       * first and tagging sRGB keeps the colour and makes the tag honest.
       */
      .toColourspace("srgb")
      .withIccProfile("srgb")
      .resize({
        width: target.width,
        height: target.height,
        fit: "inside",
        withoutEnlargement: true,
        kernel: "lanczos3",
      });

    const master = hasRealAlpha
      ? await pipeline.webp({ lossless: true, effort: 4 }).toBuffer()
      : await pipeline.jpeg({ ...JPEG_MASTER, mozjpeg: false }).toBuffer();

    // VERIFY THE OUTPUT BEFORE ANYTHING IS WRITTEN. An encoder that produced a
    // truncated or zero-size image must not become a product's photograph.
    const check = await sharp(master).metadata();
    if (!check.width || !check.height || master.byteLength === 0) {
      throw new ImageRejected("That photograph could not be prepared.", "bad_output");
    }
    if (check.width !== target.width && check.height !== target.height) {
      throw new ImageRejected("That photograph could not be prepared.", "unexpected_size");
    }

    const hash = createHash("sha256").update(source).digest("hex");
    masterPath = masterKey(hash, encoding.ext);
    bytesOut = master.byteLength;
    // What the delivery check compares the served ETag against. See
    // lib/imageDelivery for when an ETag is, and is not, an MD5.
    masterMd5 = createHash("md5").update(master).digest("hex");
    width = check.width;
    height = check.height;

    /*
     * upsert:false, and "already exists" is SUCCESS. The key is derived from the
     * source's hash and the pipeline version, so a retry — a double click, a
     * dropped response, a re-submitted form — resolves to the same object. The
     * duplicate is the idempotency working, not a collision to work around —
     * but only once the delivery check below has shown the existing object is
     * these bytes. A name is not proof.
     *
     * The options carry X-Robots-Tag: all and a real `max-age=` Cache-Control,
     * the same headers the raw REST scripts send (lib/imageNormalize).
     */
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(masterPath, master, masterUploadOptions(encoding.contentType));

    // A. UPLOAD FAILED.
    if (uploadError && !isDuplicate(uploadError)) {
      return NextResponse.json(
        { error: "That photograph could not be saved. Please try again." },
        { status: 502 }
      );
    }
    // B. AN EXISTING DUPLICATE — judged below like any other master.
    duplicate = Boolean(uploadError);
  } catch (error) {
    // NOTHING HAS BEEN DELETED. The staged original is still there, which is the
    // point: a failure here must leave the only copy of the photograph intact so
    // the admin can simply try again.
    return reject(error, "processing_failed");
  }

  /*
   * The master must be readable, and be THESE bytes, before anything is allowed
   * to point at it. One ranged GET of the public URL — never HEAD, which the
   * hosted service answers from somewhere other than the stored object.
   *
   * NOTHING HERE DELETES THE MASTER, whatever the answer. A master that fails
   * this check stays where it is (an unreferenced object is the orphan tooling's
   * job, and deleting a content-addressed object another product may already use
   * would be far worse) and the staged original stays too, so nothing is lost.
   */
  const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(masterPath).data.publicUrl;
  const served = await verifyMasterDelivery(publicUrl, {
    byteLength: bytesOut,
    md5: masterMd5,
    maxAge: Number(MASTER_CACHE_CONTROL),
  });

  if (!served.ok) {
    console.error(
      `[image-normalize] delivery-failed ${served.failure} master=${masterPath} duplicate=${duplicate} status=${served.httpStatus ?? "none"} — ${served.detail}`
    );
    // C. UNREADABLE.
    if (served.failure === "unreadable") {
      return NextResponse.json(
        { error: "That photograph could not be verified. Please try again." },
        { status: 502 }
      );
    }
    // DEMONSTRABLY DIFFERENT BYTES. For a duplicate this is the case the name
    // would otherwise have hidden: never accept it as the same photograph.
    return NextResponse.json(
      {
        error: duplicate
          ? "This photograph was added before, but the stored copy does not match it, so it was not used. Please report this rather than retrying."
          : "That photograph could not be verified. Please try again.",
      },
      { status: duplicate ? 409 : 502 }
    );
  }

  /*
   * D. IDENTITY UNVERIFIED, E. NOT INDEXABLE, or a wrong Cache-Control. The
   * photograph is readable and not shown to be different bytes, so the upload
   * stands — the storefront's own markup names it through /_next/image, which
   * does not carry the storage headers — but it is NOT reported as verified.
   * `delivery` says exactly what is wrong, and the log line is what an operator
   * searches for. A duplicate of a master made before this fix lands here as
   * not_indexable: it cannot be corrected in place (a same-key overwrite leaves
   * the CDN serving the old headers), which is SEO-6B's separate decision.
   */
  const { delivery } = served;
  if (delivery.status !== "verified") {
    console.warn(
      `[image-normalize] delivery-warning ${delivery.warnings.join(",")} master=${masterPath} duplicate=${duplicate} x-robots-tag=${delivery.robotsTag ?? "absent"} cache-control=${delivery.cacheControl ?? "absent"}`
    );
  }

  /*
   * ONLY NOW is the original allowed to go, and its removal is the last
   * destructive act in the request. If it fails the customer still gets the
   * photograph — the master exists and is readable — so this is reported, not
   * thrown. What must never happen is the reverse: deleting the one valid copy
   * before its replacement is proven.
   *
   * The product association is written by the caller from the URL returned
   * below, inside the same form submission that already saves the rest of the
   * product. Nothing here writes a row, so nothing here can leave the database
   * pointing at an object that does not exist.
   */
  let stagedRemoved = true;
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([staged]);
    if (error) stagedRemoved = false;
  } catch {
    stagedRemoved = false;
  }
  if (!stagedRemoved) {
    console.warn(
      `[image-normalize] master ${masterPath} is live but staged object ${staged} was not removed; it needs sweeping`
    );
  }

  return NextResponse.json({
    url: publicUrl,
    width,
    height,
    bytes: bytesOut,
    stagedRemoved,
    version: NORMALIZER_VERSION,
    duplicate,
    delivery,
  });
}

/** Whether an alpha channel is actually used, or merely present. */
async function usesAlpha(source: Buffer): Promise<boolean> {
  try {
    const { channels } = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
      .ensureAlpha()
      .stats();
    const alpha = channels[channels.length - 1];
    return alpha ? alpha.min < 255 : false;
  } catch {
    // Unreadable statistics are not a reason to flatten something that might
    // need its transparency; treat it as alpha and keep the lossless path.
    return true;
  }
}

function isDuplicate(error: { message?: string; statusCode?: string }): boolean {
  const message = (error?.message ?? "").toLowerCase();
  return (
    error?.statusCode === "409" ||
    message.includes("already exists") ||
    message.includes("duplicate")
  );
}

function reject(error: unknown, fallback: string) {
  if (error instanceof ImageRejected) {
    console.warn(`[image-normalize] refused: ${error.reason}`);
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  console.error(`[image-normalize] ${fallback}`, error);
  return NextResponse.json(
    { error: "That photograph could not be processed. Please try another photo." },
    { status: 500 }
  );
}
