"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { DEFAULT_CONTENT } from "@/lib/content";
import { getAdminPages } from "@/lib/pages";
import {
  FOOTER_FIXED_ITEMS,
  FOOTER_HARDCODED_PAGE_SLUGS,
  isInstagramUrl,
  pageItemId,
  safeEmailAddress,
  safeInternalHref,
  resolveInstagram,
} from "@/lib/footer";
import { whatsappHrefFor } from "@/lib/whatsapp";
import type { FooterContent, FooterExploreItem } from "@/lib/types";

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Admin → Footer.
 *
 * WRITES THE DRAFT ONLY, like the homepage content editor: the footer is copy,
 * and copy goes through Review & Publish. Saving here changes nothing a
 * customer can see until it is published, and Preview shows it in the meantime.
 *
 * FORM CONTROLS, NOT JSON. The block is stored as one jsonb value, but the
 * owner should never meet that — every field here is a labelled input, a
 * checkbox or an arrow, and the shape is assembled on save.
 *
 * ROWS ARE DISCOVERED, NOT LISTED. The Explore rows come from what actually
 * exists — the five built-in routes plus every page marked "shown in footer" —
 * so a page added later appears here on its own, and a page deleted stops
 * appearing. What is stored is only the difference from that: a new name, a
 * different destination, hidden, moved.
 */

interface Row {
  id: string;
  /** What this link is called when nobody has renamed it. */
  naturalLabel: string;
  /** Where it goes when nobody has moved it, unprefixed. */
  naturalHref: string;
  label: string;
  href: string;
  visible: boolean;
  /** A page's destination is the page's own address and is not editable here. */
  editableHref: boolean;
}

