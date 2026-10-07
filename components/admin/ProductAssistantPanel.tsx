"use client";

import { useState } from "react";
import Image from "next/image";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  COPY_FIELD_LABEL,
  SUGGESTION_MAX,
  type AltSuggestion,
  type AssistantSuggestions,
  type Basis,
  type CopyField,
  type SuggestionIssue,
} from "@/lib/ai/productAssistant";

/**
 * "Suggest with AI" in the product form: the button, and the review of what
 * comes back.
 *
 * ══ IT CANNOT CHANGE ANYTHING BY ITSELF ══
 *
 * It is handed suggestions and reports choices back up — use this text in this
 * field, or put the old text back — and the form decides what that means.
 * There is no "use all": every field is read and accepted on its own. It
 * cannot save, publish or reach the database, and every button is
 * type="button" so none can submit the form it sits inside.
 *
 * ══ FLAGGED MEANS NOT USABLE YET ══
 *
 * A suggestion that says something the product data does not (see
 * lib/ai/productClaims) is shown with the reason, and its Use button stays off
 * until the admin edits the text clean. The check runs on whatever is in the
 * box, against the form's facts as they are now.
 */

export type AssistantState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      suggestions: AssistantSuggestions;
      photosSent: number;
      imagesDropped: number;
      requestId: number;
    };

const BASIS_LABEL: Record<Basis, string> = {
  category: "category",
  product_type: "product type",
  fabric: "fabric",
  colour: "colour",
  dimensions: "dimensions",
  blouse_piece: "blouse piece",
  finish: "finish",
  weave: "weave",
  origin: "origin",
  care: "care",
  fit: "fit",
  heritage_note: "heritage note",
  craft_note: "craft note",
  current_name: "current name",
  current_description: "current description",
  current_seo_title: "current SEO title",
  current_meta_description: "current meta description",
  photo: "the photo",
};

type Decision = { kind: "used"; previous: string } | { kind: "kept" };

export default function ProductAssistantPanel({
  state,
  canRequest,
  blockedReason,
  onRequest,
  onCancel,
  current,
  emptyText,
  photos,
  review,
  onUseField,
  onUseAlt,
}: {
  state: AssistantState;
  canRequest: boolean;
  /** Why the button is off, when it is. */
  blockedReason?: string;
  onRequest: () => void;
  onCancel: () => void;
  /** The form's values now, so "Current" is never stale. */
  current: Record<CopyField, string>;
  /** What an empty field means on the shop — the SEO fallbacks, in words. */
  emptyText: Record<CopyField, string>;
  photos: { url: string; alt: string }[];
  /** Re-check text against the form as it is now. */
  review: (field: CopyField | "alt", text: string, url?: string) => SuggestionIssue[];
  onUseField: (field: CopyField, value: string) => void;
  onUseAlt: (url: string, value: string) => void;
}) {
  const ready = state.status === "ready" ? state : null;
  const nothing = ready && ready.suggestions.fields.length === 0 && ready.suggestions.alts.length === 0;

  return (
    <section aria-labelledby="assistant-title" className="space-y-3 rounded-xl border border-ink/10 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="assistant-title" className="font-heading text-lg text-ink">
          Writing suggestions
        </h3>
        {state.status === "loading" ? (
          <span className="inline-flex items-center gap-2 text-sm text-ink/60" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Writing suggestions…
            <button type="button" onClick={onCancel} className="text-xs text-ink/50 underline-offset-2 hover:underline">
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onRequest}
            disabled={!canRequest}
            className="rounded-full border border-ink/15 px-4 py-2 text-sm text-ink transition-colors hover:border-terracotta disabled:opacity-40 disabled:hover:border-ink/15"
          >
            {ready ? "Suggest again" : "Suggest with AI"}
          </button>
        )}
      </div>

      <p className="text-xs text-ink/55">
        {ready?.suggestions.sawImages
          ? "Written by AI from the product details you entered, and alt text from looking at each photo. "
          : "Written by AI from the product details you entered. "}
        It can only use those details — anything blank stays unknown. Check each suggestion: nothing changes until
        you press &ldquo;Use&rdquo;, and nothing is saved until you press Save draft.
      </p>
      {!canRequest && blockedReason && state.status !== "loading" && (
        <p className="text-xs text-ink/50">{blockedReason}</p>
      )}

      {state.status === "error" && (
        <p role="alert" className="rounded-lg bg-terracotta/5 px-3 py-2 text-sm text-terracotta-dark">
          {state.message}
        </p>
      )}

      {nothing && (
        <p className="text-sm text-ink/60" role="status">
          No changes suggested — the current copy already covers what the product details say.
        </p>
      )}

      {ready && ready.imagesDropped > 0 && (
        <p className="text-xs text-ink/50">
          Only the first {ready.photosSent} photos were sent for alt text — {ready.imagesDropped} later photo
          {ready.imagesDropped === 1 ? " was" : "s were"} left for you to describe.
        </p>
      )}

      {ready && (
        <div key={ready.requestId} className="space-y-3">
          {ready.suggestions.fields.map((s) => (
            <SuggestionRow
              key={s.field}
              label={COPY_FIELD_LABEL[s.field]}
              current={current[s.field]}
              emptyText={emptyText[s.field]}
              suggestion={s.suggestion}
              basis={s.basis}
              max={SUGGESTION_MAX[s.field]}
              multiline={s.field === "description" || s.field === "metaDescription"}
              review={(text) => review(s.field, text)}
              onUse={(v) => onUseField(s.field, v)}
            />
          ))}
          {ready.suggestions.alts.map((a) => (
            <AltRow key={a.url} alt={a} photos={photos} review={review} onUseAlt={onUseAlt} />
          ))}
        </div>
      )}
    </section>
  );
}

