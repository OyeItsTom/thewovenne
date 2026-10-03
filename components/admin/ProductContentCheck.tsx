"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import {
  statusOf,
  type ContentCheck,
  type ContentField,
  type Evidence,
  type Finding,
  type Suggestion,
} from "@/lib/productContent";

/**
 * The "Product content check" panel in the product form.
 *
 * Display only. It is handed findings and reports two choices back up — use a
 * suggestion, or ignore a finding — and the form decides what that means. It
 * cannot save, publish or reach the database, and every button in it is
 * type="button" so none of them can submit the form it sits inside.
 *
 * A suggestion is always shown as a suggestion: boxed apart from the fields,
 * labelled, and with a line saying it is not saved until the form is.
 */

const FIELD_LABEL: Record<ContentField, string> = {
  name: "Name",
  description: "Description",
  fabric: "Fabric",
  colour: "Colour",
  sizes: "Sizes",
};
const FIELD_ORDER: ContentField[] = ["name", "description", "fabric", "colour", "sizes"];

/** The evidence label in words a non-technical admin can act on. */
const EVIDENCE_LABEL: Record<Evidence, string> = {
  VERIFIED: "From what you entered",
  DERIVED: "Tidied from what you entered",
  UNCERTAIN: "Unconfirmed — please check",
  MISSING: "Not entered",
};

const STATUS = {
  ok: { icon: CheckCircle2, text: "Looks good", tone: "text-emerald-700" },
  warn: { icon: AlertTriangle, text: "Needs review", tone: "text-amber-700" },
  problem: { icon: XCircle, text: "Missing or conflicting information", tone: "text-terracotta-dark" },
} as const;

export default function ProductContentCheck({
  check,
  ignored,
  onIgnore,
  onRestoreIgnored,
  onUse,
  saveLabel,
}: {
  /** Null until there is something to check (see contentCheckStarted): a neutral prompt shows instead. */
  check: ContentCheck | null;
  ignored: ReadonlySet<string>;
  onIgnore: (id: string) => void;
  onRestoreIgnored: () => void;
  onUse: (suggestion: Suggestion) => void;
  /** The form's own save button text, so the panel can say what actually saves. */
  saveLabel: string;
}) {
  const [showIgnored, setShowIgnored] = useState(false);

  if (!check) {
    return (
      <section
        aria-labelledby="content-check-title"
        className="space-y-1 rounded-xl border border-ink/10 bg-linen/30 p-4"
      >
        <h3 id="content-check-title" className="font-heading text-lg text-ink">
          Product content check
        </h3>
        <p className="text-sm text-ink/60" role="status">
          Enter a product name to start the content check.
        </p>
      </section>
    );
  }

  const visible = check.findings.filter((f) => showIgnored || !ignored.has(f.id));
  const hiddenCount = check.findings.filter((f) => ignored.has(f.id)).length;
  // The headline reflects what is still showing: ignoring a warning is the
  // admin deciding it does not apply.
  const status = statusOf(check.findings.filter((f) => !ignored.has(f.id)));
  const S = STATUS[status];

  return (
    <section
      aria-labelledby="content-check-title"
      className="space-y-3 rounded-xl border border-ink/10 bg-linen/30 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="content-check-title" className="font-heading text-lg text-ink">
          Product content check
        </h3>
        <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${S.tone}`} role="status">
          <S.icon className="h-4 w-4" aria-hidden />
          {S.text}
        </span>
      </div>
      <p className="text-xs text-ink/55">
        Checks what you have typed, as you type. Suggestions only fill in the
        form when you press &ldquo;Use suggestion&rdquo; — nothing is saved until
        you press {saveLabel}, and nothing goes live until you publish.
      </p>

      {FIELD_ORDER.map((field) => {
        const items = visible.filter((f) => f.field === field);
        if (items.length === 0) return null;
        return (
          <div key={field} className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wider text-ink/50">
              {FIELD_LABEL[field]}
            </h4>
            {items.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                isIgnored={ignored.has(f.id)}
                onIgnore={() => onIgnore(f.id)}
                onUse={onUse}
              />
            ))}
          </div>
        );
      })}

      {check.missing.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wider text-ink/50">
            Needs confirmation
          </h4>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink/70">
            {check.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {hiddenCount > 0 && (
        <div className="flex gap-3 text-xs text-ink/50">
          <button type="button" onClick={() => setShowIgnored((v) => !v)} className="underline-offset-2 hover:underline">
            {showIgnored ? "Hide ignored" : `${hiddenCount} ignored — show`}
          </button>
          <button
            type="button"
            onClick={() => {
              onRestoreIgnored();
              setShowIgnored(false);
            }}
            className="underline-offset-2 hover:underline"
          >
            Un-ignore all
          </button>
        </div>
      )}
    </section>
  );
}

function FindingRow({
  finding: f,
  isIgnored,
  onIgnore,
  onUse,
}: {
  finding: Finding;
  isIgnored: boolean;
  onIgnore: () => void;
  onUse: (suggestion: Suggestion) => void;
}) {
  const Icon = f.level === "problem" ? XCircle : AlertTriangle;
  const tone = f.level === "problem" ? "text-terracotta-dark" : "text-amber-700";
  return (
    <div className={`rounded-lg bg-cream/80 p-3 text-sm ${isIgnored ? "opacity-50" : ""}`}>
      <div className="flex gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-label={f.level === "problem" ? "Problem" : "Warning"} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-ink/85">{f.message}</p>
          <p className="text-[11px] uppercase tracking-wider text-ink/40">{EVIDENCE_LABEL[f.evidence]}</p>

          {f.suggestion && (
            <div className="rounded-md border border-dashed border-ink/20 bg-white px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink/45">Suggestion</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-ink">{f.suggestion.value}</p>
            </div>
          )}

          {f.reasons && f.reasons.length > 0 && (
            <ul className="space-y-0.5 text-xs text-ink/60">
              {f.reasons.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
          )}

          {!isIgnored && (
            <div className="flex flex-wrap gap-2 pt-1">
              {f.suggestion && (
                <button
                  type="button"
                  onClick={() => onUse(f.suggestion!)}
                  className="rounded-full bg-ink px-3 py-1 text-xs text-cream transition-colors hover:bg-ink-light"
                >
                  Use suggestion
                </button>
              )}
              <button
                type="button"
                onClick={onIgnore}
                className="rounded-full border border-ink/20 px-3 py-1 text-xs text-ink/70 transition-colors hover:border-ink"
              >
                Ignore
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
