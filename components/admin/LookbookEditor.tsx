"use client";

import { useState } from "react";
import Image from "next/image";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { uploadImage, UnsupportedImageError } from "@/lib/storage";
import type {
  LookbookContent,
  LookbookImage,
  LookbookLayout,
  LookbookSection,
} from "@/lib/types";

/**
 * The lookbook editor: repeatable full-bleed image blocks for the homepage.
 *
 * SIX IS THE CAP. Each block is a full screen of scrolling on a phone, and a
 * homepage that takes seven swipes to reach the products is not a shop front.
 * The limit is a nudge, not a technical constraint.
 *
 * Every section ships with Show unticked. A block appearing on the live site
 * the instant an image finishes uploading — before the crop has even been
 * looked at — is the wrong default.
 */

const MAX_SECTIONS = 6;

const LAYOUTS: { value: LookbookLayout; label: string; slots: number }[] = [
  { value: "single", label: "One full-width image", slots: 1 },
  { value: "split-2", label: "Two side by side", slots: 2 },
  { value: "split-3", label: "Three across", slots: 3 },
];

/**
 * Export sizes, shown next to the field rather than kept in a document nobody
 * opens. Each is the exact ratio the slot renders at, so an image at this size
 * fills it with nothing cropped and no bars.
 *
 * The desktop numbers differ per layout because the slot does: full width, a
 * half, or a third. The MOBILE number never changes, because phones stack
 * every layout into one full-width column.
 */
const DESKTOP_HINT: Record<LookbookLayout, string> = {
  single:
    "Export at 2400 × 1350 (16:9). This one spans the full width of the page, so it is the largest image on the site — export generously.",
  "split-2":
    "Export at 1800 × 2400 (3:4). Each image takes half the width on desktop, so it is tall rather than wide.",
  "split-3":
    "Export at 1280 × 1920 (2:3). Each image takes a third of the width on desktop, so it is taller again.",
};

const MOBILE_HINT =
  "Export at 1200 × 1500 (4:5). The same size for every layout — on phones the images always stack full-width, one after another. Leave this blank to reuse the desktop image.";

const EMPTY_IMAGE: LookbookImage = {
  image_url: "",
  image_url_mobile: "",
  href: "",
  alt: "",
};

function slotsFor(layout: LookbookLayout) {
  return LAYOUTS.find((l) => l.value === layout)?.slots ?? 1;
}

/** Resizes the image list to match the layout, keeping what was already set. */
function fitImages(images: LookbookImage[], layout: LookbookLayout) {
  const want = slotsFor(layout);
  const next = images.slice(0, want);
  while (next.length < want) next.push({ ...EMPTY_IMAGE });
  return next;
}

