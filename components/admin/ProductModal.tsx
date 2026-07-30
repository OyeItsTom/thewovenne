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
import { getProductImages } from "@/lib/products";
import { uploadImage } from "@/lib/storage";
import { slugify, uniqueSlug } from "@/lib/utils";
import type { Category, Product } from "@/lib/types";

const emptyForm = {
  name: "",
  slug: "",
  description: "",
  price_inr: "",
  fabric: "",
  colour: "",
  stock_quantity: "",
};

type FormState = typeof emptyForm;

/**
 * Replace a product's gallery with `urls`, in order. Delete-then-insert rather
 * than diffing: the row count is tiny and this can't leave stale ordering.
 * Returns an error message, or null on success.
 */
async function replaceGallery(
  productId: string,
  urls: string[]
): Promise<{ error: string | null }> {
  const { error: clearError } = await getBrowserSupabase()
    .from("product_images")
    .delete()
    .eq("product_id", productId);
  if (clearError) return { error: clearError.message };

  if (urls.length === 0) return { error: null };

  const { error: insertError } = await getBrowserSupabase().from("product_images").insert(
    urls.map((url, i) => ({ product_id: productId, url, sort_order: i }))
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

  const loadCategories = useCallback(async () => {
    const cats = await getAllCategories(getBrowserSupabase());
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

    getBrowserSupabase()
      .from("products")
      .select("id, slug")
      .then(({ data }) =>
        setTakenSlugs(
          (data ?? [])
            .filter((p) => p.id !== product?.id) // own slug isn't a collision
            .map((p) => p.slug)
        )
      );

    if (product) {
      getProductImages(product.id, getBrowserSupabase()).then((urls) =>
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
    };

    setSaving(true);
    const { data, error: saveError } = isEdit
      ? await getBrowserSupabase()
          .from("products")
          .update(payload)
          .eq("id", product!.id)
          .select("*, categories(name, slug)")
          .single()
      : await getBrowserSupabase()
          .from("products")
          .insert({ ...payload, is_active: true })
          .select("*, categories(name, slug)")
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
    const savedId = (data as { id: string }).id;
    const { error: galleryError } = await replaceGallery(savedId, images);
    setSaving(false);

    if (galleryError) {
      setError(
        `Product saved, but its photos didn't: ${galleryError}. Reopen and try the photos again.`
      );
      return;
    }

    // Flatten the joined category the way lib/products does, so the table shows
    // the category name immediately after saving.
    const { categories: joined, ...rest } = data as Record<string, unknown> & {
      categories: { name: string; slug: string } | null;
    };
    onSaved(
      {
        ...(rest as unknown as Product),
        category: joined?.name ?? null,
        category_slug: joined?.slug ?? null,
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
              /product/{form.slug || "…"}
              {!isEdit &&
                " — filled in from the name; edit if you want something different."}
            </p>
            {slugChanged && (
              <p className="mt-1 text-xs text-terracotta-dark">
                Changing this breaks /product/{product!.slug} for anyone who
                saved or shared it.
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
