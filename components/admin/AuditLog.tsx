"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getAuditLog } from "@/lib/audit";
import { getBrowserSupabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { AuditEntry } from "@/lib/types";

const ACTION_STYLES: Record<string, string> = {
  insert: "bg-gold/20 text-ink",
  update: "bg-ink/10 text-ink/70",
  delete: "bg-terracotta/15 text-terracotta-dark",
};

const ACTION_VERBS: Record<string, string> = {
  insert: "created",
  update: "edited",
  delete: "deleted",
};

const TABLE_LABELS: Record<string, string> = {
  products: "product",
  categories: "category",
  site_content: "homepage content",
  journal_posts: "journal post",
};

/** "3 minutes ago" for the recent stuff, absolute once it stops being useful. */
function when(iso: string) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`;
  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    getAuditLog(getBrowserSupabase()).then(setEntries);
  }, []);

  if (entries === null) return <p className="text-ink/60">Loading activity…</p>;

  if (entries.length === 0) {
    return (
      <p className="rounded-2xl bg-linen/60 p-8 text-center text-sm text-ink/60">
        Nothing recorded yet. Changes to products, categories, homepage content
        and journal posts will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="max-w-prose text-sm leading-relaxed text-ink/60">
        Every change to products, categories, homepage content and journal posts,
        newest first. Recorded by the database itself, so it captures changes
        made outside this dashboard too — and nobody, including you, can edit it.
      </p>

      <div className="overflow-hidden rounded-2xl border border-ink/10">
        <ul className="divide-y divide-ink/10">
          {entries.map((entry) => {
            const isOpen = open === entry.id;
            return (
              <li key={entry.id}>
                <button
                  onClick={() => setOpen(isOpen ? null : entry.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-linen/40"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-ink/30" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink/30" />
                  )}

                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                      ACTION_STYLES[entry.action] ?? "bg-ink/10 text-ink/70"
                    )}
                  >
                    {ACTION_VERBS[entry.action] ?? entry.action}
                  </span>

                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    <span className="font-medium">
                      {entry.record_label ?? "—"}
                    </span>
                    <span className="text-ink/50">
                      {" "}
                      · {TABLE_LABELS[entry.table_name] ?? entry.table_name}
                    </span>
                  </span>

                  <span className="hidden shrink-0 text-xs text-ink/50 sm:block">
                    {entry.actor_email ?? "system"}
                  </span>
                  <span className="shrink-0 text-xs text-ink/40">
                    {when(entry.created_at)}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-ink/5 bg-linen/30 px-4 py-3 pl-11">
                    <p className="mb-2 text-xs text-ink/50 sm:hidden">
                      {entry.actor_email ?? "system"}
                    </p>
                    <Changes entry={entry} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function Changes({ entry }: { entry: AuditEntry }) {
  if (!entry.changes) {
    return <p className="text-xs text-ink/50">No detail recorded.</p>;
  }

  // Updates store { column: { from, to } }; inserts and deletes store the row.
  const isDiff = entry.action === "update";
  const rows = Object.entries(entry.changes);

  return (
    <dl className="grid gap-1.5 text-xs">
      {rows.map(([field, value]) => (
        <div key={field} className="grid grid-cols-[8rem_1fr] gap-2">
          <dt className="truncate font-medium text-ink/60">{field}</dt>
          <dd className="min-w-0 break-words text-ink/80">
            {isDiff ? (
              <>
                <span className="text-ink/40 line-through">
                  {format((value as { from: unknown }).from)}
                </span>{" "}
                → {format((value as { to: unknown }).to)}
              </>
            ) : (
              format(value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 120)}…` : value || "empty";
  }
  return JSON.stringify(value);
}
