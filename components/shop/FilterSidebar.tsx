"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Minus, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { NO_FILTERS, isUnfiltered, type CatalogueFilters } from "@/lib/catalogueParams";
import { facetKey, narrowingOptions } from "@/lib/catalogueFacets";
import { ceilingLabel, type PriceSliderRange } from "@/lib/priceSlider";
import { slideInFromLeft } from "@/lib/motion";
import { useDialogFocus } from "@/lib/useDialogFocus";
import PriceSlider from "./PriceSlider";

/*
 * ONE DEFINITION, NOT TWO. These are the same fields the URL carries, so the
 * type is the canonical one from lib/catalogueParams rather than a copy that
 * happens to match today. A copy would let the URL contract and the controls
 * drift apart silently, and the compiler would have nothing to say.
 */
export type Filters = CatalogueFilters;

export interface CategoryFilterGroup {
  name: string;
  children: { name: string; slug: string }[];
}

/**
 * Everything a listing COULD offer. Which of it the panel actually shows is
 * decided by panelGroups(), against the choices already made.
 */
export interface FilterOptions {
  /**
   * Only sub-categories that hold a product (getNavCategoryTree — the header's
   * own rule), so the panel never offers a shelf with nothing on it.
   */
  categoryGroups: CategoryFilterGroup[];
  /** Fabric facets (lib/catalogueFacets) — Mul Cotton, not the stored sentence. */
  fabrics: string[];
  colours: string[];
  /**
   * Sizes that at least one product on show still has stock in — and only
   * when the listing is a single sub-category. Empty hides the group.
   */
  sizes: string[];
  /** "Ring size" inside Rings; "Size" elsewhere. */
  sizeTitle?: string;
  /** The price slider's range, or null when no ceiling would narrow anything. */
  priceRange?: PriceSliderRange | null;
  /** Offer "In stock" — only when some pieces are sold out and some are not. */
  availability?: boolean;
}

export const EMPTY_FILTERS: Filters = NO_FILTERS;

/** What the panel shows, after every group that cannot narrow is dropped. */
export interface PanelGroups {
  availability: boolean;
  fabrics: string[];
  colours: string[];
  price: PriceSliderRange | null;
  categoryGroups: CategoryFilterGroup[];
  sizes: string[];
}

/**
 * THE ELIGIBILITY RULE, in one place. A group is shown only if choosing in it
 * can change the result: two or more options (narrowingOptions — a lone
 * "Cotton" on Men/Dhoti is a no-op), a price range with a stop that leaves
 * something out, "In stock" only when some pieces are sold out. A choice
 * already made keeps its group on show so it can be seen and undone.
 */
export function panelGroups(options: FilterOptions, filters: Filters = NO_FILTERS): PanelGroups {
  const categories = options.categoryGroups.filter((g) => g.children.length > 0);
  const subCategoryCount = categories.reduce((n, g) => n + g.children.length, 0);
  return {
    availability: !!options.availability || filters.inStock,
    fabrics: narrowingOptions(options.fabrics, filters.fabric),
    colours: narrowingOptions(options.colours, filters.colour),
    price: options.priceRange ?? null,
    categoryGroups: subCategoryCount >= 2 || filters.category ? categories : [],
    sizes: narrowingOptions(options.sizes, filters.size ? [filters.size] : []),
  };
}

/** Whether any of the panel's groups has something to offer. */
export function hasFilterOptions(options: FilterOptions, filters: Filters = NO_FILTERS): boolean {
  const g = panelGroups(options, filters);
  return (
    g.availability ||
    g.categoryGroups.length > 0 ||
    g.sizes.length > 0 ||
    g.fabrics.length > 0 ||
    g.colours.length > 0 ||
    g.price !== null
  );
}

/** A collapsed group's one-line answer to "what have I chosen here?" */
export function groupSummary(chosen: readonly string[]): string | null {
  if (chosen.length === 0) return null;
  return chosen.length === 1 ? chosen[0] : `${chosen.length} selected`;
}

