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
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { supabase } from "@/lib/supabase";
import { getAllCategories } from "@/lib/categories";
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
  image_url: "",
};

type FormState = typeof emptyForm;

const formFromProduct = (p: Product): FormState => ({
  name: p.name,
  slug: p.slug,
  description: p.description ?? "",
  price_inr: String(p.price_inr),
  fabric: p.fabric ?? "",
  colour: p.colour ?? "",
  stock_quantity: String(p.stock_quantity),
  image_url: p.image_url ?? "",
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

  const loadCategories = useCallback(async () => {
    const cats = await getAllCategories();
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

    supabase
      .from("products")
      .select("id, slug")
      .then(({ data }) =>
        setTakenSlugs(
          (data ?? [])
            .filter((p) => p.id !== product?.id) // own slug isn't a collision
            .map((p) => p.slug)
        )
      );
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
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const url = await uploadImage(file, "products");
      setForm((f) => ({ ...f, image_url: url }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image upload failed.");
    } finally {
      setUploading(false);
      // Let the same file be re-picked after a rejection, otherwise choosing
      // it again fires no change event.
      e.target.value = "";
    }
  };

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
      image_url: form.image_url || null,
    };

    setSaving(true);
    const { data, error: saveError } = isEdit
      ? await supabase
          .from("products")
          .update(payload)
          .eq("id", product!.id)
          .select("*, categories(name, slug)")
          .single()
      : await supabase
          .from("products")
          .insert({ ...payload, is_active: true })
          .select("*, categories(name, slug)")
          .single();
    setSaving(false);

    if (saveError) {
      setError(
        saveError.code === "23505"
          ? "That web address is already used by another product — change the slug."
          : saveError.message
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
          <span className="text-sm font-medium text-ink/70">Product photo</span>
          <div className="mt-1 flex items-center gap-4">
            <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded-lg bg-linen">
              {form.image_url && (
                <Image
                  src={form.image_url}
                  alt="Product preview"
                  fill
                  sizes="64px"
                  className="object-cover"
                />
              )}
            </div>
            <label className="cursor-pointer rounded-full border border-ink/15 px-4 py-2 text-sm text-ink transition-colors hover:border-terracotta">
              {uploading
                ? "Uploading…"
                : form.image_url
                  ? "Change photo"
                  : "Upload photo"}
              <input
                type="file"
                // Explicit list rather than image/* — on iOS this makes the
                // picker hand over a JPEG instead of the original HEIC.
                accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
                onChange={handleFile}
                disabled={uploading}
                className="hidden"
              />
            </label>
          </div>
          <p className="mt-1 text-xs text-ink/50">
            Uploads straight to storage — no links to paste. Replacing a photo
            leaves the old file in storage; it just stops being used.
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
