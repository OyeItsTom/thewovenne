import type { SiteContentMap } from "./types";
import { ANON_CTX, type ReadCtx } from "./readCtx";
import { DEFAULT_CONTENT } from "./contentDefaults";

// Kept importable from here for the server-side callers; the definition lives
// in lib/contentDefaults so client components can import it without Supabase.
export { DEFAULT_CONTENT };

/** Fetch one content block by key, falling back to the built-in default. */
export async function getContent<K extends keyof SiteContentMap>(
  key: K,
  ctx: ReadCtx = ANON_CTX
): Promise<SiteContentMap[K]> {
  const preview = ctx.preview;
  const { data, error } = await ctx.client
    .from("site_content")
    .select(preview ? "value, draft_value" : "value")
    .eq("key", key)
    .maybeSingle();

  const row = data as { value?: unknown; draft_value?: unknown } | null;
  // In preview the unpublished copy wins, falling back to the live one for a
  // key that has never been edited.
  const chosen = preview ? row?.draft_value ?? row?.value : row?.value;
  if (error || !chosen) return DEFAULT_CONTENT[key];
  // Merge over defaults so a partially-edited block never loses required fields.
  return { ...DEFAULT_CONTENT[key], ...(chosen as object) } as SiteContentMap[K];
}