type GroupId = "availability" | "fabric" | "colour" | "price" | "category" | "size";

export default function FilterSidebar({
  options,
  filters,
  onChange,
  isOpen,
  onClose,
  resultLabel,
  onClearAll,
  pending = false,
}: {
  options: FilterOptions;
  filters: Filters;
  onChange: (filters: Filters) => void;
  isOpen: boolean;
  onClose: () => void;
  /** "8 products" — the drawer's close button says what closing will show. */
  resultLabel?: string;
  onClearAll?: () => void;
  /** The server is still answering the last change (shop only). */
  pending?: boolean;
}) {
  const reduced = useReducedMotion();
  const panel = slideInFromLeft(reduced);
  const titleId = useId();
  const sidebarTitleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(isOpen, onClose, rootRef, panelRef);

  // Which groups are open. One state for the sidebar AND the drawer, so a group
  // opened in the drawer is still open the next time it is opened. Everything
  // starts closed: the panel reads as a few calm lines, not a wall of options.
  const [expanded, setExpanded] = useState<Partial<Record<GroupId, boolean>>>({});
  const toggleGroup = (id: GroupId) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  const update = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  /** Add or remove one value of a list filter. */
  const toggleIn = (key: "fabric" | "colour", value: string) => {
    const has = filters[key].some((v) => facetKey(v) === facetKey(value));
    update({
      [key]: has
        ? filters[key].filter((v) => facetKey(v) !== facetKey(value))
        : [...filters[key], value],
    });
  };
  /** Choose a single-valued filter, or un-choose it if it was the one chosen. */
  const toggleOne = (key: "category" | "size", value: string) =>
    update({ [key]: same(filters[key], value) ? null : value });

  const groups = panelGroups(options, filters);
  const hasActiveFilters = !isUnfiltered(filters);
  const categoryName = (slug: string) =>
    groups.categoryGroups.flatMap((g) => g.children).find((c) => c.slug === slug)?.name ?? slug;

  /*
   * The same controls in two places: the desktop sidebar and the phone drawer.
   * Both put an h2 "Filters" above h3 groups, so the outline is identical
   * wherever the panel is read.
   *
   * ORDER: what can be bought, then the cloth — the shop's strongest axis —
   * then colour and price, then where it is filed, then sizes, which only
   * exist inside one kind of thing.
   */
  const content = (
    <div className="border-t border-ink/10">
      {groups.availability && (
        <Group
          title="Availability"
          summary={filters.inStock ? "In stock" : null}
          open={!!expanded.availability}
          onToggle={() => toggleGroup("availability")}
        >
          <OptionList>
            <CheckOption
              checked={filters.inStock}
              onChange={() => update({ inStock: !filters.inStock })}
            >
              In stock
            </CheckOption>
          </OptionList>
        </Group>
      )}
      {groups.fabrics.length > 0 && (
        <Group
          title="Fabric"
          summary={groupSummary(filters.fabric)}
          open={!!expanded.fabric}
          onToggle={() => toggleGroup("fabric")}
        >
          <OptionList>
            {groups.fabrics.map((fabric) => (
              <CheckOption
                key={fabric}
                checked={filters.fabric.some((v) => facetKey(v) === facetKey(fabric))}
                onChange={() => toggleIn("fabric", fabric)}
              >
                {fabric}
              </CheckOption>
            ))}
          </OptionList>
        </Group>
      )}
      {groups.colours.length > 0 && (
        <Group
          title="Colour"
          summary={groupSummary(filters.colour)}
          open={!!expanded.colour}
          onToggle={() => toggleGroup("colour")}
        >
          <OptionList>
            {groups.colours.map((colour) => (
              <CheckOption
                key={colour}
                checked={filters.colour.some((v) => facetKey(v) === facetKey(colour))}
                onChange={() => toggleIn("colour", colour)}
              >
                {colour}
              </CheckOption>
            ))}
          </OptionList>
        </Group>
      )}
      {groups.price && (
        <Group
          title="Price"
          summary={filters.maxPrice !== null ? ceilingLabel(filters.maxPrice) : null}
          open={!!expanded.price}
          onToggle={() => toggleGroup("price")}
        >
          <PriceSlider
            range={groups.price}
            maxPrice={filters.maxPrice}
            onCommit={(maxPrice) => update({ maxPrice })}
          />
        </Group>
      )}
      {groups.categoryGroups.length > 0 && (
        <Group
          title="Category"
          summary={filters.category ? categoryName(filters.category) : null}
          open={!!expanded.category}
          onToggle={() => toggleGroup("category")}
        >
          <div className="space-y-4">
            {groups.categoryGroups.map((group) => (
              <div key={group.name}>
                <p className="text-xs uppercase tracking-wider text-ink-muted">{group.name}</p>
                <OptionList className="mt-1">
                  {group.children.map((child) => (
                    <PickOption
                      key={child.slug}
                      selected={filters.category === child.slug}
                      onClick={() => toggleOne("category", child.slug)}
                    >
                      {child.name}
                    </PickOption>
                  ))}
                </OptionList>
              </div>
            ))}
          </div>
        </Group>
      )}
      {groups.sizes.length > 0 && (
        <Group
          title={options.sizeTitle ?? "Size"}
          summary={filters.size}
          open={!!expanded.size}
          onToggle={() => toggleGroup("size")}
        >
          <OptionList>
            {groups.sizes.map((size) => (
              <PickOption
                key={size}
                selected={same(filters.size, size)}
                onClick={() => toggleOne("size", size)}
              >
                {size}
              </PickOption>
            ))}
          </OptionList>
        </Group>
      )}
    </div>
  );

  /*
   * The drawer is a real modal dialog now: named by its heading, focus moved
   * in, the page behind inert, Tab held inside, Escape to close, focus handed
   * back to the Filters button. Before this it was a div with none of those,
   * and Tab walked from the last price straight into the page behind it.
   *
   * NO AnimatePresence — see components/cart/CartDrawer.tsx for the full
   * account: it left an invisible backdrop over the shop that swallowed every
   * click. React unmounts it; the cost is the exit animation.
   */
  const drawer = isOpen ? (
    <div ref={rootRef} className="fixed inset-0 z-[70] lg:hidden">
      <motion.div
        className="absolute inset-0 bg-ink/40"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        onClick={onClose}
        aria-hidden
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial="hidden"
        animate="visible"
        variants={panel}
        className="relative flex h-full w-full max-w-sm flex-col bg-cream shadow-lift outline-none"
      >
        <div className="flex items-center justify-between px-6 py-4">
          <h2 id={titleId} className="font-heading text-2xl text-ink">
            Filters
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="-mr-3 flex h-11 w-11 items-center justify-center text-ink-muted transition-colors hover:text-ink"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">{content}</div>
        {/* Filters apply as they are tapped, so this is not an Apply step — it
            closes the drawer and says what is now on the page behind it. */}
        <div className="flex items-center gap-5 border-t border-ink/10 px-6 py-4">
          {hasActiveFilters && onClearAll && (
            <button
              type="button"
              onClick={onClearAll}
              className="min-h-[44px] text-sm text-ink underline underline-offset-4"
            >
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-busy={pending || undefined}
            className={cn(
              "min-h-[44px] flex-1 rounded-full bg-ink px-6 text-sm uppercase tracking-wider text-cream transition-opacity",
              pending && "opacity-70"
            )}
          >
            {resultLabel ? `Show ${resultLabel}` : "Done"}
          </button>
        </div>
      </motion.div>
    </div>
  ) : null;

  return (
    <>
      {/* Desktop sidebar. "Clear all" lives here, beside the title of the
          thing it clears, rather than a second time beside the chips. */}
      <aside aria-labelledby={sidebarTitleId} className="hidden w-60 flex-shrink-0 lg:block">
        <div className="flex min-h-[44px] items-center justify-between pb-2">
          <h2
            id={sidebarTitleId}
            className="font-body text-xs font-medium uppercase tracking-[0.18em] text-ink"
          >
            Filters
          </h2>
          {hasActiveFilters && onClearAll && (
            <button
              type="button"
              onClick={onClearAll}
              className="min-h-[44px] text-sm text-ink underline underline-offset-4 transition-colors hover:text-terracotta-deep"
            >
              Clear all
            </button>
          )}
        </div>
        {content}
      </aside>

      {/* Portalled so everything else on <body> can be made inert. On the
          server there is no <body> to portal to — and the drawer is never open
          on a first render — so there it renders in place. */}
      {drawer &&
        (typeof document === "undefined" ? drawer : createPortal(drawer, document.body))}
    </>
  );
}

/**
 * The catalogue matches values case-insensitively (sameCatalogueValue), so a
 * shared link reading ?size=m filters to "M" — and the M option has to show
 * as chosen, and tapping it has to undo it.
 */
const same = (a: string | null, b: string) =>
  a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One collapsible group: a disclosure button inside the group's heading, so it
 * is both a landmark in the heading outline and a control ("Fabric, collapsed,
 * button"). Closed, it says what is chosen in it — one value by name, more as
 * a count — so the panel can be read without opening anything.
 */
function Group({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string | null;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <div className="border-b border-ink/10">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-h-[52px] w-full items-center justify-between gap-4 py-3 text-left"
        >
          <span className="font-heading text-lg text-ink">{title}</span>
          <span className="flex min-w-0 items-center gap-3">
            {!open && summary && (
              <span className="truncate font-body text-sm text-ink-muted">{summary}</span>
            )}
            {open ? (
              <Minus aria-hidden className="h-4 w-4 flex-none text-ink" strokeWidth={1.5} />
            ) : (
              <Plus aria-hidden className="h-4 w-4 flex-none text-ink" strokeWidth={1.5} />
            )}
          </span>
        </button>
      </h3>
      <div id={panelId} hidden={!open} className="pb-5">
        {children}
      </div>
    </div>
  );
}

function OptionList({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={cn("space-y-0.5", className)}>{children}</ul>;
}

/**
 * A multi-choice option: a REAL checkbox, restyled. Its native role, state,
 * keyboard (Space) and the site-wide focus ring all come with it; the label
 * makes the whole row the hit area — 44px tall on touch screens.
 */
function CheckOption({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-ink lg:min-h-[36px]">
        <span className="relative flex h-4 w-4 flex-none">
          <input
            type="checkbox"
            checked={checked}
            onChange={onChange}
            className="h-4 w-4 cursor-pointer appearance-none rounded-[3px] border border-ink-muted bg-cream transition-colors checked:border-ink checked:bg-ink hover:border-ink"
          />
          {checked && (
            <Check
              aria-hidden
              strokeWidth={2.5}
              className="pointer-events-none absolute inset-0 m-auto h-3 w-3 text-cream"
            />
          )}
        </span>
        <span className={checked ? "font-medium" : undefined}>{children}</span>
      </label>
    </li>
  );
}

/**
 * A one-of option (a category, a size): a toggle button, aria-pressed, because
 * the chosen one can be un-chosen by choosing it again — which a radio button
 * cannot do. Drawn with a round mark to read as "one of these".
 */
function PickOption({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        className="flex min-h-[44px] w-full items-center gap-3 text-left text-sm text-ink lg:min-h-[36px]"
      >
        <span
          aria-hidden
          className={cn(
            "flex h-4 w-4 flex-none items-center justify-center rounded-full border transition-colors",
            selected ? "border-ink" : "border-ink-muted"
          )}
        >
          {selected && <span className="h-2 w-2 rounded-full bg-ink" />}
        </span>
        <span className={selected ? "font-medium" : undefined}>{children}</span>
      </button>
    </li>
  );
}