function AltRow({
  alt,
  photos,
  review,
  onUseAlt,
}: {
  alt: AltSuggestion;
  photos: { url: string; alt: string }[];
  review: (field: "alt", text: string, url?: string) => SuggestionIssue[];
  onUseAlt: (url: string, value: string) => void;
}) {
  const index = photos.findIndex((p) => p.url === alt.url);
  const photo = index >= 0 ? photos[index] : null;
  return (
    <SuggestionRow
      label={photo ? (index === 0 ? "Main image alt text" : `Photo ${index + 1} alt text`) : "Alt text"}
      thumb={alt.url}
      current={photo?.alt ?? ""}
      emptyText="Empty — the shop uses the product name."
      suggestion={alt.suggestion}
      basis={alt.basis}
      max={SUGGESTION_MAX.alt}
      gone={!photo}
      review={(text) => review("alt", text, alt.url)}
      onUse={(v) => onUseAlt(alt.url, v)}
    />
  );
}

function SuggestionRow({
  label,
  thumb,
  current,
  emptyText,
  suggestion,
  basis,
  max,
  multiline,
  gone,
  review,
  onUse,
}: {
  label: string;
  thumb?: string;
  current: string;
  emptyText: string;
  suggestion: string;
  basis: Basis[];
  max: number;
  multiline?: boolean;
  /** The photo was removed from the form after the suggestion was written. */
  gone?: boolean;
  review: (text: string) => SuggestionIssue[];
  onUse: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const text = draft ?? suggestion;
  const issues = review(text);
  const blank = !text.trim();
  const id = `assist-${label.replace(/\W+/g, "-").toLowerCase()}`;

  if (decision) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-linen/40 px-3 py-2 text-sm">
        <span className="text-ink/70">
          <span className="font-medium text-ink">{label}</span> —{" "}
          {decision.kind === "used" ? "suggestion is in the form, not saved yet." : "kept the current text."}
        </span>
        <button
          type="button"
          onClick={() => {
            if (decision.kind === "used") onUse(decision.previous);
            setDecision(null);
          }}
          className="text-xs text-ink/55 underline-offset-2 hover:underline"
        >
          {decision.kind === "used" ? "Undo" : "Review again"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-ink/10 p-3 text-sm" aria-labelledby={`${id}-label`}>
      <div className="flex items-start gap-3">
        {thumb && (
          <div className="relative aspect-[4/5] w-12 shrink-0 overflow-hidden rounded bg-linen">
            <Image src={thumb} alt="" fill sizes="48px" className="object-cover" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <p id={`${id}-label`} className="text-xs font-medium uppercase tracking-wider text-ink/50">
            {label}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-ink/40">Current</p>
              <p className={`mt-0.5 whitespace-pre-wrap break-words ${current.trim() ? "text-ink/80" : "italic text-ink/45"}`}>
                {current.trim() || emptyText}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-ink/40">AI suggestion</p>
              {draft == null ? (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-ink">{suggestion}</p>
              ) : multiline ? (
                <textarea
                  aria-label={`Edit the ${label} suggestion`}
                  value={draft}
                  maxLength={max}
                  rows={4}
                  onChange={(e) => setDraft(e.target.value)}
                  className="mt-0.5 w-full rounded-md border border-ink/15 bg-cream px-2 py-1.5 text-sm text-ink focus:border-terracotta focus:outline-none"
                />
              ) : (
                <input
                  aria-label={`Edit the ${label} suggestion`}
                  value={draft}
                  maxLength={max}
                  onChange={(e) => setDraft(e.target.value)}
                  className="mt-0.5 w-full rounded-md border border-ink/15 bg-cream px-2 py-1.5 text-sm text-ink focus:border-terracotta focus:outline-none"
                />
              )}
              <p className="mt-1 text-[11px] text-ink/40">
                {text.trim().length}/{max}
                {basis.length > 0 && ` · Based on: ${basis.map((b) => BASIS_LABEL[b]).join(", ")}`}
              </p>
            </div>
          </div>

          {issues.length > 0 && (
            <ul className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800" aria-label="Problems with this suggestion">
              {issues.map((i, n) => (
                <li key={`${i.kind}-${i.term ?? n}`} className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    {i.term && <span className="font-medium">&ldquo;{i.term}&rdquo;: </span>}
                    {i.reason}
                  </span>
                </li>
              ))}
              <li className="pl-5 text-amber-700/80">Edit the suggestion to remove this before using it.</li>
            </ul>
          )}

          {gone ? (
            <p className="text-xs text-ink/50">This photo is no longer in the form.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={issues.length > 0 || blank}
                onClick={() => {
                  setDecision({ kind: "used", previous: current });
                  onUse(text.trim());
                }}
                className="rounded-full bg-ink px-3 py-1 text-xs text-cream transition-colors hover:bg-ink-light disabled:cursor-not-allowed disabled:opacity-35"
              >
                {draft == null ? "Use suggestion" : "Use edited text"}
              </button>
              {draft == null && (
                <button
                  type="button"
                  onClick={() => setDraft(suggestion)}
                  className="rounded-full border border-ink/20 px-3 py-1 text-xs text-ink/70 transition-colors hover:border-ink"
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                onClick={() => setDecision({ kind: "kept" })}
                className="rounded-full border border-ink/20 px-3 py-1 text-xs text-ink/70 transition-colors hover:border-ink"
              >
                Keep current
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
