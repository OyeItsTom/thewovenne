"use client";

import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { profileLabel, type InfoAssessment, type InfoLevel } from "@/lib/productInfo";

/**
 * "Product completeness" — what this product still needs, in two lists that
 * mean different things:
 *
 *   REQUIRED BEFORE PUBLISHING — publishing is refused without these (0065).
 *   RECOMMENDED — better for customers and search, never blocks anything.
 *
 * Display only, like ProductContentCheck: it reads the assessment the form
 * computed from what is typed (lib/productInfo) and cannot save or publish.
 * Optional facts are listed by name only in the form itself, never counted
 * here: a percentage that rose by typing a guessed origin would reward the
 * one thing this shop must not do.
 */
export default function ProductInfoPanel({
  info,
  hidden,
  categoryChosen,
}: {
  info: InfoAssessment;
  /** The product is hidden: 0065 does not judge hidden versions at publish. */
  hidden: boolean;
  /** Until a sub-category is picked the type is unknown, not "General". */
  categoryChosen: boolean;
}) {
  const { missingRequired, missingRecommended, percent, publishable } = info;
  return (
    <section
      aria-labelledby="product-info-title"
      className="space-y-3 rounded-xl border border-ink/10 bg-linen/30 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="product-info-title" className="font-heading text-lg text-ink">
          Product completeness {percent}%
        </h3>
        <p className="text-xs text-ink/60">
          {categoryChosen ? (
            <>
              Type: <span className="font-medium text-ink/80">{profileLabel(info.profile)}</span> — set by the category
            </>
          ) : (
            "Choose a category to see which details apply"
          )}
        </p>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-ink/10"
        role="progressbar"
        aria-label="Product completeness"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={publishable ? "h-full bg-emerald-600" : "h-full bg-terracotta"}
          style={{ width: `${percent}%` }}
        />
      </div>

      {publishable ? (
        <p className="flex items-start gap-2 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Nothing required is missing — this can be published.
        </p>
      ) : (
        <div className="text-sm text-terracotta-dark">
          <p className="flex items-start gap-2 font-medium">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Complete these before publishing:
          </p>
          <ul className="ml-6 mt-1 list-disc space-y-0.5">
            {missingRequired.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
          <p className="ml-6 mt-1 text-xs text-ink/60">
            {hidden
              ? "This product is hidden, so publishing won't ask for these until it is shown again."
              : "You can still save a draft — only publishing waits for these."}
          </p>
        </div>
      )}

      {missingRecommended.length > 0 && (
        <div className="text-sm text-ink/70">
          <p className="flex items-start gap-2">
            <CircleDashed className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Recommended for customers and search:
          </p>
          <p className="ml-6 mt-0.5 text-ink/80">{missingRecommended.join(" · ")}</p>
          <p className="ml-6 mt-1 text-xs text-ink/50">
            Leave any of these empty if it genuinely isn&apos;t known — never guess.
          </p>
        </div>
      )}
    </section>
  );
}

const LEVEL_TEXT: Record<Exclude<InfoLevel, "na">, string> = {
  required: "Required",
  recommended: "Recommended",
  optional: "Optional",
};

const LEVEL_TONE: Record<Exclude<InfoLevel, "na">, string> = {
  required: "text-terracotta-dark",
  recommended: "text-ink/55",
  optional: "text-ink/40",
};

/** The small word beside a field's label: Required, Recommended or Optional. */
export function LevelTag({ level }: { level: InfoLevel }) {
  if (level === "na") return null;
  return (
    <span className={`ml-2 text-[11px] font-normal uppercase tracking-wider ${LEVEL_TONE[level]}`}>
      {LEVEL_TEXT[level]}
    </span>
  );
}
