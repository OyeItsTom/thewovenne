/**
 * What the Admin tells people: where an item stands, what a save or publish
 * just did, and why a write failed.
 *
 * PURE. No database handle and no React, so every sentence an admin can see
 * about state is decided here and can be tested without a browser.
 *
 * ── THE STATES ARE THE DATA MODEL'S, NOT NEW ONES ──
 *
 * Every product, category and journal post has at most one `published`
 * version (what customers see) and at most one `draft` (unpublished work,
 * migration 0011). A draft can carry `pending_delete`: the item is deleted
 * when it is published, and stays live until then. The published version's
 * own on/off flag (products.is_active, journal_versions.published,
 * category is_visible) decides whether customers see it at all.
 *
 *   no published version              → Never published
 *   published, flag on                → Live
 *   published, flag off               → Hidden
 *   + a draft                         → … with Unpublished changes
 *   + a draft marked pending_delete   → … Deleting at next publish
 *
 * WHY THIS EXISTS: before it, the badges read the DRAFT's values. Switching a
 * live product off showed "Hidden" while customers could still buy it, a new
 * product read "Active" though it had never been published, and a staged
 * delete removed the row from the list while the product stayed on the site.
 */
import type { PublicationFacts } from "./types";

export type { PublicationFacts };

export type BadgeTone = "live" | "muted" | "pending" | "danger";

export interface StatusBadge {
  /** Short, always text — the state is never carried by colour alone. */
  label: string;
  tone: BadgeTone;
  /** One sentence on what customers see, for the row and screen readers. */
  detail: string;
}

/** Facts for a row the admin view merged from published + draft versions. */
export function factsFromVersions(
  rows: readonly { state: string; pending_delete?: boolean | null; visible: boolean }[]
): PublicationFacts {
  const published = rows.find((r) => r.state === "published");
  const draft = rows.find((r) => r.state === "draft");
  return {
    hasPublished: !!published,
    hasDraft: !!draft,
    pendingDelete: !!draft?.pending_delete,
    liveVisible: !!published?.visible,
  };
}

/**
 * The badges for one row, most important first. The first says what customers
 * see now; the second (if any) says what is waiting.
 */
export function statusBadges(f: PublicationFacts, noun: string): StatusBadge[] {
  const badges: StatusBadge[] = [];

  if (!f.hasPublished) {
    badges.push({
      label: "Never published",
      tone: "muted",
      detail: `Draft only — customers can't see this ${noun}.`,
    });
  } else if (f.liveVisible) {
    badges.push({
      label: "Live",
      tone: "live",
      detail: `Customers can see this ${noun}.`,
    });
  } else {
    badges.push({
      label: "Hidden",
      tone: "muted",
      detail: `Published, but customers can't see this ${noun} right now.`,
    });
  }

  if (f.pendingDelete) {
    badges.push({
      label: "Deleting at next publish",
      tone: "danger",
      detail: f.hasPublished
        ? "It stays exactly as it is for customers until you publish."
        : "It was never published, so customers aren't affected.",
    });
  } else if (f.hasDraft && f.hasPublished) {
    badges.push({
      label: "Unpublished changes",
      tone: "pending",
      detail: "Customers see the live version until you publish.",
    });
  }

  return badges;
}

/** The whole state as one sentence — for title/aria text. */
export function statusSentence(f: PublicationFacts, noun: string): string {
  return statusBadges(f, noun)
    .map((b) => `${b.label}: ${b.detail}`)
    .join(" ");
}

// ── What a save said ─────────────────────────────────────────────────────

/**
 * After Save draft. NEVER says "published": a save writes the draft and
 * nothing else, so the only true statement is about what customers still see.
 *
 * `settled` is settle_draft's answer — true when the draft turned out to
 * change nothing and was dropped, so nothing is waiting either.
 */
export function draftSavedMessage({
  noun,
  name,
  hasPublished,
  settled = false,
}: {
  noun: string;
  name: string;
  hasPublished: boolean;
  settled?: boolean;
}): string {
  const label = name.trim() ? `“${name.trim()}”` : `This ${noun}`;
  if (settled && hasPublished) {
    return `No changes to publish — ${label} matches what customers already see.`;
  }
  if (!hasPublished) {
    return `Draft saved. ${label} isn't visible to customers until you publish it.`;
  }
  return `Changes to ${label} saved as a draft. Customers still see the current live version until you publish.`;
}

/** After a publish that really succeeded. */
export function publishedMessage({
  name,
  pendingDelete = false,
}: {
  name: string;
  pendingDelete?: boolean;
}): string {
  return pendingDelete
    ? `“${name}” has been deleted from the site. Customers can no longer see it.`
    : `Published “${name}”. Customers can now see this version.`;
}

// ── Destructive confirmations ────────────────────────────────────────────

/** Staged delete: WHAT happens, WHEN, and whether customers notice. */
export function deleteConfirmText(noun: string, name: string, hasPublished: boolean): string {
  return hasPublished
    ? `Delete “${name}” at the next publish? It stays on the site until you publish; after that customers can no longer see this ${noun}.`
    : `Delete “${name}”? It was never published, so customers aren't affected. It is removed when you next publish.`;
}

