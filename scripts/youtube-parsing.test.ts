/**
 * YouTube URL parsing. The admin pastes whatever the browser gave them, which
 * is one of at least five shapes — and storing the wrong thing produces a
 * product page with a dead player on it.
 *
 *   npx tsx scripts/youtube-parsing.test.ts
 */
import { youtubeId } from "../lib/youtube";
let pass=0,fail=0;
const t=(n:string,a:unknown,e:unknown)=>{const ok=a===e;console.log(`  ${ok?"PASS":"FAIL"}  ${n}`);if(!ok)console.log(`        got ${JSON.stringify(a)} want ${JSON.stringify(e)}`);ok?pass++:fail++;};
const ID="dQw4w9WgXcQ";
console.log("\n=== the shapes a browser actually gives you ===");
t("watch?v=", youtubeId(`https://www.youtube.com/watch?v=${ID}`), ID);
t("watch with extra params", youtubeId(`https://www.youtube.com/watch?v=${ID}&t=42s&list=PLabc`), ID);
t("youtu.be short link", youtubeId(`https://youtu.be/${ID}`), ID);
t("youtu.be with timestamp", youtubeId(`https://youtu.be/${ID}?t=42`), ID);
t("/shorts/", youtubeId(`https://www.youtube.com/shorts/${ID}`), ID);
t("/embed/", youtubeId(`https://www.youtube.com/embed/${ID}`), ID);
t("/live/", youtubeId(`https://www.youtube.com/live/${ID}`), ID);
t("m.youtube.com", youtubeId(`https://m.youtube.com/watch?v=${ID}`), ID);
t("no scheme pasted", youtubeId(`youtube.com/watch?v=${ID}`), ID);
t("a bare ID passes through", youtubeId(ID), ID);
t("whitespace trimmed", youtubeId(`  https://youtu.be/${ID}  `), ID);
console.log("\n=== refusals ===");
t("empty", youtubeId(""), null);
t("not a URL", youtubeId("have a look at my video"), null);
t("a different site", youtubeId("https://vimeo.com/123456789"), null);
t("youtube homepage, no video", youtubeId("https://www.youtube.com/"), null);
t("a channel page", youtubeId("https://www.youtube.com/@thewovenne"), null);
t("too-short id", youtubeId("https://youtu.be/abc123"), null);
t("id with an illegal character", youtubeId("https://youtu.be/dQw4w9WgX!Q"), null);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
