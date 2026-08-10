/**
 * "A photograph is waiting" — to the shop, not to a customer.
 *
 * THIS IS THE FIRST EMAIL THE BUSINESS SENDS ITSELF, so it sets the shape for
 * the ones after it. It is deliberately plain: an internal notice is read in
 * three seconds on a phone and acted on later, so it carries what is needed to
 * decide whether to stop what you are doing — which piece, what came with it —
 * and one link. No branding furniture, no photograph embedded.
 *
 * THE PHOTOGRAPH IS NOT IN IT, on purpose. It is unreviewed content from
 * outside the business, and the whole point of the queue is that somebody looks
 * at it deliberately, signed in, where approving and turning down are both one
 * click away. An unmoderated image auto-loading in a mail client is the one
 * place nobody chose to look at it.
 *
 * NOR IS THE CUSTOMER'S EMAIL ADDRESS. It is in the queue, behind is_admin().
 * A notification that fans out to three inboxes is a copy of somebody's contact
 * details in three inboxes, and it buys nothing the link does not.
 */

export interface StyleSubmittedData {
  productName: string;
  /** The name they asked to be credited as, if they asked at all. */
  creditName: string | null;
  caption: string | null;
  hasPhoto: boolean;
  /** "instagram" | "youtube" | null */
  videoPlatform: string | null;
  queueUrl: string;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** "a photograph", "a YouTube link", "a photograph and an Instagram link". */
export function describeWhatArrived(data: {
  hasPhoto: boolean;
  videoPlatform: string | null;
}): string {
  const platform =
    data.videoPlatform === "youtube"
      ? "a YouTube link"
      : data.videoPlatform === "instagram"
        ? "an Instagram link"
        : null;

  if (data.hasPhoto && platform) return `a photograph and ${platform}`;
  if (platform) return platform;
  return "a photograph";
}

export function styleSubmittedSubject(productName: string): string {
  // Names the piece rather than saying "New submission", so three of these in
  // an inbox are three different things rather than one thing repeated.
  return `New customer photo awaiting review — ${productName}`;
}

export function styleSubmittedText(data: StyleSubmittedData): string {
  const lines = [
    `Somebody has sent ${describeWhatArrived(data)} of the ${data.productName}.`,
    "",
    data.creditName
      ? `They have asked to be credited as ${data.creditName}.`
      : "They have asked to appear without a name.",
  ];

  if (data.caption?.trim()) {
    lines.push("", `What they said: "${data.caption.trim()}"`);
  }

  lines.push(
    "",
    "It is not public. Nothing appears on the site until you approve it.",
    "",
    `Review it: ${data.queueUrl}`,
    "",
    "— THE WOVENNE"
  );

  return lines.join("\n");
}

export function styleSubmittedHtml(data: StyleSubmittedData): string {
  const caption = data.caption?.trim();

  return `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="margin:0;padding:24px;background:#F0EAD6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2B2724;">
    <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:12px;padding:32px;">
      <p style="margin:0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#8A8178;">
        Customer Style
      </p>
      <h1 style="margin:8px 0 0;font-size:22px;font-weight:600;line-height:1.3;">
        A photograph is waiting for you
      </h1>

      <p style="margin:20px 0 0;font-size:15px;line-height:1.6;">
        Somebody has sent ${esc(describeWhatArrived(data))} of the
        <strong>${esc(data.productName)}</strong>.
      </p>

      <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#5C554E;">
        ${
          data.creditName
            ? `They have asked to be credited as <strong>${esc(data.creditName)}</strong>.`
            : "They have asked to appear without a name."
        }
      </p>

      ${
        caption
          ? `<blockquote style="margin:20px 0 0;padding:12px 16px;background:#F0EAD6;border-radius:8px;font-size:15px;line-height:1.6;font-style:italic;color:#5C554E;">
        ${esc(caption)}
      </blockquote>`
          : ""
      }

      <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#5C554E;">
        Nothing is public yet — it appears on the site only once you approve it.
      </p>

      <p style="margin:28px 0 0;">
        <a href="${esc(data.queueUrl)}"
           style="display:inline-block;background:#B5654A;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:14px;">
          Review it
        </a>
      </p>

      <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#8A8178;">
        You are getting this because you are an admin on The Wovenne.
      </p>
    </div>
  </body>
</html>`;
}
