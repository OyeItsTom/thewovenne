/**
 * Delivery-sized copies for photographs already in the catalogue.
 *
 *   # What would happen (the default — reads only, uploads nothing):
 *   npx tsx --env-file=.env.local scripts/image-derivatives-backfill.ts
 *
 *   # Do one batch (default 10, max 50) of the ACTIVE tiers (lib/imageVariants;
 *   # w1080 only since 13 Oct 2026):
 *   npx tsx --env-file=.env.local scripts/image-derivatives-backfill.ts --execute --limit 10
 *
 *   # Exactly one photograph:
 *   npx tsx --env-file=.env.local scripts/image-derivatives-backfill.ts --execute \
 *     --only products/abc-v1.jpg
 *
 *   # Choose tiers explicitly (e.g. once w1920 is approved):
 *   ... --execute --limit 10 --tiers w1920
 *
 *   # Before 0071 is applied: make and verify the objects, register nothing.
 *   ... --execute --only products/abc-v1.jpg --objects-only
 *
 *   # Keep the downloaded source on disk (for a side-by-side quality check),
 *   # so it never has to be fetched a second time:
 *   ... --keep-source <dir>
 *
 * WHAT IT READS, WITHOUT EGRESS. Every stored product image URL, the bucket's
 * catalogue (storage.objects) and the registry (public.image_derivatives), over
 * SQL in a READ ONLY transaction. No image is fetched to plan.
 *
 * WHAT IT DOES PER PHOTOGRAPH, with --execute. Downloads the source ONCE, with
 * the service role through the authenticated object route, builds the requested tiers
 * (lib/imageDerivatives — the same code the admin upload route runs), uploads
 * each under its new derived/ name with upsert:false, proves each by a one-byte
 * ranged GET against its MD5, and inserts the registry rows ON CONFLICT DO
 * NOTHING. The source is never written, moved or deleted. No product row,
 * cart, order or page is touched.
 *
 * RESUMABLE AND IDEMPOTENT. A photograph whose tiers are already registered for
 * the current recipe is skipped without a download. An object that already
 * exists is accepted only when it is proven to be the same bytes. Stop it at
 * any point and run it again.
 *
 * Every outcome is appended to reports/image-derivatives/ledger.ndjson.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeAndStoreDerivatives } from "../lib/imageDerivatives";
import { ACTIVE_TIERS, IMAGE_BUCKET, parseTiers, type DerivedTier } from "../lib/imageVariants";
import {
  parseLimit,
  planBackfill,
  type RegistryEntry,
  type SourceObject,
} from "../lib/imageDerivativeBackfill";

const require = createRequire(import.meta.url);
const { Client } = require("pg") as typeof import("pg");

const LEDGER_DIR = "reports/image-derivatives";
const KB = (n: number) => `${Math.round(n / 1024).toLocaleString("en-GB")} KB`;
const MB = (n: number) => `${(n / 1048576).toFixed(2)} MB`;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (run with --env-file=.env.local)`);
  return value;
}

function parseArgs(argv: string[]) {
  const args = {
    execute: false,
    objectsOnly: false,
    only: [] as string[],
    limit: undefined as string | undefined,
    keepSource: undefined as string | undefined,
    tiers: ACTIVE_TIERS as readonly DerivedTier[],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
    else if (a === "--dry-run") args.execute = false;
    else if (a === "--objects-only") args.objectsOnly = true;
    else if (a === "--only") args.only.push(argv[++i] ?? "");
    else if (a === "--limit") args.limit = argv[++i];
    else if (a === "--keep-source") args.keepSource = argv[++i];
    else if (a === "--tiers") args.tiers = parseTiers(argv[++i] ?? "");
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { ...args, limitN: parseLimit(args.limit) };
}

async function readFacts() {
  const db = new Client({ connectionString: env("SUPABASE_DB_URL"), ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query("begin read only");
    const refs = await db.query<{ url: string }>(`
      select url from public.product_images where url is not null
      union all select image_url from public.products where image_url is not null
      union all select image_url from public.product_versions
                 where image_url is not null and state in ('published', 'draft')`);
    const objects = await db.query<{ key: string; bytes: string | null; mime: string | null }>(`
      select name as key, (metadata->>'size') as bytes, metadata->>'mimetype' as mime
        from storage.objects where bucket_id = $1`, [IMAGE_BUCKET]);
    const hasRegistry =
      (await db.query<{ ok: boolean }>(`select to_regclass('public.image_derivatives') is not null as ok`)).rows[0].ok;
    const registry = hasRegistry
      ? (await db.query<RegistryEntry>(`select source_path, tier, recipe, status from public.image_derivatives`)).rows
      : [];
    await db.query("rollback");
    return {
      referencedUrls: refs.rows.map((r) => r.url),
      objects: objects.rows.map<SourceObject>((o) => ({ key: o.key, bytes: o.bytes ? Number(o.bytes) : null, mime: o.mime })),
      registry,
      hasRegistry,
    };
  } finally {
    await db.end();
  }
}

/** Stands in for the registry client in --objects-only: records why nothing was registered. */
function skippedRegistry(): SupabaseClient {
  return {
    from: () => ({
      upsert: async () => ({ error: { message: "not registered: --objects-only (0071 not applied yet)" } }),
    }),
  } as unknown as SupabaseClient;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const facts = await readFacts();

  const plan = planBackfill({
    referencedUrls: facts.referencedUrls,
    objects: facts.objects,
    registry: facts.registry,
    only: args.only,
    limit: args.limitN,
    tiers: args.tiers,
  });

  console.log(`tiers: ${args.tiers.join(", ")}`);
  console.log(`registry: ${facts.hasRegistry ? `present (${facts.registry.length} rows)` : "ABSENT — 0071 not applied"}`);
  console.log(
    `sources: ${plan.items.length} referenced — done ${plan.counts.done}, to build ${plan.counts.build}, ` +
      `missing ${plan.counts.missing_source}, unsupported ${plan.counts.unsupported}` +
      (plan.unrecognised.length ? `; ${plan.unrecognised.length} stored URL(s) not in this bucket, ignored` : "")
  );
  for (const item of plan.items.filter((i) => i.action === "missing_source" || i.action === "unsupported")) {
    console.log(`  ${item.action}: ${item.sourceKey}`);
  }
  console.log(
    `this run: ${plan.selected.length} source(s), ~${MB(plan.downloadBytes)} to download` +
      (args.execute ? "" : "  [DRY RUN — nothing downloaded or uploaded]")
  );
  for (const item of plan.selected) {
    console.log(`  ${item.sourceKey}  ${item.bytes ? MB(item.bytes) : "?"}  tiers: ${item.pendingTiers.join(", ")}`);
  }
  if (!args.execute || plan.selected.length === 0) return;

  if (!facts.hasRegistry && !args.objectsOnly) {
    throw new Error("The registry (0071) is not applied. Apply it first, or pass --objects-only to make and verify objects without registering them.");
  }

  const service = createClient(supabaseUrl, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const registry = facts.hasRegistry && !args.objectsOnly ? service : skippedRegistry();
  mkdirSync(LEDGER_DIR, { recursive: true });
  const ledger = `${LEDGER_DIR}/ledger.ndjson`;

  let downloaded = 0;
  let uploaded = 0;
  let problems = 0;
  for (const [index, item] of plan.selected.entries()) {
    const tag = `[${index + 1}/${plan.selected.length}] ${item.sourceKey}`;
    const { data, error } = await service.storage.from(IMAGE_BUCKET).download(item.sourceKey);
    if (error || !data) {
      problems += 1;
      console.log(`${tag}  download FAILED: ${error?.message ?? "no data"}`);
      appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), source: item.sourceKey, status: "download_failed" }) + "\n");
      continue;
    }
    const source = Buffer.from(await data.arrayBuffer());
    downloaded += source.byteLength;
    if (args.keepSource) {
      mkdirSync(args.keepSource, { recursive: true });
      writeFileSync(join(args.keepSource, basename(item.sourceKey)), source);
    }

    const report = await makeAndStoreDerivatives(
      item.sourceKey,
      source,
      { storage: service, registry, supabaseUrl },
      item.pendingTiers
    );
    for (const t of report.tiers) if (t.status === "ready" && !t.duplicate) uploaded += t.bytes;
    if (report.status !== "complete" || (!report.registered && !args.objectsOnly)) problems += 1;

    const tiers = report.tiers
      .map((t) =>
        t.status === "ready"
          ? `${t.tier} ${KB(t.bytes)} ${t.width}×${t.height}${t.duplicate ? " (already there)" : ""}`
          : t.status === "not_needed"
            ? `${t.tier} not needed (${t.reason})`
            : `${t.tier} FAILED (${t.reason})`
      )
      .join(" | ");
    console.log(`${tag}  ${MB(source.byteLength)} → ${tiers}  registered=${report.registered}${report.registryError ? ` (${report.registryError})` : ""}`);
    appendFileSync(
      ledger,
      JSON.stringify({
        at: new Date().toISOString(),
        source: item.sourceKey,
        sourceBytes: source.byteLength,
        status: report.status,
        registered: report.registered,
        registryError: report.registryError ?? null,
        tiers: report.tiers.map((t) => (t.status === "ready" ? { tier: t.tier, status: t.status, key: t.key, bytes: t.bytes, width: t.width, height: t.height, md5: t.md5, duplicate: t.duplicate } : t)),
      }) + "\n"
    );
  }
  console.log(`done: downloaded ${MB(downloaded)}, uploaded ${MB(uploaded)}, ${problems} with problems. Ledger: ${ledger}`);
  if (problems > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
