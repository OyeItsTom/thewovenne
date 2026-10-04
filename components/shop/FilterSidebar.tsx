"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn, formatINR } from "@/lib/utils";
import { NO_FILTERS, type CatalogueFilters } from "@/lib/catalogueParams";
import { PRICE_STEPS } from "@/lib/catalogueDiscovery";
import { slideInFromLeft } from "@/lib/motion";
import { useDialogFocus } from "@/lib/useDialogFocus";

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

export interface FilterOptions {
  /**
   * Only sub-categories that hold a product (getNavCategoryTree — the header's
   * own rule), so the panel never offers a shelf with nothing on it.
   */
  categoryGroups: CategoryFilterGroup[];
  fabrics: string[];
  colours: string[];
  /**
   * Sizes that at least one product on show still has stock in.
   *
   * Empty hides the Size filter entirely — which is how sarees end up without
   * one without anybody hardcoding "sarees". Any future size-less category gets
   * the same treatment for free, and renaming a category cannot break it.
   */
  sizes: string[];
  /** Price ceilings that narrow this listing (usefulPriceSteps). Defaults to every step. */
  priceSteps?: readonly number[];
  /** Offer "In stock" — only when some pieces are sold out and some are not. */
  availability?: boolean;
}

export const EMPTY_FILTERS: Filters = NO_FILTERS;

/** Whether any of the panel's groups has something to offer. */
export function hasFilterOptions(options: FilterOptions): boolean {
  return (
    !!options.availability ||
    options.categoryGroups.some((g) => g.children.length > 0) ||
    options.sizes.length > 0 ||
    options.fabrics.length > 0 ||
    options.colours.length > 0 ||
    (options.priceSteps ?? PRICE_STEPS).length > 0
  );
}

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
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(isOpen, onClose, rootRef, panelRef);

  const update = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const toggle = (key: "category" | "size" | "fabric" | "colour", value: string) =>
    update({ [key]: same(filters[key], value) ? null : value });

  // A ceiling arriving from a shared link stays visible, so it can be undone
  // here as well as from its chip.
  const steps = [...(options.priceSteps ?? PRICE_STEPS)];
  if (filters.maxPrice !== null && !steps.includes(filters.maxPrice)) {
    steps.push(filters.maxPrice);
    steps.sort((a, b) => a - b);
  }

  const hasActiveFilters =
    filters.inStock ||
    !!filters.category ||
    !!filters.fabric ||
    !!filters.colour ||
    !!filters.size ||
    filters.maxPrice !== null;

  /*
   * The same controls in two places, at two heading levels. The desktop
   * sidebar sits straight under the page's h1, so its groups are h2. The
   * drawer has its own h2, "Filters", so there they are h3.
   */
  const content = (level: HeadingLevel) => (
    <div className="space-y-8">
      {options.availability && (
        <OptionGroup level={level} title="Availability">
          <Option
            selected={filters.inStock}
            onClick={() => update({ inStock: !filters.inStock })}
          >
            In stock
          </Option>
        </OptionGroup>
      )}
      <CategoryFilter
        level={level}
        groups={options.categoryGroups}
        selected={filters.category}
        onSelect={(v) => toggle("category", v)}
      />
      {options.sizes.length > 0 && (
        <FilterGroup
          level={level}
          title="Size"
          options={options.sizes}
          selected={filters.size}
          onSelect={(v) => toggle("size", v)}
        />
      )}
      <FilterGroup
        level={level}
        title="Fabric"
        options={options.fabrics}
        selected={filters.fabric}
        onSelect={(v) => toggle("fabric", v)}
      />
      <FilterGroup
        level={level}
        title="Colour"
        options={options.colours}
        selected={filters.colour}
        onSelect={(v) => toggle("colour", v)}
      />
      {steps.length > 0 && (
        <OptionGroup level={level} title="Price">
          {steps.map((price) => (
            <Option
              key={price}
              selected={filters.maxPrice === price}
              onClick={() =>
                update({ maxPrice: filters.maxPrice === price ? null : price })
              }
            >
              Under {formatINR(price)}
            </Option>
          ))}
        </OptionGroup>
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
        <div className="flex items-center justify-between border-b border-ink/10 px-6 py-4">
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
        <div className="flex-1 overflow-y-auto px-6 py-6">{content(3)}</div>
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
      {/* Desktop sidebar */}
      <aside aria-label="Filters" className="hidden w-56 flex-shrink-0 lg:block">
        {content(2)}
      </aside>

      {/* Portalled so everything else on <body> can be made inert. On the
          server there is no <body> to portal to — and the drawer is never open
          on a first render — so there it renders in place. */}
      {drawer &&
        (typeof document === "undefined" ? drawer : createPortal(drawer, document.body))}
    </>
  );
}

type HeadingLevel = 2 | 3;

/**
 * The catalogue matches values case-insensitively (sameCatalogueValue), so a
 * shared link reading ?fabric=cotton filters to "Cotton" — and the Cotton
 * option has to show as chosen, and tapping it has to undo it.
 */
const same = (a: string | null, b: string) =>
  a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

function GroupHeading({ level, children }: { level: HeadingLevel; children: ReactNode }) {
  const Tag = level === 2 ? "h2" : "h3";
  return <Tag className="font-heading text-lg text-ink">{children}</Tag>;
}

function OptionGroup({
  level,
  title,
  children,
}: {
  level: HeadingLevel;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <GroupHeading level={level}>{title}</GroupHeading>
      <div className="mt-3 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/**
 * One toggle. A button with aria-pressed, so "Cotton, toggle button, pressed"
 * is what a screen reader hears — before this the chosen option was only a
 * colour change.
 *
 * Chosen is white on ink rather than white on terracotta: the latter measured
 * 3.64:1, short of 4.5:1 for 14px text (logged for this PR by PR #170).
 */
function Option({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "min-h-[40px] rounded-full border px-4 py-2 text-sm transition-colors",
        selected
          ? "border-ink bg-ink text-cream"
          : "border-ink/15 text-ink hover:border-ink/50"
      )}
    >
      {children}
    </button>
  );
}

function CategoryFilter({
  level,
  groups,
  selected,
  onSelect,
}: {
  level: HeadingLevel;
  groups: CategoryFilterGroup[];
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  const offered = groups.filter((g) => g.children.length > 0);
  if (offered.length === 0) return null;

  return (
    <div>
      <GroupHeading level={level}>Category</GroupHeading>
      <div className="mt-3 space-y-4">
        {offered.map((group) => (
          <div key={group.name}>
            <p className="text-xs uppercase tracking-wider text-ink-muted">
              {group.name}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {group.children.map((child) => (
                <Option
                  key={child.slug}
                  selected={selected === child.slug}
                  onClick={() => onSelect(child.slug)}
                >
                  {child.name}
                </Option>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterGroup({
  level,
  title,
  options,
  selected,
  onSelect,
}: {
  level: HeadingLevel;
  title: string;
  options: string[];
  selected: string | null;
  onSelect: (value: string) => void;
}) {
  if (options.length === 0) return null;

  return (
    <OptionGroup level={level} title={title}>
      {options.map((opt) => (
        <Option key={opt} selected={same(selected, opt)} onClick={() => onSelect(opt)}>
          {opt}
        </Option>
      ))}
    </OptionGroup>
  );
}
