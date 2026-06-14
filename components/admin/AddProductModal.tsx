"use client";

import {
  ChangeEvent,
  FormEvent,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  useState,
} from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { supabase } from "@/lib/supabase";
import type { Product } from "@/lib/types";

const initialForm = {
  name: "",
  slug: "",
  description: "",
  price_gbp: "",
  category: "",
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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update =
    (key: keyof FormState) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.name || !form.slug || !form.price_gbp) {
      setError("Name, slug and price are required.");
      return;
    }

    setSaving(true);

    const { data, error: insertError } = await supabase
      .from("products")
      .insert({
        name: form.name,
        slug: form.slug,
        description: form.description || null,
        price_gbp: Number(form.price_gbp),
        category: form.category || null,
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
    onClose();
  };

  const handleClose = () => {
    setForm(initialForm);
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

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Price (GBP)"
            type="number"
            step="0.01"
            min="0"
            required
            value={form.price_gbp}
            onChange={update("price_gbp")}
          />
          <Field
            label="Category"
            placeholder="Shirts"
            value={form.category}
            onChange={update("category")}
          />
          <Field
            label="Fabric"
            placeholder="Handloom Cotton-Linen"
            value={form.fabric}
            onChange={update("fabric")}
          />
        </div>

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

        <Field
          label="Image URL"
          placeholder="https://placehold.co/800x1000/F0EAD6/1C1F3B?text=THE+WOVENNE"
          value={form.image_url}
          onChange={update("image_url")}
        />

        {error && <p className="text-sm text-terracotta-dark">{error}</p>}

        <Button type="submit" disabled={saving} size="lg" className="w-full">
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
