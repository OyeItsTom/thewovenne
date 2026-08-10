/**
 * The order tool: who can see what.
 *
 *   npx tsx scripts/order-tool.test.ts
 *
 * This is the security test for the only privileged thing the concierge can do.
 * Everything else it reads is public; this reads orders, which are not — so the
 * assertions here are about the boundary rather than the formatting:
 *
 *   - a guest is not offered the tool AT ALL, rather than offered one that
 *     refuses. A tool in the list is a tool that gets tried;
 *   - the email is closed over from the session, never taken from the call, so
 *     one customer's session cannot reach another customer's order;
 *   - the short reference customers actually quote resolves, which the old
 *     full-uuid lookup could never do.
 *
 * It runs against the real orders table with the service key, because that is
 * what the tool does. It only reads.
 */
import fs from "node:fs";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const { chatToolsFor, runOrderTool } = await import("../lib/chat");
  const { createServiceClient } = await import("../lib/supabase");
  const { orderRef } = await import("../lib/orders");

  let pass = 0;
  let fail = 0;
  let notes = 0;
  const t = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (ok) pass++;
    else fail++;
  };
  const note = (text: string) => {
    console.log(`  NOTE  ${text}`);
    notes++;
  };

  console.log("\n=== a guest is not offered the tool ===");
  const guestTools = chatToolsFor(null).map((x) => x.name);
  const customerTools = chatToolsFor("someone@example.com").map((x) => x.name);
  t("a guest gets four tools", guestTools.length === 4, guestTools.join(", "));
  t("and none of them is get_my_order", !guestTools.includes("get_my_order"));
  t("a signed-in customer gets five", customerTools.length === 5, customerTools.join(", "));
  t("the fifth being get_my_order", customerTools.includes("get_my_order"));
  t(
    "an empty-string email is treated as absent",
    chatToolsFor("").length === 4,
    "no session means no tool, and '' is not a session"
  );

  console.log("\n=== the tool takes no email argument ===");
  const tool = chatToolsFor("x@y.z").find((x) => x.name === "get_my_order")!;
  const props = Object.keys(
    (tool.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
  );
  t("its only parameter is the reference", JSON.stringify(props) === JSON.stringify(["reference"]), props.join(", "));
  t(
    "so there is no argument that could name another customer",
    !props.some((p) => /mail|customer|user/i.test(p))
  );

  // ── Against the real table ──
  const db = createServiceClient();
  const { data } = await db
    .from("orders")
    .select("id, customer_email")
    .not("customer_email", "is", null)
    .limit(1);
  const real = (data ?? [])[0] as { id: string; customer_email: string } | undefined;

  if (!real) {
    note("no order with an email address to test against — skipping the live assertions");
  } else {
    const ref = orderRef(real.id);
    console.log(`\n=== ${real.customer_email}'s own order (${ref}) ===`);

    const own = await runOrderTool(real.customer_email, {});
    t("listing with no reference finds their order", own.found === true);
    t("and names it by the short reference", own.text.includes(ref), ref);

    const byShort = await runOrderTool(real.customer_email, { reference: ref });
    t(`the short reference resolves (${ref})`, byShort.found === true,
      "the old full-uuid lookup could not match this");
    const byLower = await runOrderTool(real.customer_email, { reference: ref.toLowerCase() });
    t("lower-cased too, since people retype it", byLower.found === true);
    const byFull = await runOrderTool(real.customer_email, { reference: real.id });
    t("and so does the full id", byFull.found === true);

    const wrongRef = await runOrderTool(real.customer_email, { reference: "ZZZZ9999" });
    t("a reference of theirs that does not exist is refused", wrongRef.found === false);
    t("and it does not guess which order they meant", wrongRef.text.toLowerCase().includes("do not guess"));

    console.log("\n=== somebody else's session cannot reach it ===");
    const other = await runOrderTool("definitely-not-a-customer@example.invalid", {});
    t("an unrelated email sees no orders", other.found === false, other.text.slice(0, 60) + "…");
    const probing = await runOrderTool("definitely-not-a-customer@example.invalid", {
      reference: ref,
    });
    t(
      "and cannot reach a known reference belonging to someone else",
      probing.found === false && !probing.text.includes(real.customer_email),
      "the reference is filtered over rows already pinned to the caller's email"
    );
    t(
      "the refusal leaks nothing about the other customer",
      !probing.text.includes(real.id) && !probing.text.includes(ref),
      "no id, no reference, no total"
    );

    console.log("\n=== what it tells the model about a cancelled order ===");
    const cancelled = own.text.includes("Cancelled on");
    if (cancelled) {
      t(
        "a cancelled order carries the do-not-promise-a-refund instruction",
        own.text.includes("Do NOT tell them the refund has been paid"),
        "the money moving is not visible from here"
      );
    } else {
      note("no cancelled order among these — that instruction is untested against real data");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${notes} note(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
