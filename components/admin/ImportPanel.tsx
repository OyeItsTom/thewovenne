"use client";

import { useRef, useState } from "react";
import { AlertTriangle, Check, Download, Loader2, Upload } from "lucide-react";
import { IMPORT_KINDS, type ImportKind, type ImportPreview } from "@/lib/imports";

/**
 * Download a template, fill it in, upload it, look at what it would do, commit.
 *
 * THE PREVIEW IS THE POINT. "12 products updated" is not something anyone can
 * review; "KASAVU-01: cost 1900 → 2100" is. Nothing is written until the
 * preview has been seen and the commit button pressed.
 *
 * The file is uploaded twice — once to validate, once to commit — because the
 * server re-reads it rather than trusting the preview it sent back. Sending the
 * parsed rows up for commit would mean whatever the browser said was written.
 */
export default function ImportPanel() {
  const [kind, setKind] = useState<ImportKind>(IMPORT_KINDS[0]);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportPreview | null>(null);
  const [committed, setCommitted] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset(next?: ImportKind) {
    if (next) setKind(next);
    setFile(null);
    setResult(null);
    setCommitted(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function downloadTemplate() {
    setBusy("template");
    setError(null);
    try {
      const form = new FormData();
      form.set("mode", "template");
      form.set("kind", kind.id);
      const res = await fetch("/api/admin/import", { method: "POST", body: form });
      if (!res.ok) throw new Error("Could not build that template.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `wovenne-${kind.id}-template.xlsx`;
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

  async function send(mode: "validate" | "commit") {
    if (!file) return;
    setBusy(mode);
    setError(null);
    try {
      const form = new FormData();
      form.set("mode", mode);
      form.set("kind", kind.id);
      form.set("file", file);
      const res = await fetch("/api/admin/import", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "That file could not be read.");
      setResult(data as ImportPreview);
      if (mode === "commit") setCommitted(data.applied ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const blocked = (result?.counts.errors ?? 0) > 0;
  const willDo = (result?.counts.create ?? 0) + (result?.counts.update ?? 0);

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {IMPORT_KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => reset(k)}
            className={`rounded-full px-4 py-2 text-sm transition-colors ${
              k.id === kind.id
                ? "bg-ink text-cream"
                : "border border-ink/15 text-ink/70 hover:border-ink/40"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="space-y-4 rounded-2xl border border-ink/10 bg-cream p-5">
        <div>
          <h3 className="font-heading text-xl text-ink">{kind.label}</h3>
          <p className="mt-1 text-sm text-ink/60">{kind.blurb}</p>
        </div>

        {/* Said before anything is chosen, not after. What an import will and
            will not touch is the thing someone needs to know first. */}
        <p className="rounded-lg bg-linen/70 px-3 py-2.5 text-xs leading-relaxed text-ink/75">
          {kind.safety}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={downloadTemplate}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-full border border-ink/20 px-5 py-2.5 text-sm text-ink transition-colors hover:border-ink hover:bg-ink hover:text-cream disabled:opacity-50"
          >
            {busy === "template" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download template
          </button>

          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              setCommitted(null);
              setError(null);
            }}
            className="text-xs text-ink/70 file:mr-3 file:rounded-full file:border-0 file:bg-ink/5 file:px-4 file:py-2 file:text-xs file:text-ink hover:file:bg-ink/10"
          />

          {file && !result && (
            <button
              onClick={() => send("validate")}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-full bg-terracotta px-5 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-terracotta-dark disabled:opacity-50"
            >
              {busy === "validate" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Check this file
            </button>
          )}
        </div>

        <details className="text-xs text-ink/60">
          <summary className="cursor-pointer text-ink/70">Columns this expects</summary>
          <ul className="mt-2 space-y-1">
            {kind.fields.map((f) => (
              <li key={f.key}>
                <strong className="font-medium text-ink/80">{f.header}</strong>
                {f.required ? " (required)" : " (optional)"}
                {f.hint ? ` — ${f.hint}` : ""}
              </li>
            ))}
          </ul>
        </details>
      </div>

      {result && (
        <div className="space-y-4 rounded-2xl border border-ink/10 bg-cream p-5">
          {committed !== null ? (
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <Check className="h-4 w-4 text-terracotta" />
              Imported — {committed} row{committed === 1 ? "" : "s"} written.
              {kind.id === "products" &&
                " Check Review & Publish to put the changes live."}
            </p>
          ) : (
            <>
              <h3 className="font-heading text-xl text-ink">
                What this would do
              </h3>
              <div className="flex flex-wrap gap-2 text-xs">
                <Pill label={`${result.counts.create} new`} />
                <Pill label={`${result.counts.update} updated`} />
                <Pill label={`${result.counts.skip} unchanged`} muted />
                {result.counts.errors > 0 && (
                  <Pill label={`${result.counts.errors} with problems`} danger />
                )}
              </div>
            </>
          )}

          <div className="max-h-96 overflow-auto rounded-lg border border-ink/10">
            <table className="w-full text-xs">
              <tbody>
                {result.rows.map((r) => (
                  <tr
                    key={r.row}
                    className={`border-b border-ink/8 ${
                      r.errors.length ? "bg-terracotta/8" : ""
                    }`}
                  >
                    <td className="w-16 px-3 py-2 text-ink/40">Row {r.row}</td>
                    <td className="px-3 py-2 text-ink/75">
                      {r.errors.length > 0 ? (
                        <span className="text-terracotta-dark">
                          <AlertTriangle className="mr-1 inline h-3 w-3" />
                          {r.errors.join("; ")}
                        </span>
                      ) : (
                        r.summary || "No change"
                      )}
                    </td>
                    <td className="w-24 px-3 py-2 text-right uppercase tracking-wider text-ink/40">
                      {r.errors.length ? "—" : r.action}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {committed === null && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => send("commit")}
                disabled={busy !== null || blocked || willDo === 0}
                className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-50"
              >
                {busy === "commit" && <Loader2 className="h-4 w-4 animate-spin" />}
                {blocked
                  ? "Fix the problems first"
                  : willDo === 0
                    ? "Nothing to import"
                    : `Import ${willDo} row${willDo === 1 ? "" : "s"}`}
              </button>
              <button onClick={() => reset()} className="text-sm text-ink/50 hover:text-ink">
                Start again
              </button>
              {blocked && (
                <p className="text-xs text-ink/60">
                  Nothing is imported while any row has a problem — a half-applied
                  file is worse than none.
                </p>
              )}
            </div>
          )}

          {committed !== null && (
            <button onClick={() => reset()} className="text-sm text-ink/50 hover:text-ink">
              Import another file
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Pill({
  label,
  muted,
  danger,
}: {
  label: string;
  muted?: boolean;
  danger?: boolean;
}) {
  return (
    <span
      className={`rounded-full px-3 py-1.5 ${
        danger
          ? "bg-terracotta/15 text-terracotta-dark"
          : muted
            ? "border border-ink/12 text-ink/50"
            : "border border-ink/15 text-ink/75"
      }`}
    >
      {label}
    </span>
  );
}