export default function FooterEditor({ onChange }: { onChange?: () => void }) {
  const [footer, setFooter] = useState<FooterContent>(DEFAULT_CONTENT.footer);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [save, setSave] = useState<SaveState>("idle");

  useEffect(() => {
    const client = getBrowserSupabase();

    async function load() {
      const [{ data }, pages] = await Promise.all([
        client
          .from("site_content")
          .select("draft_value, value")
          .eq("key", "footer")
          .maybeSingle(),
        getAdminPages(client),
      ]);

      // Edit the draft; fall back to the published copy, then to the built-in
      // default for a footer block that has never been saved.
      const stored = ((data?.draft_value ?? data?.value) ?? {}) as Partial<FooterContent>;
      const content: FooterContent = { ...DEFAULT_CONTENT.footer, ...stored };
      setFooter(content);

      const discovered = [
        ...FOOTER_FIXED_ITEMS.map((item) => ({
          id: item.id,
          naturalLabel: item.label,
          naturalHref: item.href,
          editableHref: true,
        })),
        ...pages
          .filter((page) => page.in_footer && !FOOTER_HARDCODED_PAGE_SLUGS.has(page.slug))
          .map((page) => ({
            id: pageItemId(page.slug),
            naturalLabel: page.title,
            naturalHref: `/${page.slug}`,
            editableHref: false,
          })),
      ];

      const overrides = new Map(
        (content.explore ?? []).map((item) => [item.id, item])
      );
      const position = new Map(
        (content.explore ?? []).map((item, index) => [item.id, index])
      );

      setRows(
        discovered
          .map((item, index) => {
            const override = overrides.get(item.id);
            return {
              ...item,
              label: (override?.label ?? "").trim() || item.naturalLabel,
              href: (override?.href ?? "").trim() || item.naturalHref,
              visible: override?.visible !== false,
              rank: position.get(item.id) ?? overrides.size + index,
            };
          })
          .sort((a, b) => a.rank - b.rank)
          .map(({ rank: _rank, ...row }) => row)
      );
      setLoading(false);
    }

    void load();
  }, []);

  function move(index: number, delta: number) {
    setRows((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function patchRow(id: string, patch: Partial<Row>) {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row))
    );
  }

  async function handleSave() {
    setSave("saving");

    /*
     * Only differences are stored. A label left exactly as the page calls it is
     * not written down, so renaming that page later still renames the footer
     * link — which is the behaviour the footer has always had and the thing an
     * override system quietly breaks if it stores everything it was shown.
     */
    const explore: FooterExploreItem[] = rows.map((row) => {
      const item: FooterExploreItem = { id: row.id, visible: row.visible };
      const label = row.label.trim();
      if (label && label !== row.naturalLabel) item.label = label;
      const href = row.href.trim();
      if (row.editableHref && href && href !== row.naturalHref) item.href = href;
      return item;
    });

    const value: FooterContent = { ...footer, explore };
    const client = getBrowserSupabase();

    // UPDATE ... SELECT then INSERT, exactly as the homepage content editor
    // does: `value` is NOT NULL with no default, so an upsert fails its NOT NULL
    // check before it can resolve the conflict, and a bare UPDATE that matches
    // nothing reports success while losing the work. See ContentEditor.
    const { data: updated, error } = await client
      .from("site_content")
      .update({ draft_value: value, updated_at: new Date().toISOString() })
      .eq("key", "footer")
      .select("key");

    let failed = error;
    if (!failed && !updated?.length) {
      // First ever save. `value` is seeded from the built-in default rather than
      // from this edit, so even a first save cannot put anything live ahead of
      // publish.
      const { error: insertError } = await client.from("site_content").insert({
        key: "footer",
        value: DEFAULT_CONTENT.footer,
        draft_value: value,
      });
      failed = insertError;
    }

    setSave(failed ? "error" : "saved");
    if (!failed) {
      onChange?.();
      setTimeout(() => setSave("idle"), 2000);
    }
  }

  if (loading) return <p className="text-ink/60">Loading footer…</p>;

  const instagram = resolveInstagram({ ...footer.instagram, visible: true });
  const emailValid = safeEmailAddress(footer.email?.address);
  const numberEntered = (footer.whatsapp?.number ?? "").trim();
  const numberValid = whatsappHrefFor(numberEntered, "x") !== null;

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-ink/10 bg-cream p-6">
        <h3 className="font-heading text-2xl text-ink">Brand</h3>
        <p className="mt-1 text-sm text-ink/60">
          The emblem, the name THE WOVENNE and the copyright line are part of the
          brand rather than copy, so they are not editable here.
        </p>
        <div className="mt-4 space-y-4">
          <Text
            area
            label="Description"
            value={footer.brand_description}
            onChange={(v) => setFooter((f) => ({ ...f, brand_description: v }))}
          />
          <Toggle
            label="Show the description"
            checked={footer.brand_description_visible}
            onChange={(v) =>
              setFooter((f) => ({ ...f, brand_description_visible: v }))
            }
          />
        </div>
      </section>

      <section className="rounded-2xl border border-ink/10 bg-cream p-6">
        <h3 className="font-heading text-2xl text-ink">Explore</h3>
        <p className="mt-1 text-sm text-ink/60">
          These are the links in the footer&apos;s Explore column, in the order
          they appear. Pages you mark &ldquo;shown in footer&rdquo; under Pages
          turn up here on their own — rename one here to change only what the
          footer calls it, without touching the page&apos;s own title.
        </p>
        <ul className="mt-4 space-y-3">
          {rows.map((row, index) => {
            const hrefProblem =
              row.editableHref &&
              row.href.trim() !== "" &&
              safeInternalHref(row.href) === null;
            return (
              <li
                key={row.id}
                className="rounded-lg border border-ink/10 p-3 sm:flex sm:items-start sm:gap-3"
              >
                <div className="min-w-0 flex-1 space-y-3">
                  <Text
                    label="Label"
                    value={row.label}
                    onChange={(v) => patchRow(row.id, { label: v })}
                  />
                  {row.editableHref ? (
                    <>
                      <Text
                        label="Destination"
                        value={row.href}
                        onChange={(v) => patchRow(row.id, { href: v })}
                      />
                      {hrefProblem && (
                        <p className="text-xs text-terracotta-dark">
                          Use a page on this site, starting with a slash — for
                          example <code>/shop</code>. External addresses are not
                          allowed in this column.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-ink/50">
                      Goes to <code className="text-ink/70">{row.naturalHref}</code>{" "}
                      — edit that page under Pages to move it.
                    </p>
                  )}
                  <Toggle
                    label="Show this link"
                    checked={row.visible}
                    onChange={(v) => patchRow(row.id, { visible: v })}
                  />
                </div>
                <div className="mt-3 flex gap-2 sm:mt-0 sm:flex-col">
                  <Arrow
                    label={`Move ${row.label} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Arrow>
                  <Arrow
                    label={`Move ${row.label} down`}
                    disabled={index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Arrow>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-2xl border border-ink/10 bg-cream p-6">
        <h3 className="font-heading text-2xl text-ink">Connect</h3>
        <p className="mt-1 text-sm text-ink/60">
          Each row appears only when it has something valid to point at. A row
          you switch off, or leave incomplete, is left out of the footer
          entirely rather than shown as a link that goes nowhere.
        </p>

        <div className="mt-4 space-y-6">
          <div className="space-y-3 rounded-lg border border-ink/10 p-3">
            <h4 className="font-medium text-ink">WhatsApp</h4>
            <Toggle
              label="Show WhatsApp"
              checked={footer.whatsapp?.visible !== false}
              onChange={(v) =>
                setFooter((f) => ({ ...f, whatsapp: { ...f.whatsapp, visible: v } }))
              }
            />
            <Text
              label="Label"
              value={footer.whatsapp?.label ?? ""}
              onChange={(v) =>
                setFooter((f) => ({ ...f, whatsapp: { ...f.whatsapp, label: v } }))
              }
            />
            <Text
              label="Number (leave blank to use the number already configured)"
              value={footer.whatsapp?.number ?? ""}
              onChange={(v) =>
                setFooter((f) => ({ ...f, whatsapp: { ...f.whatsapp, number: v } }))
              }
            />
            {numberEntered !== "" && !numberValid && (
              <p className="text-xs text-terracotta-dark">
                That does not look like a WhatsApp number. Use the country code
                and the number, digits only — for example 919876543210.
              </p>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-ink/10 p-3">
            <h4 className="font-medium text-ink">Email</h4>
            <Toggle
              label="Show the email address"
              checked={footer.email?.visible !== false}
              onChange={(v) =>
                setFooter((f) => ({ ...f, email: { ...f.email, visible: v } }))
              }
            />
            <Text
              label="Email address (shown to customers exactly as written)"
              value={footer.email?.address ?? ""}
              onChange={(v) =>
                setFooter((f) => ({ ...f, email: { ...f.email, address: v } }))
              }
            />
            {(footer.email?.address ?? "").trim() !== "" && !emailValid && (
              <p className="text-xs text-terracotta-dark">
                That is not a usable email address, so the row will be left out.
              </p>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-ink/10 p-3">
            <h4 className="font-medium text-ink">Instagram</h4>
            <Toggle
              label="Show Instagram"
              checked={footer.instagram?.visible !== false}
              onChange={(v) =>
                setFooter((f) => ({ ...f, instagram: { ...f.instagram, visible: v } }))
              }
            />
            <Text
              label="Username (without the @)"
              value={footer.instagram?.username ?? ""}
              onChange={(v) =>
                setFooter((f) => ({ ...f, instagram: { ...f.instagram, username: v } }))
              }
            />
            <Text
              label="Profile address (optional — worked out from the username if left blank)"
              value={footer.instagram?.url ?? ""}
              onChange={(v) =>
                setFooter((f) => ({ ...f, instagram: { ...f.instagram, url: v } }))
              }
            />
            {(footer.instagram?.username ?? "").trim() !== "" && !instagram && (
              <p className="text-xs text-terracotta-dark">
                That is not a usable Instagram username, so the row will be left
                out. Letters, numbers, full stops and underscores only.
              </p>
            )}
            {instagram && (
              <p className="text-xs text-ink/50">
                The footer will show{" "}
                <strong className="font-medium text-ink/70">{instagram.handle}</strong>{" "}
                and open {instagram.url}
                {(footer.instagram?.url ?? "").trim() !== "" &&
                  !isInstagramUrl(footer.instagram?.url) &&
                  " — the address you typed is not an Instagram address, so the username is being used instead"}
                .
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-ink/10 bg-cream p-6">
        <h3 className="font-heading text-2xl text-ink">Bottom line</h3>
        <p className="mt-1 text-sm text-ink/60">
          The quiet line at the very bottom. The year is taken from the calendar
          and the business name is fixed, so neither needs updating.
        </p>
        <div className="mt-4 space-y-4">
          <Text
            label="Note"
            value={footer.bottom_note}
            onChange={(v) => setFooter((f) => ({ ...f, bottom_note: v }))}
          />
          <Toggle
            label="Show the note"
            checked={footer.bottom_note_visible}
            onChange={(v) => setFooter((f) => ({ ...f, bottom_note_visible: v }))}
          />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={save === "saving"}
          className="rounded-full bg-terracotta px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-terracotta-dark disabled:opacity-50"
        >
          {save === "saving" ? "Saving…" : "Save changes"}
        </button>
        {save === "saved" && (
          <span className="text-sm text-ink/60">
            Saved ✓ — publish it under Review &amp; Publish.
          </span>
        )}
        {save === "error" && (
          <span className="text-sm text-terracotta-dark">Couldn&apos;t save — try again.</span>
        )}
      </div>
    </div>
  );
}

function Arrow({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-full border border-ink/15 p-2 text-ink/70 transition-colors hover:border-ink hover:text-ink disabled:opacity-30 disabled:hover:border-ink/15"
    >
      {children}
    </button>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-terracotta"
      />
      <span className="font-medium text-ink/70">{label}</span>
    </label>
  );
}

function Text({
  label,
  value,
  onChange,
  area = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  area?: boolean;
}) {
  const cls =
    "mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none";
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      {area ? (
        <textarea rows={3} className={cls} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={cls} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
