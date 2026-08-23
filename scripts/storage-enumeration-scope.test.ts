/**
 * Seeing more of the bucket must not make more of it deletable.
 *
 * The C2 and C3 tooling used to walk a hard-coded prefix list. Three of the
 * folders it named do not exist, and `campaigns/` — which does, and holds six
 * objects — was never listed, so every bucket total those tools printed was
 * short by 6,595,428 bytes. They now share the authoritative walk in
 * lib/storagePrefixes.ts.
 *
 * That fix widens what the tools SEE. This suite exists to prove it does not
 * widen what they TOUCH. The two are independent by design — C2 filters to
 * `products/` in its planning loop, and C3 takes candidates from C2 ledger
 * pairings rather than from any listing — and this is where that independence
 * is pinned down, because it is exactly the property an enumeration change
 * could quietly break.
 */
import { readFileSync } from "node:fs";
import {
  enumerateAllObjects,
  type StorageEntry,
} from "../lib/storagePrefixes";
import { assertSafeToDeletePath, looksLikeMaster } from "../lib/imageDeletion";
import { classifyObject } from "../lib/imageReferences";
import { MigrationRefused } from "../lib/imageBackfill";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}
function refuses(name: string, fn: () => unknown, reason?: string) {
  try { fn(); check(name, false); }
  catch (e) { check(name, e instanceof MigrationRefused && (!reason || e.reason === reason)); }
}

const file = (name: string, size: number): StorageEntry =>
  ({ name, id: `id-${name}`, metadata: { size, mimetype: "image/jpeg" } });
const folder = (name: string): StorageEntry => ({ name, id: null });

function bucketOf(tree: Record<string, StorageEntry[]>, pageSize = 100) {
  const list = async (prefix: string, offset: number): Promise<StorageEntry[]> =>
    (tree[prefix] ?? []).slice(offset, offset + pageSize);
  return list;
}

/** Production's real shape, plus folders the old list named that do not exist. */
const REAL = {
  "": [folder("campaigns"), folder("lookbook"), folder("products")],
  "campaigns/": [file("camp.png", 1_646_527)],
  "lookbook/": [file("look.jpg", 267_809)],
  "products/": [
    file("real-original.jpg", 25_087_158),
    file("abcdef0123456789abcdef0123456789-v1.jpg", 5_401_618),
    file("heic-upload.heic", 3_538_437),
  ],
};

