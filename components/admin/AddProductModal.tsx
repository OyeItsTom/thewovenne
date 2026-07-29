"use client";

import {
  ChangeEvent,
  FormEvent,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  useEffect,
  useState,
} from "react";
import Image from "next/image";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { supabase } from "@/lib/supabase";
import { getAllCategories } from "@/lib/categories";
import { uploadImage } from "@/lib/storage";
import type { Category, Product } from "@/lib/types";

const initialForm = {
  name: "",
  slug: "",
  description: "",
  price_inr: "",
  fabric: "",
  colour: "",
  stock_quantity: "",
  image_url: "",
};

type FormState = typeof initialForm;

export default function AddProductModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (product: Product) => void;
}) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [categories, setCategories] = useState<Category[]>([]);
  const [parentId, setParentId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    getAllCategories().then(setCategories);
  }, []);

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
    // product would silently never appear. Refuse to create one.
    if (!subCategoryId) {
      setError("Pick a category and sub-category — products need one to appear on the site.");
      return;
    }

    setSaving(true);

    const { data, error: insertError } = await supabase
      .from("products")
      .insert({
        name: form.name,
        slug: form.slug,
        description: form.description || null,
        price_inr: Number(form.price_inr),
        category_id: subCategoryId,
        fabric: form.fabric || null,
        colour: form.colour || null,
        stock_quantity: Number(form.stock_quantity) || 0,
        image_url: form.image_url || null,
        is_active: true,
      })
      .select()
      .single();

    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    onCreated(data as Product);
    setForm(initialForm);
    setParentId("");
    setSubCategoryId("");
    onClose();
  };

  const handleClose = () => {
    setForm(initialForm);
    setParentId("");
    setSubCategoryId("");
    setError(null);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Add New Product">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            required
            value={form.name}
            onChange={update("name")}
          />
          <Field
            label="Slug"
            required
            placeholder="indigo-handloom-shirt"
            value={form.slug}
            onChange={update("slug")}
          />
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
              {uploading ? "Uploading…" : form.image_url ? "Change photo" : "Upload photo"}
              <input
                type="file"
                accept="image/*"
                onChange={handleFile}
                disabled={uploading}
                className="hidden"
              />
            </label>
          </div>
          <p className="mt-1 text-xs text-ink/50">
            Uploads straight to storage — no links to paste.
          </p>
        </div>

        {error && <p className="text-sm text-terracotta-dark">{error}</p>}

        <Button
          type="submit"
          disabled={saving || uploading}
          size="lg"
          className="w-full"
        >
          {saving ? "Saving…" : "Add Product"}
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
