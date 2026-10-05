/**
 * #181 Admin UX: status and message truthfulness.
 *
 *   npx tsx scripts/admin-ux.test.ts
 *
 * Plain script, like the others (no test runner, no DOM). It proves directly
 * what can be proved headlessly: the state model and every sentence it
 * produces (lib/adminStatus), and the verified draft write (lib/drafts)
 * against a fake Supabase client — zero rows, an error and a thrown fetch must
 * never come back as success. The component wiring (which message is shown
 * where, focus, keyboard reachability) is guarded as a source contract.
 *
 * Exits non-zero on failure.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  adminErrorMessage,
  checkDraftWrite,
  classifyError,
  deleteConfirmText,
  discardAllText,
  discardOneText,
  draftSavedMessage,
  factsFromVersions,
  isDirty,
  publishedMessage,
  statusBadges,
  statusSentence,
} from "../lib/adminStatus";
import { getPendingChanges, getPendingQueue, markPendingDelete, updateDraftVersion } from "../lib/drafts";
import type { PublicationFacts } from "../lib/types";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else {
    fail++;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}
const labels = (f: PublicationFacts) => statusBadges(f, "product").map((b) => b.label);
const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");
// Line comments first: one of them mentions image/*, which would otherwise
// open a "block comment" that swallows half the file.
const code = (s: string) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

async function main() {
  // ── 5–7. The states ──────────────────────────────────────────────────────
  console.log("\nStates");
  const LIVE: PublicationFacts = { hasPublished: true, hasDraft: false, pendingDelete: false, liveVisible: true };
  check("5. live, nothing waiting → Live", JSON.stringify(labels(LIVE)) === '["Live"]', labels(LIVE));
  check("   Live says customers can see it", statusBadges(LIVE, "product")[0].detail === "Customers can see this product.");
  const EDITED = { ...LIVE, hasDraft: true };
  check("6. live + draft → Live AND Unpublished changes", JSON.stringify(labels(EDITED)) === '["Live","Unpublished changes"]', labels(EDITED));
  check("   …which says customers see the live version meanwhile", /see the live version until you publish/.test(statusSentence(EDITED, "product")));
  const NEW: PublicationFacts = { hasPublished: false, hasDraft: true, pendingDelete: false, liveVisible: false };
  check("7. never published → Never published (only)", JSON.stringify(labels(NEW)) === '["Never published"]', labels(NEW));
  check("   …and says customers can't see it", /customers can't see this product/.test(statusSentence(NEW, "product")));
  check("   a never-published product is never called Live or Hidden", !labels(NEW).some((l) => l === "Live" || l === "Hidden"));
  const HIDDEN = { ...LIVE, liveVisible: false };
  check("   published but switched off → Hidden", JSON.stringify(labels(HIDDEN)) === '["Hidden"]', labels(HIDDEN));
  const HIDING = { ...LIVE, hasDraft: true };
  check("   live product hidden only in the draft is still Live (+ changes)", labels(HIDING)[0] === "Live");
  const DELETING = { ...LIVE, hasDraft: true, pendingDelete: true };
  check("   staged delete → Live + Deleting at next publish", JSON.stringify(labels(DELETING)) === '["Live","Deleting at next publish"]', labels(DELETING));
  check("   …which says it stays as it is until publish", /stays exactly as it is for customers until you publish/.test(statusSentence(DELETING, "product")));
  const NEW_DELETING = { ...NEW, pendingDelete: true };
  check("   never-published + delete says customers aren't affected", /customers aren't affected/.test(statusSentence(NEW_DELETING, "post")));
  check("   every badge has text (not colour alone)", [LIVE, EDITED, NEW, HIDDEN, DELETING, NEW_DELETING].every((f) => statusBadges(f, "x").every((b) => b.label.trim().length > 2 && b.detail.trim().length > 10)));

  const f1 = factsFromVersions([
    { state: "published", pending_delete: false, visible: true },
    { state: "draft", pending_delete: false, visible: false },
  ]);
  check("   factsFromVersions reads visibility from the PUBLISHED row, not the draft", f1.liveVisible === true && f1.hasDraft && f1.hasPublished, f1);
  const f2 = factsFromVersions([{ state: "draft", pending_delete: true, visible: true }]);
  check("   factsFromVersions: draft only → never published, pending delete", !f2.hasPublished && f2.pendingDelete && !f2.liveVisible, f2);
  check("   factsFromVersions: no rows → nothing", JSON.stringify(factsFromVersions([])) === JSON.stringify({ hasPublished: false, hasDraft: false, pendingDelete: false, liveVisible: false }));

  // ── 1. Save draft never implies publish ─────────────────────────────────
  console.log("\nSave draft");
  const saves = [
    draftSavedMessage({ noun: "product", name: "Kasavu Saree", hasPublished: true }),
    draftSavedMessage({ noun: "product", name: "Kasavu Saree", hasPublished: false }),
    draftSavedMessage({ noun: "product", name: "Kasavu Saree", hasPublished: true, settled: true }),
    draftSavedMessage({ noun: "post", name: "", hasPublished: false }),
  ];
  check("1. no save message says 'published'", saves.every((m) => !/published/i.test(m)), saves);
  check("   live item: customers still see the current live version", /Customers still see the current live version until you publish/.test(saves[0]), saves[0]);
  check("   never published: not visible to customers until you publish", /isn't visible to customers until you publish it/.test(saves[1]), saves[1]);
  check("   no-op save (settled) says nothing is waiting", /No changes to publish/.test(saves[2]), saves[2]);
  check("   blank name still reads as a sentence", saves[3].startsWith("Draft saved. This post"), saves[3]);
  check("   a never-published settled save does NOT claim it matches the live site", !/matches/.test(draftSavedMessage({ noun: "product", name: "X", hasPublished: false, settled: true })));

  // ── 2. Publish success only after genuine success ───────────────────────
  console.log("\nPublish");
  check("2. publish message says customers can now see it", publishedMessage({ name: "Kasavu Saree" }) === "Published “Kasavu Saree”. Customers can now see this version.");
  check("   publishing a staged delete says it is gone", /deleted from the site/.test(publishedMessage({ name: "X", pendingDelete: true })));
  const queue = code(read("components/admin/PublishQueue.tsx"));
  const publishFn = queue.slice(queue.indexOf("async function handlePublish"), queue.indexOf("if (loadFailed)"));
  check("   queue: publishedMessage sits after `await publishOne(` and before the catch", /await publishOne\([\s\S]*?\);[\s\S]*setNotice\(publishedMessage[\s\S]*\} catch/.test(publishFn));
  check("   queue: the catch never sets a success notice", !/catch[\s\S]*setNotice\(publishedMessage/.test(publishFn.slice(publishFn.indexOf("} catch"))));
  const bar = code(read("components/admin/PublishBar.tsx"));
  check("   bar: 'Published —' only after `await publishAll(`", /await publishAll\([\s\S]*?setState\("published"\)[\s\S]*?`Published —/.test(bar));
  check("   bar: a failed count is not shown as 'Everything is published'", /countFailed \?/.test(bar) && bar.indexOf("countFailed ?") < bar.indexOf("Everything is published"));

  // ── 3–4. Failed or zero-row writes never succeed ───────────────────────
  console.log("\nVerified writes");
  check("3. error → not ok", !checkDraftWrite({ error: { code: "42501", message: "permission denied for table product_versions" }, data: null }, "save this draft").ok);
  const zero = checkDraftWrite({ error: null, data: [] }, "save this draft");
  check("4. zero rows, no error → not ok (conflict)", !zero.ok && zero.reason === "conflict", zero);
  check("   two rows → not ok", !checkDraftWrite({ error: null, data: [{ id: "a" }, { id: "b" }] }, "x").ok);
  check("   null data → not ok", !checkDraftWrite({ error: null, data: null }, "x").ok);
  const one = checkDraftWrite({ error: null, data: [{ id: "a" }] }, "x");
  check("   exactly one row → ok, with the row", one.ok && one.row.id === "a");

  type Call = [string, ...unknown[]];
  function fakeClient(result: { data?: unknown; error?: unknown; throws?: boolean }) {
    const calls: Call[] = [];
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["from", "update", "eq", "select"]) {
      chain[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        if (m === "select") {
          return result.throws
            ? Promise.reject(new TypeError("Failed to fetch"))
            : Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
        }
        return chain;
      };
    }
    chain.rpc = (...a: unknown[]) => {
      calls.push(["rpc", ...a]);
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    };
    return { client: chain as never, calls };
  }

  const ok = fakeClient({ data: [{ id: "v1" }] });
  const okResult = await updateDraftVersion(ok.client, "product_versions", "v1", { name: "N" });
  check("   updateDraftVersion: one draft row → ok", okResult.ok);
  check("   …filters on state = 'draft' (never the live row)", ok.calls.some(([m, k, v]) => m === "eq" && k === "state" && v === "draft"));
  check("   …and on the version id", ok.calls.some(([m, k, v]) => m === "eq" && k === "id" && v === "v1"));
  const none = await updateDraftVersion(fakeClient({ data: [] }).client, "journal_versions", "v1", { title: "T" });
  check("   updateDraftVersion: zero rows → not ok", !none.ok && none.reason === "conflict");
  const denied = await updateDraftVersion(fakeClient({ error: { code: "42501", message: "new row violates row-level security policy for table \"journal_versions\"" } }).client, "journal_versions", "v1", {});
  check("   updateDraftVersion: RLS error → permission, no table name leaked", !denied.ok && denied.reason === "permission" && !/journal_versions|row-level/.test(denied.message), denied);
  const offline = await updateDraftVersion(fakeClient({ throws: true }).client, "category_versions", "v1", {});
  check("   updateDraftVersion: fetch throws → network failure, not a crash", !offline.ok && offline.reason === "network", offline);
  check("   markPendingDelete: zero rows → a message, not null (success)", (await markPendingDelete(fakeClient({ data: [] }).client, "product_versions", "v1")) !== null);
  check("   markPendingDelete: one row → null", (await markPendingDelete(fakeClient({ data: [{ id: "v1" }] }).client, "product_versions", "v1")) === null);

  let threw = false;
  try {
    await getPendingChanges(fakeClient({ error: { message: "boom" } }).client);
  } catch {
    threw = true;
  }
  check("   getPendingChanges throws on error (never a fake 'nothing pending')", threw);
  threw = false;
  try {
    await getPendingQueue(fakeClient({ error: { message: "boom" } }).client);
  } catch {
    threw = true;
  }
  check("   getPendingQueue throws on error (never 'Nothing waiting')", threw);

  console.log("\nError messages");
  check("   classify: 42501 → permission", classifyError({ code: "42501" }) === "permission");
  check("   classify: 'Only admins can edit products' (a RAISE) → permission, not blocked", classifyError({ code: "P0001", message: "Only admins can edit products" }) === "permission");
  check("   classify: PGRST116 → conflict", classifyError({ code: "PGRST116" }) === "conflict");
  check("   classify: 23505 → duplicate", classifyError({ code: "23505" }) === "duplicate");
  check("   classify: 23514 → validation", classifyError({ code: "23514" }) === "validation");
  check("   classify: 'Failed to fetch' → network", classifyError("TypeError: Failed to fetch") === "network");
  check("   classify: P0001 → blocked (our own sentence)", classifyError({ code: "P0001", message: "Publish its category first" }) === "blocked");
  check("   blocked reasons are shown as written", adminErrorMessage({ code: "P0001", message: "Publish its category first" }, "publish") === "Publish its category first");
  const internal = adminErrorMessage({ code: "42P01", message: 'relation "public.product_versions" does not exist' }, "save this draft");
  check("   unknown errors don't leak internals", !/relation|product_versions|42P01/.test(internal), internal);
  check("   …and say nothing changed + what to do", /nothing was changed/.test(internal) && /Try again/.test(internal));
  check("   every reason says nothing was changed or explains the refusal", (["permission", "conflict", "duplicate", "validation", "network"] as const).every((r) => {
    const sample = { permission: { code: "42501" }, conflict: { code: "PGRST116" }, duplicate: { code: "23505" }, validation: { code: "23514" }, network: "Failed to fetch" }[r];
    const m = adminErrorMessage(sample, "save this draft");
    return /^Couldn't save this draft/.test(m) && /(nothing was changed|Change it and try again)/i.test(m);
  }));
  check("   no message says 'Something went wrong'", !/something went wrong/i.test(read("lib/adminStatus.ts")));

  // ── 8. Unsaved changes ───────────────────────────────────────────────────
  console.log("\nUnsaved changes");
  const base = { name: "A", sizes: [{ label: "S", stock_quantity: 1 }] };
  check("8. still loading (null baseline) is never dirty", !isDirty(null, { name: "B" }));
  check("   untouched is not dirty", !isDirty(base, { name: "A", sizes: [{ label: "S", stock_quantity: 1 }] }));
  check("   key order doesn't count as a change", !isDirty(base, { sizes: [{ stock_quantity: 1, label: "S" }], name: "A" }));
  check("   a typed change is dirty", isDirty(base, { ...base, name: "AB" }));
  check("   a nested (size stock) change is dirty", isDirty(base, { ...base, sizes: [{ label: "S", stock_quantity: 2 }] }));
  check("   typing it back is clean again", !isDirty(base, { ...base, name: "A" }));
  check("   photo order counts", isDirty(["a", "b"], ["b", "a"]));

  const modal = code(read("components/admin/ProductModal.tsx"));
  check("   product modal: Modal closes through requestClose", /<Modal[\s\S]*?onClose=\{requestClose\}/.test(modal));
  check("   …which closes straight away when nothing changed", /const requestClose = \(\) => \{[\s\S]*?if \(!dirty\) \{\s*onClose\(\);/.test(modal));
  check("   …and asks with Keep editing / Discard changes when dirty", /Keep editing/.test(modal) && /Discard changes/.test(modal));
  check("   beforeunload only while open AND dirty", /if \(!isOpen \|\| !dirty\) return;[\s\S]*?beforeunload/.test(modal));
  check("   'Unsaved changes' shown only when dirty", /\{dirty && <span[^>]*>Unsaved changes/.test(modal));
  const journal = code(read("components/admin/JournalManager.tsx"));
  check("   journal: Cancel and Edit-another go through leaveEditor", /onClick=\{\(\) => leaveEditor\(closeEditor\)\}/.test(journal) && /leaveEditor\(\(\) => openEditor\(draftFrom\(post\)\)\)/.test(journal));
  check("   journal: beforeunload only when dirty", /if \(!dirty\) return;[\s\S]*?beforeunload/.test(journal));

  // ── 9. Destructive confirmations ────────────────────────────────────────
  console.log("\nConfirmations");
  const del = deleteConfirmText("product", "Kasavu Saree", true);
  check("9. delete (live): says WHEN and that customers keep it until then", /at the next publish/.test(del) && /stays on the site until you publish/.test(del), del);
  const delNew = deleteConfirmText("post", "Draft post", false);
  check("   delete (never published): customers aren't affected", /never published, so customers aren't affected/.test(delNew), delNew);
  check("   discard one (live): live version stays as it is", /live version customers see stays exactly as it is/.test(discardOneText("X", false)));
  check("   discard one (new): removed completely", /removed completely/.test(discardOneText("X", true)));
  check("   discard all: can't be undone, customers unaffected", /can't be undone/.test(discardAllText(3)) && /Customers aren't affected/.test(discardAllText(3)));
  check("   discard all: singular", /1 unpublished change\?/.test(discardAllText(1)));
  check("   journal delete now asks first (no one-click delete)", /onClick=\{\(\) => setConfirmDelete\(post\.id\)\}/.test(journal) && !/onClick=\{\(\) => remove\(post\.id\)\}/.test(journal));
  for (const [file, src] of [
    ["ProductTable", code(read("components/admin/ProductTable.tsx"))],
    ["CategoryManager", code(read("components/admin/CategoryManager.tsx"))],
    ["JournalManager", journal],
  ] as const) {
    check(`   ${file}: confirmation uses deleteConfirmText`, /deleteConfirmText\(/.test(src));
    check(`   ${file}: Cancel takes focus when the question appears`, /autoFocus[\s\S]{0,80}Cancel|autoFocus\s+onClick=\{[^}]*\}[\s\S]{0,120}Cancel/.test(src));
  }
  check("   product table: a staged delete keeps the row (page re-reads, no filter-out)", !/prev\.filter\(\(p\) => p\.id !== id\)/.test(read("app/(admin)/admin/dashboard/products/page.tsx")));

  // ── 10. Keyboard / focus / announcements ────────────────────────────────
  console.log("\nKeyboard and focus");
  check("10. product photo input is focusable (sr-only, not display:none)", /type="file"[\s\S]*?className="sr-only"/.test(modal) && !/type="file"[\s\S]{0,400}className="hidden"/.test(modal));
  check("    journal image input is focusable too", /type="file"[^>]*className="sr-only"/.test(journal));
  check("    file labels show a focus ring", /focus-within:ring-2/.test(modal) && /focus-within:ring-2/.test(journal));
  check("    unsaved-changes question takes focus on Keep editing", /if \(confirmClose\) keepEditingRef\.current\?\.focus\(\)/.test(modal) && /if \(pendingLeave\) keepEditingRef\.current\?\.focus\(\)/.test(journal));
  const stock = code(read("components/admin/StockEditor.tsx"));
  check("    stock editor: Enter saves, Escape cancels", /e\.key === "Enter"[\s\S]*?handleSave/.test(stock) && /e\.key === "Escape"[\s\S]*?close\(\)/.test(stock));
  check("    stock editor: focus returns to the count after save/cancel", /openerRef\.current\?\.focus\(\)/.test(stock));
  check("    stock editor: controls name the product", /aria-label=\{`Stock\$\{of\}`\}/.test(stock) && /Save stock\$\{of\}/.test(stock));
  for (const [file, src] of [
    ["ProductModal", modal],
    ["ProductTable", code(read("components/admin/ProductTable.tsx"))],
    ["CategoryManager", code(read("components/admin/CategoryManager.tsx"))],
    ["JournalManager", journal],
    ["PublishBar", bar],
    ["PublishQueue", queue],
  ] as const) {
    check(`    ${file}: errors are announced (role="alert")`, /role="alert"/.test(src));
  }
  for (const [file, src] of [
    ["products page", read("app/(admin)/admin/dashboard/products/page.tsx")],
    ["ProductTable", read("components/admin/ProductTable.tsx")],
    ["CategoryManager", read("components/admin/CategoryManager.tsx")],
    ["JournalManager", journal],
    ["PublishQueue", queue],
  ] as const) {
    // Always rendered (sr-only when empty), so the first notice is heard.
    check(`    ${file}: outcome notice is a live region that is always present`, /<p role="status" className=\{notice \?[^}]*: "sr-only"\}/.test(src));
  }

  console.log("\nWording");
  check("   product Save button says Save draft", /\{saving \? "Saving draft…" : "Save draft"\}/.test(modal));
  check("   journal Save button says Save draft", /"Save draft"/.test(journal) && !/Save post/.test(journal));
  check("   journal flag is 'Show on the site', not 'Published (visible on the site)'", /Show on the site/.test(journal) && !/Published \(visible on the site\)/.test(journal));
  check("   product table no longer says 'Out' or 'Active'", !/>\s*Out\s*</.test(read("components/admin/ProductTable.tsx")) && !/"Active"/.test(read("components/admin/ProductTable.tsx")));
  check("   no raw saveError.message in the product modal", !/saveError\.message/.test(modal));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

void main();
