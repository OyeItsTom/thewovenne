"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import {
  EXPORT_DATASETS,
  defaultColumns,
  type ExportDataset,
} from "@/lib/exports";
import { financialYear } from "@/lib/expenses";

/**
 * Pick a dataset, tick the columns, download the .xlsx.
 *
 * The picker renders from lib/exports.ts, which the route also builds the file
 * from — so a column cannot be offered here and be missing from the sheet.
 *
 * The last selection is remembered per dataset in localStorage. It is a
 * preference, not data: if it is lost the defaults come back, so there is
 * nothing to migrate and nothing to go wrong.
 */

const STORE_KEY = "wovenne-export-columns";

function remembered(dataset: ExportDataset): string[] {
  if (typeof window === "undefined") return defaultColumns(dataset);
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    const saved = all?.[dataset.id];
    // Only keep keys the dataset still offers — a column removed from the code
    // must not linger in someone's saved selection and be requested forever.
    const valid = Array.isArray(saved)
      ? saved.filter((k: string) => dataset.columns.some((c) => c.key === k))
      : [];
    return valid.length ? valid : defaultColumns(dataset);
  } catch {
    return defaultColumns(dataset);
  }
}

function remember(datasetId: string, columns: string[]) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...all, [datasetId]: columns }));
  } catch {
    // A full or blocked localStorage must never stop an export.
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export default function ExportPanel() {
  const fy = financialYear();
  const [dataset, setDataset] = useState<ExportDataset>(EXPORT_DATASETS[0]);
  const [columns, setColumns] = useState<string[]>(() => remembered(EXPORT_DATASETS[0]));
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pickDataset(next: ExportDataset) {
    setDataset(next);
    setColumns(remembered(next));
    setError(null);
  }

  function toggle(key: string) {
    setColumns((current) => {
      const next = current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key];
      remember(dataset.id, next);
      return next;
    });
  }

  async function download(payload: Record<string, unknown>, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const res = await fetch("/api/admin/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? "That export could not be built.");
      }

      // Read the filename the server chose rather than inventing one here, so
      // the file is named the same whoever downloads it.
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const named = /filename="([^"]+)"/.exec(disposition)?.[1];

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = named ?? "wovenne-export.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      {/* Year-end first: it is the one export with a deadline attached. */}
      <div className="rounded-2xl border border-ink/10 bg-linen/40 p-5">
        <h3 className="font-heading text-xl text-ink">Financial year bundle</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-ink/65">
          Orders, expenses and the profit &amp; loss statement in one workbook,
          covering <strong className="font-medium">1 April to 31 March</strong> —
          ready to hand to an accountant. Every column is included; nothing is
          filtered out.
        </p>
        <button
          onClick={() =>
            download({ bundle: "financial-year", from: fy.from }, "bundle")
          }
          disabled={busy !== null}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-50"
        >
          {busy === "bundle" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Export {fy.label}
        </button>
      </div>

      <div className="space-y-4 rounded-2xl border border-ink/10 bg-cream p-5">
        <div>
          <h3 className="font-heading text-xl text-ink">Export a dataset</h3>
          <p className="mt-1 text-sm text-ink/60">{dataset.blurb}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {EXPORT_DATASETS.map((d) => (
            <button
              key={d.id}
              onClick={() => pickDataset(d)}
              className={`rounded-full px-4 py-2 text-sm transition-colors ${
                d.id === dataset.id
                  ? "bg-ink text-cream"
                  : "border border-ink/15 text-ink/70 hover:border-ink/40"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        {dataset.dateField && (
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wider text-ink/50">From</span>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
              />
            </label>
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wider text-ink/50">To</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
              />
            </label>
          </div>
        )}

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs uppercase tracking-wider text-ink/50">
              Columns — {columns.length} of {dataset.columns.length}
            </p>
            <div className="flex gap-3 text-xs">
              <button
                onClick={() => {
                  const all = dataset.columns.map((c) => c.key);
                  setColumns(all);
                  remember(dataset.id, all);
                }}
                className="text-ink/50 hover:text-ink"
              >
                All
              </button>
              <button
                onClick={() => {
                  const d = defaultColumns(dataset);
                  setColumns(d);
                  remember(dataset.id, d);
                }}
                className="text-ink/50 hover:text-ink"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {dataset.columns.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-sm text-ink/75">
                <input
                  type="checkbox"
                  checked={columns.includes(c.key)}
                  onChange={() => toggle(c.key)}
                  className="h-4 w-4 accent-terracotta"
                />
                {c.label}
              </label>
            ))}
          </div>
        </div>

        <button
          onClick={() =>
            download(
              {
                dataset: dataset.id,
                columns,
                ...(dataset.dateField ? { from, to } : {}),
              },
              "dataset"
            )
          }
          disabled={busy !== null || columns.length === 0}
          className="inline-flex items-center gap-2 rounded-full bg-terracotta px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-terracotta-dark disabled:opacity-50"
        >
          {busy === "dataset" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {columns.length === 0 ? "Tick at least one column" : "Download .xlsx"}
        </button>
      </div>
    </div>
  );
}
