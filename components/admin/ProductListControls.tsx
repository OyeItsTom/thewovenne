"use client";

import { Search, X } from "lucide-react";
import {
  DEFAULT_VIEW,
  NOT_SET,
  SORT_LABELS,
  STATUS_LABELS,
  isDefaultView,
  type ProductView,
  type SortMode,
  type StatusFilter,
  type StockFilter,
} from "@/lib/adminProductView";

/**
 * Search, filters and sort above the Admin Products table.
 *
 * Display controls only: they change which loaded rows are shown and in what
 * order (lib/adminProductView). Nothing here fetches or writes, and every
 * button is type="button".
 */

type Options = { values: string[]; hasEmpty: boolean };

const controlClass =
  "rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none";

export default function ProductListControls({
  view,
  onChange,
  categories,
  fabrics,
  colours,
  shown,
  total,
}: {
  view: ProductView;
  onChange: (next: ProductView) => void;
  categories: Options;
  fabrics: Options;
  colours: Options;
  shown: number;
  total: number;
}) {
  const set = <K extends keyof ProductView>(k: K, v: ProductView[K]) => onChange({ ...view, [k]: v });

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Search products</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" aria-hidden />
          <input
            type="search"
            value={view.query}
            onChange={(e) => set("query", e.target.value)}
            placeholder="Search products…"
            className={`${controlClass} w-full pl-9`}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink/60">
          <span>Sort</span>
          <select
            value={view.sort}
            onChange={(e) => set("sort", e.target.value as SortMode)}
            className={controlClass}
          >
            {(Object.keys(SORT_LABELS) as SortMode[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Status"
          value={view.status}
          onChange={(v) => set("status", v as StatusFilter)}
          options={(Object.keys(STATUS_LABELS) as StatusFilter[]).map((s) => [s, STATUS_LABELS[s]])}
        />
        <FilterSelect
          label="Category"
          value={view.category}
          onChange={(v) => set("category", v)}
          options={valueOptions("Any category", categories)}
        />
        <FilterSelect
          label="Fabric"
          value={view.fabric}
          onChange={(v) => set("fabric", v)}
          options={valueOptions("Any fabric", fabrics)}
        />
        <FilterSelect
          label="Colour"
          value={view.colour}
          onChange={(v) => set("colour", v)}
          options={valueOptions("Any colour", colours)}
        />
        <FilterSelect
          label="Stock"
          value={view.stock}
          onChange={(v) => set("stock", v as StockFilter)}
          options={[
            ["all", "Any stock"],
            ["in", "In stock"],
            ["out", "Out of stock"],
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-ink/55">
        <span role="status">
          {shown} of {total} product{total === 1 ? "" : "s"}
        </span>
        {!isDefaultView(view) && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_VIEW)}
            className="inline-flex items-center gap-1 text-terracotta-dark underline-offset-2 hover:underline"
          >
            <X className="h-3 w-3" aria-hidden /> Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function valueOptions(anyLabel: string, o: Options): [string, string][] {
  return [["", anyLabel], ...o.values.map((v): [string, string] => [v, v]), ...(o.hasEmpty ? [[NOT_SET, "Not set"] as [string, string]] : [])];
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className={`${controlClass} max-w-[14rem] ${value && value !== "all" ? "border-terracotta/60" : ""}`}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
