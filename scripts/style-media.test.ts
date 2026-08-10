/**
 * What a customer may paste, and what we do with it.
 *
 *   npx tsx scripts/style-media.test.ts
 *
 * Pure — no client, no network, no key. This is the layer the submission form,
 * the gallery, the per-product section and the admin queue all share, so a
 * disagreement here is a disagreement between all four.
 *
 * The refusals matter as much as the matches. A profile URL accepted as a
 * submission would publish a customer's entire feed under our name, and a
 * near-miss YouTube id would put a dead player on a page.
 */
import {
  LINK_HELP,
  PHOTO_GUIDANCE,
  isBelowComfortable,
  parseStyleLink,
  watchLabel,
} from "../lib/styleMedia";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  t(name, JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) === JSON.stringify(expected) ? "" : `got ${JSON.stringify(actual)}`);

console.log("\n=== YouTube, in every shape a browser hands over ===");
for (const input of [
  "https://www.youtube.com/watch?v=jd3vHxRwQT4",
  "https://youtu.be/jd3vHxRwQT4",
  "https://www.youtube.com/shorts/jd3vHxRwQT4",
  "https://www.youtube.com/embed/jd3vHxRwQT4",
  "youtube.com/watch?v=jd3vHxRwQT4&t=42s",
  "https://m.youtube.com/watch?v=jd3vHxRwQT4",
]) {
  const link = parseStyleLink(input);
  t(input.replace("https://", ""), link?.platform === "youtube" && link.id === "jd3vHxRwQT4",
    link ? `${link.platform}/${link.id}` : "not recognised");
}

const yt = parseStyleLink("https://youtu.be/jd3vHxRwQT4")!;
eq("normalised to one canonical watch URL", yt.url, "https://www.youtube.com/watch?v=jd3vHxRwQT4");
eq("thumbnail is hqdefault, which always exists", yt.thumbnailUrl,
  "https://i.ytimg.com/vi/jd3vHxRwQT4/hqdefault.jpg");
// maxresdefault would be sharper and 404s for videos that never got one, which
// renders as a broken image in the gallery.
t("and not maxresdefault", !yt.thumbnailUrl!.includes("maxres"));

console.log("\n=== Instagram posts and reels ===");
const post = parseStyleLink("https://www.instagram.com/p/CxYz123abc/?igsh=trackingjunk");
eq("a post normalises and loses the tracking parameters", post?.url,
  "https://www.instagram.com/p/CxYz123abc/");
const reel = parseStyleLink("https://instagram.com/reel/CxYz123abc/");
eq("a reel stays a reel", reel?.url, "https://www.instagram.com/reel/CxYz123abc/");
eq("reels/ collapses to reel/", parseStyleLink("https://www.instagram.com/reels/CxYz123abc")?.url,
  "https://www.instagram.com/reel/CxYz123abc/");
eq("tv/ is kept", parseStyleLink("https://www.instagram.com/tv/CxYz123abc/")?.url,
  "https://www.instagram.com/tv/CxYz123abc/");
t("Instagram has no thumbnail, by decision", reel?.thumbnailUrl === null,
  "oEmbed needs a reviewed Meta app; the gallery shows a card instead");

console.log("\n=== what is refused ===");
for (const [what, input] of [
  ["a profile, not a post", "https://www.instagram.com/thewovenne/"],
  ["a bare Instagram domain", "https://instagram.com"],
  ["someone's stories", "https://www.instagram.com/stories/thewovenne/12345/"],
  ["a near-miss YouTube id", "https://youtu.be/tooshort"],
  ["a YouTube channel", "https://www.youtube.com/@thewovenne"],
  ["TikTok, which we do not accept", "https://www.tiktok.com/@x/video/123"],
  ["a plain website", "https://example.com/photo.jpg"],
  ["nothing at all", ""],
  ["whitespace", "   "],
  ["not a URL", "my photo"],
] as const) {
  t(what, parseStyleLink(input) === null, parseStyleLink(input) ? "ACCEPTED" : "");
}

console.log("\n=== guidance is guidance, not a gate ===");
t("a narrow portrait is flagged as soft", isBelowComfortable(640, 800),
  "640 across a column that wants 800+");
t("but 1200×1500 is not", !isBelowComfortable(1200, 1500));
// The case that caught the first version of this: judged on the longest edge,
// a 640×800 portrait passed because 800 is not below 800 — while the width, the
// dimension a gallery column actually constrains, was well under.
t("a wide landscape of the same height is fine", !isBelowComfortable(1200, 800),
  "height is free to be short; width is what gets stretched");
t("the recommended shape is portrait", PHOTO_GUIDANCE.recommendedHeight > PHOTO_GUIDANCE.recommendedWidth,
  "people are taller than they are wide");
t("a video-only submission is never called soft", !isBelowComfortable(null, null));
t("HEIC is accepted by the picker", PHOTO_GUIDANCE.acceptAttribute.includes("heic"),
  "it is re-encoded to JPEG in the browser, never stored as HEIC");
t("the help text quotes the real numbers", PHOTO_GUIDANCE.help.includes("1200×1500")
  && PHOTO_GUIDANCE.help.includes("8MB"));
t("and does not read as a requirement", /perfect|doesn't need/.test(PHOTO_GUIDANCE.help),
  "the copy has to invite a phone photo, not audition one");
t("the max upload width is above the recommended one",
  PHOTO_GUIDANCE.maxUploadWidth > PHOTO_GUIDANCE.recommendedWidth);

console.log("\n=== button copy ===");
eq("youtube", watchLabel("youtube"), "Watch on YouTube");
eq("instagram", watchLabel("instagram"), "Watch on Instagram");
t("the link help names both platforms and rules out profiles",
  /Instagram/.test(LINK_HELP) && /YouTube/.test(LINK_HELP) && /profile/.test(LINK_HELP));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
