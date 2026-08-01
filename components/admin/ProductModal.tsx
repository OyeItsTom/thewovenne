"use client";

import {
  ChangeEvent,
  FormEvent,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useState,
} from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { getBrowserSupabase } from "@/lib/supabase";
import { getAllCategories } from "@/lib/categories";
import { getDraftProductImages } from "@/lib/products";
import { newProductDraft, productDraftId } from "@/lib/drafts";
import { uploadImage } from "@/lib/storage";
import { slugify, uniqueSlug, formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import type { Category, Product } from "@/lib/types";

const emptyForm = {
  name: "",
  slug: "",
  description: "",
  price_inr: "",
  fabric: "",
  colour: "",
  stock_quantity: "",
  collection: "",
  discount_type: "",
  discount_value: "",
  discount_starts_at: "",
  discount_ends_at: "",
};

type FormState = typeof emptyForm;

/**
 * Replace a product's gallery with `urls`, in order. Delete-then-insert rather
 * than diffing: the row count is tiny and this can't leave stale ordering.
 * Returns an error message, or null on success.
 */
async function replaceGallery(
  versionId: string,
  productId: string,
  urls: string[]
): Promise<{ error: string | null }> {
  // Scoped to the DRAFT version, so the live gallery is untouched until publish.
  const { error: clearError } = await getBrowserSupabase()
    .from("product_images")
    .delete()
    .eq("product_version_id", versionId);
  if (clearError) return { error: clearError.message };

  if (urls.length === 0) return { error: null };

  const { error: insertError } = await getBrowserSupabase().from("product_images").insert(
    urls.map((url, i) => ({
      product_version_id: versionId,
      product_id: productId,
      url,
      sort_order: i,
    }))
  );
  return { error: insertError?.message ?? null };
}

const formFromProduct = (p: Product): FormState => ({
  name: p.name,
  slug: p.slug,
  description: p.description ?? "",
  price_inr: String(p.price_inr),
  fabric: p.fabric ?? "",
  colour: p.colour ?? "",
  stock_quantity: String(p.stock_quantity),
  collection: p.collection ?? "",
  discount_type: p.discount_type ?? "",
  discount_value: p.discount_value != null ? String(p.discount_value) : "",
  // datetime-local wants "YYYY-MM-DDTHH:mm"; the DB gives full ISO.
  discount_starts_at: p.discount_starts_at ? p.discount_starts_at.slice(0, 16) : "",
  discount_ends_at: p.discount_ends_at ? p.discount_ends_at.slice(0, 16) : "",
});

/**
 * Create or edit a product. One component for both, so the two can't drift —
 * an edit form validating differently from the add form is how you end up with
 * data only one of them could have produced.
 */
export default function ProductModal({
  isOpen,
  onClose,
  product,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Present = edit that product; absent/null = create a new one. */
  product?: Product | null;
  onSaved: (product: Product, isNew: boolean) => void;
}) {
  const isEdit = !!product;

  const [form, setForm] = useState<FormState>(emptyForm);
  const [categories, setCategories] = useState<Category[]>([]);
  const [takenSlugs, setTakenSlugs] = useState<string[]>([]);
  const [slugTouched, setSlugTouched] = useState(false);
  const [parentId, setParentId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Gallery is edited locally and written on save, so cancelling leaves the
  // existing gallery untouched.
  const [images, setImages] = useState<string[]>([]);

  // Shows the admin the actual outcome before saving, using the same function
  // the storefront renders with, so the preview cannot disagree with the site.
  // Shows the real address the product will live at, built the same way the
  // storefront builds its links.
  const previewPath = (() => {
    const child = categories.find((c) => c.id === subCategoryId);
    const parent = child?.parent_id
      ? categories.find((c) => c.id === child.parent_id)
      : null;
    const slug = form.slug || "…";
    return parent && child
      ? `/${parent.slug}/${child.slug}/${slug}`
      : `/product/${slug}`;
  })();

  const discountPreview = (() => {
    const base = Number(form.price_inr);
    const value = Number(form.discount_value);
    if (!form.discount_type || !base || !value) return null;
    const { price, wasPrice } = effectivePrice({
      price_inr: base,
      discount_type: form.discount_type as "percent" | "flat",
      discount_value: value,
      discount_starts_at: null,
      discount_ends_at: null,
    });
    if (wasPrice == null) return null;
    return `${formatINR(price)}, with ${formatINR(wasPrice)} struck through.`;
  })();

  const loadCategories = useCallback(async () => {
    const cats = await getAllCategories(getBrowserSupabase(), { drafts: true });
    setCategories(cats);
    return cats;
  }, []);

  // Re-seed whenever the modal opens, or opens on a different product.
  useEffect(() => {
    if (!isOpen) return;

    setError(null);
    // In edit mode the slug is already published, so it must never be silently
    // rewritten by editing the name.
    setSlugTouched(isEdit);
    setForm(product ? formFromProduct(product) : emptyForm);

    loadCategories().then((cats) => {
      const current = product?.category_id
        ? cats.find((c) => c.id === product.category_id)
        : undefined;
      setSubCategoryId(current?.id ?? "");
      setParentId(current?.parent_id ?? "");
    });

    // Slugs must be unique among published AND draft versions — a draft slug
    // is claimed even though it is not live yet, or two drafts could collide at
    // publish time.
    getBrowserSupabase()
      .from("product_versions")
      .select("product_id, slug")
      .in("state", ["published", "draft"])
      .then(({ data }) =>
        setTakenSlugs(
          (data ?? [])
            .filter((p) => p.product_id !== product?.id) // own slug isn't a collision
            .map((p) => p.slug)
        )
      );

    if (product) {
      getDraftProductImages(product.id, getBrowserSupabase()).then((urls) =>
        // Fall back to the cover column if the gallery hasn't been populated,
        // so an existing product never opens looking photo-less.
        setImages(urls.length ? urls : product.image_url ? [product.image_url] : [])
      );
    } else {
      setImages([]);
    }
  }, [isOpen, product, isEdit, loadCategories]);

  const parents = categories.filter((c) => c.parent_id === null);
  const subCategories = categories.filter((c) => c.parent_id === parentId);
  const selectedSubCategory = categories.find((c) => c.id === subCategoryId);

  /** Mirrors getVisibleCategoryIds: a hidden parent hides its children too. */
  const isPubliclyVisible = (sub: Category) =>
    sub.is_visible &&
    categories.some((p) => p.id === sub.parent_id && p.is_visible);

  const update =
    (key: keyof FormState) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  /** Typing the name fills the slug, until the slug is edited directly. */
  const updateName = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const name = e.target.value;
    setForm((f) => ({
      ...f,
      name,
      slug: slugTouched ? f.slug : uniqueSlug(name, takenSlugs),
    }));
  };

  /** The slug is a public URL — normalise whatever is typed into it. */
  const updateSlug = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setSlugTouched(true);
    setForm((f) => ({ ...f, slug: slugify(e.target.value) }));
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    setError(null);
    setUploading(true);

    // Upload sequentially so one rejected file doesn't discard the others, and
    // report the failures rather than dropping them silently.
    const uploaded: string[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        uploaded.push(await uploadImage(file, "products"));
      } catch (err) {
        failures.push(
          `${file.name}: ${err instanceof Error ? err.message : "upload failed"}`
        );
      }
    }

    if (uploaded.length) setImages((prev) => [...prev, ...uploaded]);
    if (failures.length) setError(failures.join("\n"));

    setUploading(false);
    // Let the same file be re-picked after a rejection, otherwise choosing it
    // again fires no change event.
    e.target.value = "";
  };

  const moveImage = (index: number, direction: -1 | 1) =>
    setImages((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const removeImage = (index: number) =>
    setImages((prev) => prev.filter((_, i) => i !== index));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.name || !form.slug || !form.price_inr) {
      setError("Name, slug and price are required.");
      return;
    }
    // Storefront queries are scoped to visible categories, so an uncategorised
    // product would silently never appear. Refuse to save one.
    if (!subCategoryId) {
      setError(
        "Pick a category and sub-category — products need one to appear on the site."
      );
      return;
    }

    const hasDiscount =
      !!form.discount_type && Number(form.discount_value) > 0;

    if (!!form.discount_type !== Number(form.discount_value) > 0) {
      setError(
        "A discount needs both a type and an amount above zero — or leave both blank."
      );
      return;
    }
    if (form.discount_type === "percent" && Number(form.discount_value) > 100) {
      setError("A percentage discount can't be more than 100%.");
      return;
    }
    if (
      form.discount_starts_at &&
      form.discount_ends_at &&
      new Date(form.discount_ends_at) <= new Date(form.discount_starts_at)
    ) {
      setError("The discount's end date has to be after its start date.");
      return;
    }

    const payload = {
      name: form.name,
      slug: form.slug,
      description: form.description || null,
      price_inr: Number(form.price_inr),
      category_id: subCategoryId,
      fabric: form.fabric || null,
      colour: form.colour || null,
      stock_quantity: Number(form.stock_quantity) || 0,
      // Cover image stays denormalised on the product so listings, cart and the
      // concierge keep reading one column instead of joining the gallery.
      image_url: images[0] ?? null,
      collection: form.collection.trim() ? slugify(form.collection) : null,
      // A discount is all-or-nothing: clearing the type clears the whole thing,
      // which matches the check constraint in migration 0016.
      discount_type: hasDiscount ? form.discount_type : null,
      discount_value: hasDiscount ? Number(form.discount_value) : null,
      discount_starts_at: hasDiscount && form.discount_starts_at
        ? new Date(form.discount_starts_at).toISOString()
        : null,
      discount_ends_at: hasDiscount && form.discount_ends_at
        ? new Date(form.discount_ends_at).toISOString()
        : null,
    };

    setSaving(true);
    const client = getBrowserSupabase();

    // Never write to a published version: get or fork the draft, edit that.
    const { id: versionId, error: draftError } = isEdit
      ? await productDraftId(client, product!.id)
      : await newProductDraft(client);

    if (draftError || !versionId) {
      setSaving(false);
      setError(draftError ?? "Could not start a draft for this product.");
      return;
    }

    const { data, error: saveError } = await client
      .from("product_versions")
      .update(isEdit ? payload : { ...payload, is_active: true })
      .eq("id", versionId)
      .select("product_id, name, slug, description, price_inr, category_id, fabric, colour, stock_quantity, image_url, is_active, created_at, collection, discount_type, discount_value, discount_starts_at, discount_ends_at")
      .single();

    if (saveError) {
      setSaving(false);
      setError(
        saveError.code === "23505"
          ? "That web address is already used by another product — change the slug."
          : saveError.message
      );
      return;
    }

    // Rewrite the gallery wholesale: simpler than diffing, and the row count is
    // small. Runs after the product exists so a new product has an id to hang
    // the images off.
    const savedProductId = (data as { product_id: string }).product_id;
    const { error: galleryError } = await replaceGallery(
      versionId,
      savedProductId,
      images
    );
    setSaving(false);

    if (galleryError) {
      setError(
        `Product saved, but its photos didn't: ${galleryError}. Reopen and try the photos again.`
      );
      return;
    }

    // Version rows carry product_id; the table wants the Product shape keyed by
    // the stable id, with the category name resolved locally.
    const row = data as unknown as Record<string, unknown> & { product_id: string };
    const cat = categories.find((c) => c.id === subCategoryId);
    onSaved(
      {
        ...(row as unknown as Product),
        id: row.product_id,
        category: cat?.name ?? null,
        category_slug: cat?.slug ?? null,
      },
      !isEdit
    );
    onClose();
  };

  const slugChanged = isEdit && product!.slug !== form.slug;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? `Edit ${product!.name}` : "Add New Product"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required value={form.name} onChange={updateName} />
          <div>
            <Field
              label="Slug (web address)"
              required
              placeholder="indigo-handloom-shirt"
              value={form.slug}
              onChange={updateSlug}
            />
            <p className="mt-1 text-xs text-ink/50">
              {previewPath}
              {!isEdit &&
                " — filled in from the name; edit if you want something different."}
            </p>
            {slugChanged && (
              <p className="mt-1 text-xs text-ink/60">
                The old address keeps working — it will redirect here
                automatically, so anything already shared or saved is safe.
              </p>
            )}
          </div>
        </div>

        <Field
          as="textarea"
          label="Description"
          value={form.description}
          onChange={update("description")}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Price (₹ INR)"
            type="number"
            step="0.01"
            min="0"
            required
            value={form.price_inr}
            onChange={update("price_inr")}
          />
          <Field
            label="Fabric"
            placeholder="Handloom Cotton-Linen"
            value={form.fabric}
            onChange={update("fabric")}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-ink/70">Category</span>
            <select
              required
              value={parentId}
              onChange={(e) => {
                setParentId(e.target.value);
                setSubCategoryId("");
              }}
              className="mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
            >
              <option value="">Select…</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink/70">Sub-category</span>
            <select
              required
              value={subCategoryId}
              onChange={(e) => setSubCategoryId(e.target.value)}
              disabled={!parentId}
              className="mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none disabled:opacity-50"
            >
              <option value="">
                {parentId ? "Select…" : "Pick a category first"}
              </option>
              {subCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.is_visible ? "" : " (hidden)"}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Filing a product under a hidden category is legitimate — staging it
            ahead of launch — but it must not look like the product vanished. */}
        {selectedSubCategory && !isPubliclyVisible(selectedSubCategory) && (
          <p className="rounded-lg bg-linen/60 px-3 py-2 text-xs text-ink/70">
            This category is currently hidden, so the product won&apos;t appear on
            the site until you make it visible.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Colour"
            placeholder="Indigo"
            value={form.colour}
            onChange={update("colour")}
          />
          <Field
            label="Stock Quantity"
            type="number"
            min="0"
            required
            value={form.stock_quantity}
            onChange={update("stock_quantity")}
          />
        </div>

        {/* Seasonal campaign — optional, collapsed visually so the common
            case (no campaign) stays out of the way. */}
        <fieldset className="rounded-lg border border-ink/10 p-4">
          <legend className="px-2 text-sm font-medium text-ink/70">
            Seasonal campaign (optional)
          </legend>

          <Field
            label="Collection"
            placeholder="onam-edit"
            value={form.collection}
            onChange={update("collection")}
          />
          <p className="mt-1 text-xs text-ink/50">
            Group products under a name to give them their own page — products
            tagged <code className="text-ink/70">onam-edit</code> appear at{" "}
            <code className="text-ink/70">/collection/onam-edit</code>. Leave
            blank for none.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-ink/70">Discount</span>
              <select
                value={form.discount_type}
                onChange={(e) =>
                  setForm((f) => ({ ...f, discount_type: e.target.value }))
                }
                className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
              >
                <option value="">No discount</option>
                <option value="percent">Percentage off</option>
                <option value="flat">Amount off (₹)</option>
              </select>
            </label>
            <Field
              label={form.discount_type === "flat" ? "Amount off (₹)" : "Percent off"}
              type="number"
              min="0"
              disabled={!form.discount_type}
              value={form.discount_value}
              onChange={update("discount_value")}
            />
          </div>

          {!!form.discount_type && (
            <>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field
                  label="Starts (optional)"
                  type="datetime-local"
                  value={form.discount_starts_at}
                  onChange={update("discount_starts_at")}
                />
                <Field
                  label="Ends (optional)"
                  type="datetime-local"
                  value={form.discount_ends_at}
                  onChange={update("discount_ends_at")}
                />
              </div>
              <p className="mt-2 text-xs text-ink/50">
                Leave the dates blank to run the discount until you remove it.
                Outside its dates the product simply shows its normal price.
              </p>
              {discountPreview && (
                <p className="mt-3 rounded-lg bg-linen/60 px-3 py-2 text-xs text-ink/70">
                  Customers will see {discountPreview}
                </p>
              )}
            </>
          )}
        </fieldset>

        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-ink/70">Photos</span>
            <span className="text-xs text-ink/40">
              {images.length} added{images.length > 1 && " · first is the cover"}
            </span>
          </div>

          {images.length > 0 && (
            <div className="mt-2 grid grid-cols-4 gap-3 sm:grid-cols-5">
              {images.map((url, i) => (
                <div key={url} className="group relative">
                  <div className="relative aspect-[4/5] overflow-hidden rounded-lg bg-linen">
                    <Image
                      src={url}
                      alt={`Photo ${i + 1}`}
                      fill
                      sizes="120px"
                      className="object-cover"
                    />
                    {i === 0 && (
                      <span className="absolute left-1 top-1 rounded bg-ink/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-cream">
                        Cover
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveImage(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move photo ${i + 1} earlier`}
                      className="rounded p-0.5 text-ink/40 hover:text-ink disabled:opacity-25"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeImage(i)}
                      aria-label={`Remove photo ${i + 1}`}
                      className="rounded p-0.5 text-ink/40 hover:text-terracotta"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveImage(i, 1)}
                      disabled={i === images.length - 1}
                      aria-label={`Move photo ${i + 1} later`}
                      className="rounded p-0.5 text-ink/40 hover:text-ink disabled:opacity-25"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <label className="mt-3 inline-block cursor-pointer rounded-full border border-ink/15 px-4 py-2 text-sm text-ink transition-colors hover:border-terracotta">
            {uploading
              ? "Uploading…"
              : images.length
                ? "Add more photos"
                : "Upload photos"}
            <input
              type="file"
              multiple
              // Explicit list rather than image/* — on iOS this makes the
              // picker hand over a JPEG instead of the original HEIC.
              accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
              onChange={handleFile}
              disabled={uploading}
              className="hidden"
            />
          </label>
          <p className="mt-1 text-xs text-ink/50">
            The first photo is used everywhere the product is listed. Removing a
            photo here leaves the file in storage; it just stops being used.
          </p>
        </div>

        {error && <p className="text-sm text-terracotta-dark">{error}</p>}

        <Button
          type="submit"
          disabled={saving || uploading}
          size="lg"
          className="w-full"
        >
          {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Product"}
        </Button>
      </form>
    </Modal>
  );
}

type FieldProps = { label: string } & (
  | ({ as: "textarea" } & TextareaHTMLAttributes<HTMLTextAreaElement>)
  | ({ as?: "input" } & InputHTMLAttributes<HTMLInputElement>)
);

function Field({ label, as = "input", ...props }: FieldProps) {
  const fieldClassName =
    "mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none";

  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      {as === "textarea" ? (
        <textarea
          rows={3}
          className={fieldClassName}
          {...(props as TextareaHTMLAttributes<HTMLTextAreaElement>)}
        />
      ) : (
        <input
          className={fieldClassName}
          {...(props as InputHTMLAttributes<HTMLInputElement>)}
        />
      )}
    </label>
  );
}
