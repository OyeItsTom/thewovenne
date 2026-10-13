import {
  DERIVATIVE_RECIPE,
  DERIVED_TIERS,
  storageKeyFromPublicUrl,
  type DerivedTier,
} from "./imageVariants";

/**
 * THE BACKFILL'S DECISIONS, kept pure so every one of them is tested without a
 * network (scripts/image-derivatives.test.ts). scripts/image-derivatives-backfill.ts
 * does the reading and writing.
 *
 * Inputs are facts read cheaply and without egress — product rows, the
 * storage catalogue (storage.objects) and the registry, all over SQL. The only
 * egress the backfill causes is one download per source that still needs a
 * copy, plus the copies it uploads.
 */

export interface SourceObject {
  key: string;
  bytes: number | null;
  mime: string | null;
}

export interface RegistryEntry {
  source_path: string;
  tier: DerivedTier;
  recipe: number;
  status: "ready" | "not_needed";
}

export type PlanAction =
  /** Both tiers already have a row for this recipe. Nothing to do. */
  | "done"
  /** At least one tier has no row: download the source once, build, store, register. */
  | "build"
  /** Referenced, but the object is not in the bucket. Reported, never guessed at. */
  | "missing_source"
  /** A format the encoder will not take (HEIC). Reported for a person. */
  | "unsupported";

export interface PlanItem {
  sourceKey: string;
  action: PlanAction;
  bytes: number | null;
  /** Tiers with no registry row for the current recipe. */
  pendingTiers: DerivedTier[];
  /** How many stored URLs name this source (live product rows). */
  references: number;
}

export interface Plan {
  items: PlanItem[];
  /** Items this run will act on, after --only and --limit. */
  selected: PlanItem[];
  /** Bytes this run would download (sum of selected sources). */
  downloadBytes: number;
  counts: Record<PlanAction, number>;
  /** Stored URLs that are not plain public objects in this bucket — ignored, listed. */
  unrecognised: string[];
}

export const DEFAULT_BATCH = 10;
export const MAX_BATCH = 50;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH) {
    throw new Error(`--limit must be a whole number from 1 to ${MAX_BATCH}`);
  }
  return n;
}

export function planBackfill(input: {
  referencedUrls: readonly string[];
  objects: readonly SourceObject[];
  registry: readonly RegistryEntry[];
  only?: readonly string[];
  limit?: number;
  supabaseUrl?: string;
}): Plan {
  const refs = new Map<string, number>();
  const unrecognised: string[] = [];
  for (const url of input.referencedUrls) {
    const key = storageKeyFromPublicUrl(url, input.supabaseUrl);
    if (!key) {
      if (!unrecognised.includes(url)) unrecognised.push(url);
      continue;
    }
    refs.set(key, (refs.get(key) ?? 0) + 1);
  }

  const objects = new Map(input.objects.map((o) => [o.key, o]));
  const registered = new Map<string, Set<DerivedTier>>();
  for (const row of input.registry) {
    if (row.recipe !== DERIVATIVE_RECIPE) continue;
    (registered.get(row.source_path) ?? registered.set(row.source_path, new Set()).get(row.source_path)!).add(row.tier);
  }

  const items: PlanItem[] = [...refs.keys()].sort().map((sourceKey) => {
    const object = objects.get(sourceKey);
    const done = registered.get(sourceKey) ?? new Set<DerivedTier>();
    const pendingTiers = DERIVED_TIERS.filter((t) => !done.has(t));
    let action: PlanAction;
    if (!object) action = "missing_source";
    else if (/\.hei[cf]$/i.test(sourceKey) || (object.mime ?? "").toLowerCase().includes("hei")) action = "unsupported";
    else if (pendingTiers.length === 0) action = "done";
    else action = "build";
    return { sourceKey, action, bytes: object?.bytes ?? null, pendingTiers, references: refs.get(sourceKey)! };
  });

  let candidates = items.filter((i) => i.action === "build");
  if (input.only && input.only.length > 0) {
    const wanted = new Set(input.only);
    for (const key of wanted) {
      if (!items.some((i) => i.sourceKey === key)) {
        throw new Error(`--only ${key} is not a source any live product references`);
      }
    }
    candidates = candidates.filter((i) => wanted.has(i.sourceKey));
  }
  const selected = candidates.slice(0, input.limit ?? DEFAULT_BATCH);

  const counts = { done: 0, build: 0, missing_source: 0, unsupported: 0 } as Record<PlanAction, number>;
  for (const i of items) counts[i.action] += 1;

  return {
    items,
    selected,
    downloadBytes: selected.reduce((sum, i) => sum + (i.bytes ?? 0), 0),
    counts,
    unrecognised,
  };
}
