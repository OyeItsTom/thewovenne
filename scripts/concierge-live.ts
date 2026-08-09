/**
 * Ask Wovenne, for real, from the terminal.
 *
 *   npx tsx scripts/concierge-live.ts "do you have anything in cotton?"
 *
 * THIS SPENDS MONEY AND HITS THE LIVE MODEL. It is here because the tool loop
 * cannot be proven any other way: the executors are covered headlessly in
 * scripts/chat-tools.test.ts, but whether the model actually *reaches for* them —
 * rather than answering from the index and its own memory — is a property of the
 * prompt and the model, not of the code, and it is the single thing this upgrade
 * is for.
 *
 * It prints which tools were called, in order, then the reply. Run it after any
 * edit to the system prompt or a tool description; a change that reads like an
 * improvement and quietly stops the lookups happening is the failure mode.
 *
 * Nothing is written anywhere. No quota is consumed either — that lives in the
 * route, and this calls the core directly.
 */
import fs from "node:fs";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const { streamChat, chatConfigured, CHAT_MODEL } = await import("../lib/chat");

  if (!chatConfigured()) {
    console.error("ANTHROPIC_API_KEY is missing or not a real key.");
    process.exit(1);
  }

  const question =
    process.argv.slice(2).join(" ") ||
    "Is this real handloom from Kerala, and how should I wash it?";

  console.log(`model    : ${CHAT_MODEL}`);
  console.log(`question : ${question}\n`);

  const used: string[] = [];
  const started = Date.now();
  let reply = "";

  for await (const delta of streamChat([{ role: "user", content: question }], {
    onTool: (name, found) => {
      used.push(`${name}${found ? "" : " (nothing found)"}`);
      console.log(`  → ${name}${found ? "" : " — found nothing"}`);
    },
  })) {
    reply += delta;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n--- reply (${seconds}s, ${used.length} lookup(s)) ---\n${reply.trim()}\n`);

  if (used.length === 0) {
    console.log(
      "NO TOOLS WERE CALLED. For a question about stock, price, heritage or care that\n" +
        "is a regression: the model answered from the index or from memory. Check the\n" +
        "LOOK IT UP block in buildSystemPrompt and that thinking is adaptive, not disabled."
    );
  } else {
    console.log(`tools    : ${used.join(", ")}`);
  }
}

void main();