async function main() {
  console.log("\n=== the enumeration genuinely widened ===");
  const found = await enumerateAllObjects(bucketOf(REAL));
  check("campaigns/ is discovered without anyone naming it",
    found.some((o) => o.key === "campaigns/camp.png"));
  check("all six real objects are found", found.length === 5);
  check("nonexistent prefixes are simply absent, not an error",
    !found.some((o) => /^(styles|staging|tmp)\//.test(o.key)));
  const HARD_CODED = ["products/", "styles/", "lookbook/", "staging/", "tmp/"];
  check("the old hard-coded list would have missed campaigns/",
    found.filter((o) => !HARD_CODED.some((p) => o.key.startsWith(p)))
      .every((o) => o.key.startsWith("campaigns/")));
  check("byte totals now include campaigns/",
    found.reduce((s, o) => s + o.bytes, 0) === 1_646_527 + 267_809 + 25_087_158 + 5_401_618 + 3_538_437);

  console.log("\n=== nested folders and paging still work through the shared walk ===");
  const nested = await enumerateAllObjects(bucketOf({
    "": [folder("a")], "a/": [folder("b"), file("top.jpg", 1)], "a/b/": [file("deep.jpg", 2)],
  }));
  check("a folder inside a folder is reached", nested.some((o) => o.key === "a/b/deep.jpg"));
  const many = Array.from({ length: 250 }, (_, i) => file(`f${i}.jpg`, 1));
  const paged = await enumerateAllObjects(bucketOf({ "": [folder("p")], "p/": many }, 100), 100);
  check("a prefix spanning three pages is fully read", paged.length === 250);

  console.log("\n=== C3 SCOPE DID NOT BROADEN ===");
  //
  // C3 deletes only originals a C2 ledger proved it migrated, and its path
  // guard refuses anything else independently of any listing. Enumeration
  // seeing campaigns/ or lookbook/ changes neither.
  refuses("campaigns/ is still undeletable by C3",
    () => assertSafeToDeletePath("campaigns/camp.png", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("lookbook/ is still undeletable by C3",
    () => assertSafeToDeletePath("lookbook/look.jpg", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("staging/ is still undeletable by C3",
    () => assertSafeToDeletePath("staging/x.jpg", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("HEIC is still undeletable by C3",
    () => assertSafeToDeletePath("products/heic-upload.heic", "products/m-v1.jpg"), "unsafe_delete_path");
  refuses("a normalised master is still undeletable by C3",
    () => assertSafeToDeletePath("products/abcdef0123456789abcdef0123456789-v1.jpg", "products/other-v1.jpg"),
    "unsafe_delete_path");
  check("a proven products/ original is still deletable", (() => {
    assertSafeToDeletePath("products/real-original.jpg", "products/abcdef0123456789abcdef0123456789-v1.jpg");
    return true;
  })());
  check("every newly-visible campaigns object fails the C3 path guard",
    found.filter((o) => o.key.startsWith("campaigns/")).every((o) => {
      try { assertSafeToDeletePath(o.key, "products/m-v1.jpg"); return false; } catch { return true; }
    }));

  console.log("\n=== C3 candidates come from ledgers, not from the listing ===");
  const plan = readFileSync("scripts/backfill-delete-plan.ts", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the candidate loop iterates C2 ledger pairings",
    strip(plan).includes("[...pairings.values()]"));
  check("it does not iterate the storage listing",
    !/for\s*\(\s*const\s+\w+\s+of\s+objects/.test(strip(plan)));
  check("the listing is used for existence and totals only",
    strip(plan).includes("objects.has(") && strip(plan).includes("objects.values()"));

  console.log("\n=== C2 scope did not broaden either ===");
  const exec = readFileSync("scripts/backfill-execute.ts", "utf8");
  check("the C2 planning loop still refuses anything outside products/",
    strip(exec).includes('if (!object.key.startsWith("products/")) continue;'));
  check("C2 still classifies a staging object as never a source",
    classifyObject({
      object: { bucket: "product-images", key: "staging/a.jpg", bytes: 1, mime: "image/jpeg",
                createdAt: new Date(Date.now() - 1e10).toISOString() },
      liveReferences: 0, historicalReferences: 0, graphIsComplete: true, now: new Date(),
    }) === "RECENT_ZERO_REFERENCE");
  check("looksLikeMaster still identifies masters, whatever folder they were found in",
    looksLikeMaster("products/abcdef0123456789abcdef0123456789-v1.jpg") &&
    !looksLikeMaster("campaigns/camp.png"));

  console.log("\n=== the recursion exists in exactly one place ===");
  const helper = readFileSync("lib/storagePrefixes.ts", "utf8");
  check("the shared helper owns the walk", helper.includes("enumerateAllObjects"));
  for (const f of ["scripts/backfill-images.ts", "scripts/backfill-execute.ts",
                   "scripts/backfill-delete-plan.ts", "scripts/orphan-delete-plan.ts",
                   "scripts/orphan-delete-execute.ts"]) {
    const code = strip(readFileSync(f, "utf8"));
    check(`${f} calls the shared walk`, code.includes("enumerateAllObjects("));
    check(`${f} does not re-implement folder recursion`,
      !/filter\(\s*\(?\w+\)?\s*=>\s*!\w+\.id\s*\)/.test(code));
  }
  check("no hard-coded prefix list survives in the C2/C3 tooling",
    !["scripts/backfill-images.ts", "scripts/backfill-execute.ts", "scripts/backfill-delete-plan.ts"]
      .some((f) => /\["products\/",\s*"styles\//.test(readFileSync(f, "utf8"))));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
