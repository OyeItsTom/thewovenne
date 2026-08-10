import { PHOTO_GUIDANCE } from "./styleMedia";

/**
 * Turning whatever a customer's phone produced into something the site can show.
 *
 * WHY THE BROWSER AND NOT THE SERVER. A 12-megapixel photograph is 4–6MB and
 * arrives from a phone on Indian mobile data; uploading it in full to resize it
 * afterwards spends the customer's bandwidth on pixels nobody will ever see, and
 * is the step most likely to fail halfway and lose the submission. Re-encoded
 * here, the upload is a few hundred kilobytes.
 *
 * IT ALSO SOLVES HEIC FOR FREE, which is the reason lib/storage.ts can go on
 * refusing it everywhere else. Drawing to a canvas and exporting as JPEG only
 * requires the BROWSER to decode the source — and the browser that produced a
 * HEIC is Safari on the iPhone, which decodes it happily. So the file that
 * reaches the bucket is a JPEG no matter what came off the camera, and a browser
 * that cannot decode the source fails here, before anything is uploaded, with
 * something a person can act on.
 */

export class PhotoUnreadableError extends Error {}

/**
 * The size to draw at: never enlarged, never wider than the ceiling.
 *
 * Pure and exported so it can be tested without a canvas — the arithmetic is
 * where an off-by-one turns every portrait into a slightly squashed one.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxWidth: number = PHOTO_GUIDANCE.maxUploadWidth
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  // Small photographs are left alone. Scaling a 700px photo up to 2000 adds
  // nothing but bytes and makes a soft image bigger, not better.
  if (width <= maxWidth) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxWidth / width;
  return {
    width: maxWidth,
    // Rounded, and at least 1: a very wide panorama would otherwise round to a
    // zero-height canvas, which throws rather than drawing.
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface PreparedPhoto {
  file: File;
  width: number;
  height: number;
  /** For the form's own preview. Revoked by the caller when it is done. */
  previewUrl: string;
  /** True when the ORIGINAL was smaller than we would like. Advisory only. */
  wasSmall: boolean;
}

/**
 * Decode, downscale, re-encode as JPEG, and report the real dimensions.
 *
 * The dimensions returned are the ones actually written, not the ones the file
 * claimed: the gallery reserves space from these numbers, and a value that
 * disagrees with the image is worse than none.
 */
export async function prepareStylePhoto(file: File): Promise<PreparedPhoto> {
  if (file.size > PHOTO_GUIDANCE.maxBytes * 3) {
    // A generous multiple of the eventual limit: the point is to reject a video
    // somebody picked by mistake before spending ten seconds decoding it, not to
    // enforce the limit here — that is what the re-encoded size is measured for.
    throw new PhotoUnreadableError(
      "That file is very large — is it a photograph? Pick an image and we'll shrink it for you."
    );
  }

  const bitmap = await decode(file);
  const target = targetDimensions(bitmap.width, bitmap.height);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) throw new PhotoUnreadableError("This browser could not process the photograph.");
  context.drawImage(bitmap, 0, 0, target.width, target.height);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    // 0.82 is the usual sweet spot for photographs: visually indistinguishable
    // from 0.95 at this size, and roughly half the bytes.
    canvas.toBlob(resolve, "image/jpeg", 0.82)
  );
  if (!blob) throw new PhotoUnreadableError("The photograph could not be prepared. Try another one.");

  if (blob.size > PHOTO_GUIDANCE.maxBytes) {
    throw new PhotoUnreadableError(
      "That photograph is still too large after resizing. Try one taken at a lower resolution."
    );
  }

  return {
    file: new File([blob], "style.jpg", { type: "image/jpeg" }),
    width: target.width,
    height: target.height,
    previewUrl: URL.createObjectURL(blob),
    wasSmall: bitmap.width < PHOTO_GUIDANCE.minComfortableWidth,
  };
}

/**
 * Decode a file to something drawable.
 *
 * createImageBitmap first because it decodes off the main thread and handles
 * every format the browser knows, HEIC included on Safari. The <img> fallback is
 * for browsers without it; both paths end in the same failure message, because
 * "your browser cannot read this photograph" is the only actionable thing to say
 * either way.
 */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Falls through to the <img> path rather than failing here: Safari has
      // been known to refuse createImageBitmap for HEIC while rendering it in an
      // <img> perfectly well, which is exactly the case this feature needs.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(
          new PhotoUnreadableError(
            "This browser can't read that photograph. If it came from an iPhone, either send it from the phone itself or export it as JPEG first."
          )
        );
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