export default function LookbookEditor({
  value,
  onChange,
}: {
  value: LookbookContent;
  onChange: (next: LookbookContent) => void;
}) {
  const sections = value.sections ?? [];

  const setSections = (next: LookbookSection[]) => onChange({ sections: next });

  const patch = (id: string, changes: Partial<LookbookSection>) =>
    setSections(sections.map((s) => (s.id === id ? { ...s, ...changes } : s)));

  const patchImage = (id: string, index: number, changes: Partial<LookbookImage>) =>
    setSections(
      sections.map((s) =>
        s.id === id
          ? {
              ...s,
              images: s.images.map((img, i) =>
                i === index ? { ...img, ...changes } : img
              ),
            }
          : s
      )
    );

  const addSection = () => {
    if (sections.length >= MAX_SECTIONS) return;
    setSections([
      ...sections,
      {
        // crypto.randomUUID keeps keys stable across reorders, so React does
        // not rebuild a section — and lose a half-typed link — when it moves.
        id: crypto.randomUUID(),
        enabled: false,
        layout: "single",
        images: [{ ...EMPTY_IMAGE }],
      },
    ]);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    [next[index], next[target]] = [next[target], next[index]];
    setSections(next);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2 rounded-lg bg-linen px-3 py-2.5 text-xs leading-relaxed text-ink/60">
        <p>
          Full-width image blocks, shown just below the hero. On phones the
          images always stack one under another — a three-across split would be
          three slivers. Sections stay off the site until you tick{" "}
          <strong className="font-medium">Show</strong>, and an empty section
          never appears at all.
        </p>
        <p>
          {/* Corrects the instinct to hit a KB budget by hand. The site
              re-encodes every image on the way out, so a pre-compressed upload
              only gives the optimiser less to work with. */}
          <strong className="font-medium">On file size and format:</strong>{" "}
          upload the best quality you have — JPEG, PNG or WebP. The site resizes
          each image and converts it to WebP or AVIF when it serves it, so
          there&apos;s no need to compress to a target size first. Squeezing a
          file down before uploading only makes the version customers see worse.
          HEIC is refused; export as JPEG instead.
        </p>
      </div>

      {sections.length === 0 && (
        <p className="py-6 text-center text-sm text-ink/50">
          No lookbook sections yet.
        </p>
      )}

      {sections.map((section, index) => (
        <section
          key={section.id}
          className="rounded-xl border border-ink/10 bg-cream p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-wider text-ink/40">
                Section {index + 1}
              </span>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={section.enabled}
                  onChange={(e) => patch(section.id, { enabled: e.target.checked })}
                  className="h-4 w-4 accent-terracotta"
                />
                <span className="text-ink/70">Show</span>
              </label>
            </div>

            <div className="flex items-center gap-1">
              <IconButton
                label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </IconButton>
              <IconButton
                label="Move down"
                disabled={index === sections.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </IconButton>
              <IconButton
                label="Remove section"
                onClick={() =>
                  setSections(sections.filter((s) => s.id !== section.id))
                }
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          </div>

          <label className="mt-4 block text-sm">
            <span className="font-medium text-ink/70">Layout</span>
            <select
              value={section.layout}
              onChange={(e) => {
                const layout = e.target.value as LookbookLayout;
                patch(section.id, {
                  layout,
                  images: fitImages(section.images, layout),
                });
              }}
              className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
            >
              {LAYOUTS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {section.images.map((image, i) => (
              <ImageSlot
                key={i}
                index={i}
                total={section.images.length}
                layout={section.layout}
                image={image}
                onChange={(changes) => patchImage(section.id, i, changes)}
              />
            ))}
          </div>
        </section>
      ))}

      <button
        type="button"
        onClick={addSection}
        disabled={sections.length >= MAX_SECTIONS}
        className="inline-flex items-center gap-2 rounded-full border border-ink/15 px-4 py-2 text-sm text-ink transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="h-4 w-4" />
        Add section
        {sections.length >= MAX_SECTIONS && " (6 is the limit)"}
      </button>
    </div>
  );
}

function ImageSlot({
  index,
  total,
  layout,
  image,
  onChange,
}: {
  index: number;
  total: number;
  layout: LookbookLayout;
  image: LookbookImage;
  onChange: (changes: Partial<LookbookImage>) => void;
}) {
  return (
    <div className="rounded-lg border border-ink/10 p-3">
      {total > 1 && (
        <p className="mb-2 text-xs uppercase tracking-wider text-ink/40">
          Image {index + 1}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <UploadField
          label="Desktop"
          hint={DESKTOP_HINT[layout]}
          url={image.image_url}
          onUploaded={(url) => onChange({ image_url: url })}
        />
        <UploadField
          label="Mobile (optional)"
          hint={MOBILE_HINT}
          url={image.image_url_mobile}
          onUploaded={(url) => onChange({ image_url_mobile: url })}
        />
      </div>

      <label className="mt-3 block text-sm">
        <span className="font-medium text-ink/70">Links to</span>
        <input
          value={image.href}
          onChange={(e) => onChange({ href: e.target.value })}
          placeholder="/women/sarees"
          className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
        />
        <span className="mt-1 block text-xs text-ink/45">
          A path on the site, e.g. /shop or /women/sarees. Leave blank to make
          the image unclickable.
        </span>
      </label>

      <label className="mt-3 block text-sm">
        <span className="font-medium text-ink/70">Describe the image</span>
        <input
          value={image.alt}
          onChange={(e) => onChange({ alt: e.target.value })}
          placeholder="Linen saree in indigo, worn draped"
          className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
        />
        <span className="mt-1 block text-xs text-ink/45">
          Read aloud to anyone using a screen reader. Leave blank only if the
          image is purely decorative.
        </span>
      </label>
    </div>
  );
}

function UploadField({
  label,
  hint,
  url,
  onUploaded,
}: {
  label: string;
  hint?: string;
  url: string;
  onUploaded: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onUploaded(await uploadImage(file, "lookbook"));
    } catch (err) {
      // HEIC is the common one, and the message from storage.ts explains how
      // to fix it on an iPhone rather than just refusing.
      setError(
        err instanceof UnsupportedImageError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Upload failed"
      );
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div>
      <p className="text-xs font-medium text-ink/70">{label}</p>

      <div className="mt-1.5 overflow-hidden rounded-lg border border-ink/10 bg-linen/40">
        {url ? (
          <div className="relative aspect-[4/5]">
            <Image src={url} alt="" fill sizes="200px" className="object-cover" />
          </div>
        ) : (
          <div className="flex aspect-[4/5] items-center justify-center text-xs text-ink/35">
            No image
          </div>
        )}
      </div>

      <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-xs text-terracotta hover:underline">
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
        {busy ? "Uploading…" : url ? "Replace" : "Upload"}
        <input type="file" accept="image/*" onChange={handle} className="hidden" />
      </label>

      {url && (
        <button
          type="button"
          onClick={() => onUploaded("")}
          className="ml-3 text-xs text-ink/45 hover:text-ink"
        >
          Remove
        </button>
      )}

      {/* Sits with the field, not in a document nobody opens — whoever is
          uploading sees the size at the moment they need it. */}
      {hint && (
        <p className="mt-1.5 text-xs leading-relaxed text-ink/50">{hint}</p>
      )}
      {error && <p className="mt-1 text-xs text-terracotta-dark">{error}</p>}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-ink/15 p-2 text-ink/55 transition-colors hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
