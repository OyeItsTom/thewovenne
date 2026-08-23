/**
 * The bucket walk, and the bug it exists to prevent.
 *
 * C2 and C3 listed a hard-coded prefix list. Three of the folders they named
 * do not exist, and `campaigns/` — which does, and holds six objects — was
 * never listed at all. Every bucket total those tools printed was short by
 * 6 objects and 6,595,428 bytes.
 *
 * These tests drive the walk with a fake bucket, so they assert the behaviour
 * that would have caught it: a folder nobody predicted is still found.
 */
import {
  MAX_PREFIX_DEPTH,
  StorageEnumerationRefused,
  enumerateAllObjects,
  type StorageEntry,
} from "../lib/storagePrefixes";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}

/** A fake bucket: prefix -> entries. Folders are entries with no id. */
function bucketOf(tree: Record<string, StorageEntry[]>, pageSize = 100) {
  const calls: string[] = [];
  const list = async (prefix: string, offset: number): Promise<StorageEntry[]> => {
    calls.push(prefix);
    return (tree[prefix] ?? []).slice(offset, offset + pageSize);
  };
  return { list, calls };
}
const file = (name: string, size: number): StorageEntry =>
  ({ name, id: `id-${name}`, metadata: { size, mimetype: "image/jpeg" } });
const folder = (name: string): StorageEntry => ({ name, id: null });

async function main() {
  console.log("\n=== the real shape of this bucket ===");
  //
  // Exactly what production has: three folders, one of which the old
  // hard-coded list never named.
  const real = bucketOf({
    "": [folder("campaigns"), folder("lookbook"), folder("products")],
    "campaigns/": [file("a.png", 1_646_527), file("b.jpg", 223_504)],
    "lookbook/": [file("c.jpg", 267_809)],
    "products/": [file("d.jpg", 25_087_158), file("e-v1.jpg", 5_401_618)],
  });
  const found = await enumerateAllObjects(real.list);
  check("every object is found across all three folders", found.length === 5);
  check("campaigns/ is found without anyone naming it",
    found.some((o) => o.key === "campaigns/a.png"));
  check("keys are full paths from the bucket root",
    found.every((o) => /^(campaigns|lookbook|products)\//.test(o.key)));
  check("byte totals are complete",
    found.reduce((s, o) => s + o.bytes, 0) === 1_646_527 + 223_504 + 267_809 + 25_087_158 + 5_401_618);
  check("the root itself is listed", real.calls.includes(""));
  check("metadata is carried through",
    found.find((o) => o.key === "campaigns/a.png")?.mimetype === "image/jpeg");

  console.log("\n=== the regression: a hard-coded list misses folders ===");
  const HARD_CODED = ["products/", "styles/", "lookbook/", "staging/", "tmp/"];
  const missed = found.filter((o) => !HARD_CODED.some((p) => o.key.startsWith(p)));
  check("the old prefix list would have missed campaigns/ entirely",
    missed.length === 2 && missed.every((o) => o.key.startsWith("campaigns/")));
  check("and the walk does not depend on that list at all",
    !JSON.stringify(found).includes("staging") && !JSON.stringify(found).includes("tmp"));

  console.log("\n=== nesting, paging and pathological shapes ===");
  const nested = bucketOf({
    "": [folder("a")],
    "a/": [folder("b"), file("top.jpg", 1)],
    "a/b/": [file("deep.jpg", 2)],
  });
  const deep = await enumerateAllObjects(nested.list);
  check("nested folders are walked", deep.length === 2 && deep.some((o) => o.key === "a/b/deep.jpg"));

  const many = Array.from({ length: 250 }, (_, i) => file(`f${i}.jpg`, 1));
  const paged = bucketOf({ "": [folder("p")], "p/": many }, 100);
  const all = await enumerateAllObjects(paged.list, 100);
  check("paging continues past the first page", all.length === 250);
  check("and stops on a short page", paged.calls.filter((c) => c === "p/").length === 3);

  const cyclic = bucketOf({ "": [folder("x")], "x/": [folder("x"), file("one.jpg", 1)], "x/x/": [file("two.jpg", 1)] });
  const cyc = await enumerateAllObjects(cyclic.list);
  check("a folder that appears to contain itself does not loop", cyc.length === 2);

  const dupes = bucketOf({ "": [file("same.jpg", 5), file("same.jpg", 5)] });
  check("a repeated key is counted once", (await enumerateAllObjects(dupes.list)).length === 1);

  const empty = bucketOf({ "": [] });
  check("an empty bucket yields nothing", (await enumerateAllObjects(empty.list)).length === 0);

  const junk = bucketOf({ "": [{ name: "", id: "x" } as StorageEntry, file("ok.jpg", 1)] });
  check("an entry with no name is skipped", (await enumerateAllObjects(junk.list)).length === 1);

  console.log("\n=== it refuses rather than crawling forever ===");
  const tree: Record<string, StorageEntry[]> = { "": [folder("d0")] };
  let path = "d0/";
  for (let i = 1; i <= MAX_PREFIX_DEPTH + 3; i++) { tree[path] = [folder(`d${i}`)]; path += `d${i}/`; }
  let refused = false;
  try { await enumerateAllObjects(bucketOf(tree).list); }
  catch (e) { refused = e instanceof StorageEnumerationRefused && e.reason === "prefix_too_deep"; }
  check(`deeper than ${MAX_PREFIX_DEPTH} levels is refused, not looped`, refused);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
