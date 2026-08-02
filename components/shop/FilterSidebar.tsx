"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { cn, formatINR } from "@/lib/utils";
import { slideInFromLeft } from "@/lib/motion";

export interface Filters {
  category: string | null;
  fabric: string | null;
  colour: string | null;
  size: string | null;
  maxPrice: number | null;
}

export interface CategoryFilterGroup {
  name: string;
  children: { name: string; slug: string }[];
}

export interface FilterOptions {
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
}

export const EMPTY_FILTERS: Filters = {
  category: null,
  fabric: null,
  colour: null,
  size: null,
  maxPrice: null,
};

const PRICE_STEPS = [1500, 2500, 3500, 5000];

export default function FilterSidebar({
  options,
  filters,
  onChange,
  isOpen,
  onClose,
}: {
  options: FilterOptions;
  filters: Filters;
  onChange: (filters: Filters) => void;
  isOpen: boolean;
  onClose: () => void;
}) {
  const reduced = useReducedMotion();
  const panel = slideInFromLeft(reduced);

  const update = (patch: Partial<Filters>) =>
    onChange({ ...filters, ...patch });

  const hasActiveFilters =
    filters.category ||
    filters.fabric ||
    filters.colour ||
    filters.size ||
    filters.maxPrice;

  const content = (
    <div className="space-y-8">
      <CategoryFilter
        groups={options.categoryGroups}
        selected={filters.category}
        onSelect={(v) =>
          update({ category: filters.category === v ? null : v })
        }
      />
      {options.sizes.length > 0 && (
        <FilterGroup
          title="Size"
          options={options.sizes}
          selected={filters.size}
          onSelect={(v) => update({ size: filters.size === v ? null : v })}
        />
      )}
      <FilterGroup
        title="Fabric"
        options={options.fabrics}
        selected={filters.fabric}
        onSelect={(v) => update({ fabric: filters.fabric === v ? null : v })}
      />
      <FilterGroup
        title="Colour"
        options={options.colours}
        selected={filters.colour}
        onSelect={(v) => update({ colour: filters.colour === v ? null : v })}
      />
      <div>
        <h3 className="font-heading text-lg text-ink">Price</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {PRICE_STEPS.map((price) => (
            <button
              key={price}
              onClick={() =>
                update({ maxPrice: filters.maxPrice === price ? null : price })
              }
              className={cn(
                "rounded-full border px-4 py-2 text-sm transition-colors",
                filters.maxPrice === price
                  ? "border-terracotta bg-terracotta text-cream"
                  : "border-ink/15 text-ink hover:border-terracotta"
              )}
            >
              Under {formatINR(price)}
            </button>
          ))}
        </div>
      </div>
      {hasActiveFilters && (
        <button
          onClick={() => onChange(EMPTY_FILTERS)}
          className="text-sm uppercase tracking-wider text-terracotta underline-offset-4 hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-64 flex-shrink-0 lg:block">{content}</aside>

      {/* Mobile slide-in drawer */}
      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-[70] lg:hidden">
            <motion.div
              className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={onClose}
              aria-hidden
            />
            <motion.div
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={panel}
              className="relative h-full w-full max-w-xs overflow-y-auto bg-cream p-6 shadow-lift"
            >
              <div className="flex items-center justify-between">
                <h2 className="font-heading text-2xl text-ink">Filters</h2>
                <button
                  onClick={onClose}
                  aria-label="Close filters"
                  className="text-ink/50 transition-colors hover:text-ink"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="mt-6">{content}</div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

function CategoryFilter({
  groups,
  selected,
  onSelect,
}: {
  groups: CategoryFilterGroup[];
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  if (groups.length === 0) return null;

  return (
    <div>
      <h3 className="font-heading text-lg text-ink">Category</h3>
      <div className="mt-3 space-y-4">
        {groups.map((group) => (
          <div key={group.name}>
            <p className="text-xs uppercase tracking-wider text-ink/50">
              {group.name}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {group.children.map((child) => (
                <button
                  key={child.slug}
                  onClick={() => onSelect(child.slug)}
                  className={cn(
                    "rounded-full border px-4 py-2 text-sm transition-colors",
                    selected === child.slug
                      ? "border-terracotta bg-terracotta text-cream"
                      : "border-ink/15 text-ink hover:border-terracotta"
                  )}
                >
                  {child.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterGroup({
  title,
  options,
  selected,
  onSelect,
}: {
  title: string;
  options: string[];
  selected: string | null;
  onSelect: (value: string) => void;
}) {
  if (options.length === 0) return null;

  return (
    <div>
      <h3 className="font-heading text-lg text-ink">{title}</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onSelect(opt)}
            className={cn(
              "rounded-full border px-4 py-2 text-sm transition-colors",
              selected === opt
                ? "border-terracotta bg-terracotta text-cream"
                : "border-ink/15 text-ink hover:border-terracotta"
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