/** Discard one queued item. A never-published item has nothing to fall back to. */
export function discardOneText(name: string, isNew: boolean): string {
  return isNew
    ? `Discard “${name}”? It was never published, so it will be removed completely. Customers aren't affected.`
    : `Discard the unpublished changes to “${name}”? The live version customers see stays exactly as it is.`;
}

export function discardAllText(total: number): string {
  return `Discard all ${total} unpublished ${total === 1 ? "change" : "changes"}? This can't be undone. Customers aren't affected — the live site stays as it is.`;
}

// ── Truthful failure ─────────────────────────────────────────────────────

export type FailureReason =
  | "permission"
  | "conflict"
  | "duplicate"
  | "validation"
  | "network"
  | "blocked"
  | "unknown";

type ErrorLike = { code?: string | null; message?: string | null } | string | null | undefined;

function parts(err: ErrorLike): { code: string; message: string } {
  if (!err) return { code: "", message: "" };
  if (typeof err === "string") return { code: "", message: err };
  return { code: err.code ?? "", message: err.message ?? "" };
}

/** Sort a Supabase/PostgREST/Postgres error into something an admin can act on. */
export function classifyError(err: ErrorLike): FailureReason {
  const { code, message } = parts(err);
  const m = message.toLowerCase();
  // Checked before "blocked": "Only admins can …" is a RAISE (P0001), but it
  // means the session lost its rights, not that the change was refused.
  if (
    code === "42501" ||
    code === "PGRST301" ||
    code === "PGRST302" ||
    m.includes("only admins") ||
    m.includes("permission denied") ||
    m.includes("row-level security") ||
    m.includes("jwt")
  ) {
    return "permission";
  }
  if (code === "PGRST116" || m.includes("multiple (or no) rows")) return "conflict";
  if (code === "23505") return "duplicate";
  if (["23502", "23514", "22P02", "22003", "22007", "22008", "23503"].includes(code)) {
    return "validation";
  }
  if (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("load failed") ||
    m.includes("network request failed")
  ) {
    return "network";
  }
  // RAISE EXCEPTION from our own functions (publish_one's "Publish its
  // category first", "This product is missing its name…"). Those sentences are
  // written for the admin, so they are shown as they are.
  if (code === "P0001") return "blocked";
  return "unknown";
}

/**
 * The sentence shown for a failed write. Says what happened, that nothing was
 * changed, and what to do — and never prints database internals (table names,
 * constraint names, PostgREST jargon), except our own RAISE messages, which
 * are written to be read.
 *
 * `action` completes "Couldn't …": "save this draft", "publish this".
 */
export function adminErrorMessage(err: ErrorLike, action: string): string {
  const reason = classifyError(err);
  switch (reason) {
    case "permission":
      return `Couldn't ${action} — your admin session no longer has permission, so nothing was changed. Sign in again (with your authenticator code), then retry.`;
    case "conflict":
      return `Couldn't ${action} — this draft was published or discarded (perhaps in another tab) while you were working, so nothing was changed. Reload the page to see the current version, then make the change again.`;
    case "duplicate":
      return `Couldn't ${action} — that web address (slug) is already used by another item. Change it and try again.`;
    case "validation":
      return `Couldn't ${action} — one of the values isn't allowed (for example a negative number or a required field left empty). Nothing was changed; check the form and try again.`;
    case "network":
      return `Couldn't ${action} — the server couldn't be reached, so nothing was changed. Check your connection and try again.`;
    case "blocked":
      return parts(err).message;
    default:
      return `Couldn't ${action}, so nothing was changed. Try again; if it keeps happening, note the time and tell your developer.`;
  }
}

export type DraftWrite<T> = { ok: true; row: T } | { ok: false; reason: FailureReason; message: string };

/**
 * A draft write succeeded only if EXACTLY ONE draft row came back.
 *
 * The ProfileForm lesson (#179): a request that completes is not a write that
 * happened. An UPDATE that matches nothing — the draft was published or
 * discarded meanwhile, or the session lost its rights under RLS — returns no
 * error and no rows, and used to be reported as saved.
 */
export function checkDraftWrite<T>(
  result: { error: ErrorLike; data: T[] | null | undefined },
  action: string
): DraftWrite<T> {
  if (result.error) {
    return { ok: false, reason: classifyError(result.error), message: adminErrorMessage(result.error, action) };
  }
  const rows = result.data ?? [];
  if (rows.length !== 1) {
    return {
      ok: false,
      reason: "conflict",
      message: adminErrorMessage({ code: "PGRST116" }, action),
    };
  }
  return { ok: true, row: rows[0] };
}

// ── Unsaved changes ──────────────────────────────────────────────────────

/** Key-order-independent JSON, so {a,b} and {b,a} compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Whether the form differs from what it opened with. A baseline of null means
 * "still loading" and is never dirty — so a warning cannot fire just because
 * the photos arrived after the form opened.
 */
export function isDirty(baseline: unknown, current: unknown): boolean {
  if (baseline === null || baseline === undefined) return false;
  return stable(baseline) !== stable(current);
}
