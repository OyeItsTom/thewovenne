"use client";

import { useMemo, useState } from "react";
import {
  campaignLines,
  countryLines,
  deviceLines,
  formatCount,
  formatPer100,
  PRODUCT_STATUS_LABEL,
  productLines,
  referrerLines,
  regionLines,
  searchLines,
  sourceLines,
  zeroResultLines,
  type GrainRow,
  type ProductLine,
  type ProductMeta,
  type SearchLine,
} from "@/lib/analyticsDashboard";
import { Bars, DataTable, DimensionTable, Empty, Note, Panel, Warning, focusRing } from "./ui";
import { PurchaseNote } from "./OverviewViews";

// ── Products ────────────────────────────────────

const ANY = "";
const NO_CATEGORY = "\u0000none";

function StatusTag({ line }: { line: ProductLine }) {
  if (!line.status || line.status === "live") return null;
  return (
    <span className="ml-2 inline-block rounded-full border border-ink/15 px-2 py-0.5 align-middle text-[11px] uppercase tracking-wider text-ink-muted">
      {PRODUCT_STATUS_LABEL[line.status]}
    </span>
  );
}

export function ProductsView({
  rows,
  meta,
  metaError,
  paymentsLive,
}: {
  rows: GrainRow[];
  meta: ProductMeta[] | null;
  metaError: string | null;
  paymentsLive: boolean;
}) {
  const [category, setCategory] = useState(ANY);
  const [includeInactive, setIncludeInactive] = useState(false);
  const metaMap = useMemo(() => (meta ? new Map(meta.map((m) => [m.id, m])) : null), [meta]);
  const all = useMemo(() => productLines(rows, metaMap, { includeInactive }), [rows, metaMap, includeInactive]);
  const categories = useMemo(
    () => [...new Set(all.map((l) => l.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)),
    [all]
  );
  const lines = all.filter((l) =>
    category === ANY ? true : category === NO_CATEGORY ? !l.category : l.category === category
  );

  return (
    <div className="space-y-4">
      {metaError && (
        <Warning>
          Couldn&apos;t read the current product list ({metaError}), so categories and live/hidden status are missing. The
          activity figures are unaffected.
        </Warning>
      )}
      <Panel
        title="Product activity"
        id="an-products"
        hint="Purchases are paid orders containing the product; units are the units sold in them. Products keep their history after a rename, being hidden or being deleted."
      >
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={`rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink ${focusRing}`}
            >
              <option value={ANY}>All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              {all.some((l) => !l.category) && <option value={NO_CATEGORY}>No category / deleted</option>}
            </select>
          </label>
          {meta && (
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className={`h-4 w-4 accent-terracotta-dark ${focusRing}`}
              />
              Include products with no activity
            </label>
          )}
        </div>
        {lines.length === 0 ? (
          <Empty>No customer product activity in this period{category !== ANY ? " for this category" : ""}.</Empty>
        ) : (
          <DataTable
            caption="Product activity"
            rows={lines}
            rowKey={(l) => l.key}
            rowLabel={(l) => l.name}
            initialSort="views"
            limit={20}
            columns={[
              {
                id: "name",
                label: "Product",
                sort: (l) => l.name,
                cell: (l) => (
                  <span>
                    <span className={l.status === "deleted" ? "italic" : undefined}>{l.name}</span>
                    <StatusTag line={l} />
                  </span>
                ),
              },
              { id: "category", label: "Category", sort: (l) => l.category, cell: (l) => l.category ?? "—" },
              { id: "views", label: "Product views", numeric: true, sort: (l) => l.views, cell: (l) => formatCount(l.views) },
              { id: "wishlist", label: "Wishlist adds", numeric: true, sort: (l) => l.wishlistAdds, cell: (l) => formatCount(l.wishlistAdds) },
              { id: "cart", label: "Cart adds", numeric: true, sort: (l) => l.cartAdds, cell: (l) => formatCount(l.cartAdds) },
              { id: "purchases", label: "Purchases", numeric: true, sort: (l) => l.purchases, cell: (l) => formatCount(l.purchases) },
              { id: "units", label: "Units sold", numeric: true, sort: (l) => l.unitsSold, cell: (l) => formatCount(l.unitsSold) },
              {
                id: "per100",
                label: "Cart adds per 100 views",
                numeric: true,
                sort: (l) => l.cartPer100Views,
                cell: (l) => formatPer100(l.cartPer100Views),
              },
            ]}
          />
        )}
      </Panel>
      <PurchaseNote paymentsLive={paymentsLive} />
      <Note>
        &ldquo;Cart adds per 100 views&rdquo; compares event counts for the product, not shoppers; it can exceed 100.
      </Note>
    </div>
  );
}

// ── Sources ─────────────────────────────────────

export function SourcesView({ rows }: { rows: GrainRow[] }) {
  const sources = useMemo(() => sourceLines(rows), [rows]);
  const campaigns = useMemo(() => campaignLines(rows), [rows]);
  const referrers = useMemo(() => referrerLines(rows), [rows]);
  if (sources.length === 0) return <Empty>No customer page views in this period.</Empty>;
  return (
    <div className="space-y-4">
      <Panel title="Traffic sources" id="an-sources" hint="By page views. Each event carries the source of the page load it happened in.">
        <Bars bars={sources.slice(0, 8).map((l) => ({ label: l.label, value: l.counts.page_view }))} />
        <div className="mt-5">
          <DimensionTable caption="Activity by source" lines={sources} firstLabel="Source" />
        </div>
      </Panel>
      <Panel title="Campaigns" id="an-campaigns" hint="Links tagged with utm_campaign — e.g. an Instagram post, an email or an ad.">
        {campaigns.length === 0 ? (
          <Empty>No tagged campaign links in this period.</Empty>
        ) : (
          <DimensionTable caption="Activity by campaign" lines={campaigns} firstLabel="Campaign" />
        )}
      </Panel>
      {referrers.length > 0 && (
        <Panel title="Referring websites" id="an-referrers" hint="The website a visit came from (its address only).">
          <DimensionTable caption="Activity by referring website" lines={referrers} firstLabel="Website" />
        </Panel>
      )}
      <div className="space-y-1.5">
        <Note>
          Direct means no referrer and no campaign tag — it also includes apps and browsers that hide where a visit came from.
          Unknown means the source wasn&apos;t observed, for example after a page reload inside the site.
        </Note>
        <Note>An AI assistant appears only when its own website sent the visit.</Note>
        <Note>
          Purchases are not broken down by source: they are recorded from the paid order, which carries no browsing details.
        </Note>
      </div>
    </div>
  );
}

// ── Geography ───────────────────────────────────

export function GeographyView({ rows }: { rows: GrainRow[] }) {
  const countries = useMemo(() => countryLines(rows), [rows]);
  const regions = useMemo(() => regionLines(rows), [rows]);
  if (countries.length === 0) return <Empty>No customer activity in this period.</Empty>;
  return (
    <div className="space-y-4">
      <Panel title="Countries" id="an-countries" hint="Approximate visitor location, by page views.">
        <Bars bars={countries.slice(0, 8).map((l) => ({ label: l.label, value: l.counts.page_view }))} />
        <div className="mt-5">
          <DimensionTable caption="Activity by country" lines={countries} firstLabel="Country" />
        </div>
      </Panel>
      <Panel title="Regions" id="an-regions" hint="State, nation or province within each country.">
        {regions.length === 0 ? (
          <Empty>No region information in this period.</Empty>
        ) : (
          <DimensionTable caption="Activity by region" lines={regions} firstLabel="Region" />
        )}
      </Panel>
      <div className="space-y-1.5">
        <Note>
          Locations are approximate, from the network a visit came through — VPNs, mobile networks and private relays can
          move them. City and exact location are never recorded.
        </Note>
        <Note>This is where visitors browsed from, not where orders are delivered.</Note>
      </div>
    </div>
  );
}

// ── Devices ─────────────────────────────────────

export function DevicesView({ rows }: { rows: GrainRow[] }) {
  const devices = useMemo(() => deviceLines(rows), [rows]);
  if (devices.length === 0) return <Empty>No customer activity in this period.</Empty>;
  return (
    <div className="space-y-4">
      <Panel title="Devices" id="an-devices" hint="By page views. Worked out from the browser's own description, then discarded.">
        <Bars bars={devices.map((l) => ({ label: l.label, value: l.counts.page_view }))} />
        <div className="mt-5">
          <DimensionTable caption="Activity by device" lines={devices} firstLabel="Device" />
        </div>
      </Panel>
    </div>
  );
}

// ── Search ──────────────────────────────────────

function Term({ l }: { l: SearchLine }) {
  return l.redacted ? <span className="italic text-ink-muted">(redacted)</span> : <span>{l.term}</span>;
}

export function SearchView({ rows }: { rows: GrainRow[] }) {
  const lines = useMemo(() => searchLines(rows), [rows]);
  const misses = useMemo(() => zeroResultLines(lines), [lines]);
  if (lines.length === 0) return <Empty>No customer searches in this period.</Empty>;
  const columns = [
    { id: "term", label: "Search", sort: (l: SearchLine) => l.term, cell: (l: SearchLine) => <Term l={l} /> },
    { id: "searches", label: "Searches", numeric: true, sort: (l: SearchLine) => l.searches, cell: (l: SearchLine) => formatCount(l.searches) },
    {
      id: "zero",
      label: "Found nothing",
      numeric: true,
      sort: (l: SearchLine) => l.zeroResults,
      cell: (l: SearchLine) => formatCount(l.zeroResults),
    },
    {
      id: "rate",
      label: "% found nothing",
      numeric: true,
      sort: (l: SearchLine) => l.zeroRate,
      cell: (l: SearchLine) => (l.zeroRate === null ? "—" : `${Math.round(l.zeroRate)}%`),
    },
  ];
  return (
    <div className="space-y-4">
      <Panel
        title="Searches that found nothing"
        id="an-search-misses"
        hint="What shoppers looked for and didn't find — missing products, or names that don't match how people search."
      >
        {misses.length === 0 ? (
          <Empty>Every search in this period found something.</Empty>
        ) : (
          <DataTable caption="Searches that found nothing" rows={misses} rowKey={(l) => l.term} rowLabel={(l) => l.term} initialSort="zero" columns={columns} limit={10} />
        )}
      </Panel>
      <Panel title="All searches" id="an-search-all" hint="Submitted searches, lower-cased.">
        <DataTable caption="All searches" rows={lines} rowKey={(l) => l.term} rowLabel={(l) => l.term} initialSort="searches" columns={columns} />
      </Panel>
      <div className="space-y-1.5">
        <Note>
          &ldquo;(redacted)&rdquo; is a search that looked like an email address, phone number or order number: it is counted,
          but its words were never stored.
        </Note>
        <Note>&ldquo;% found nothing&rdquo; counts only searches whose result count was recorded; &ldquo;—&rdquo; means none was.</Note>
      </div>
    </div>
  );
}
