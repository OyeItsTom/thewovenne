"use client";

import {
  ChangeEvent,
  FormEvent,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import ProductContentCheck from "@/components/admin/ProductContentCheck";
import ProductInfoPanel, { LevelTag } from "@/components/admin/ProductInfoPanel";
import ProductAssistantPanel, { type AssistantState } from "@/components/admin/ProductAssistantPanel";
import {
  applyAltSuggestion,
  applyCopySuggestion,
  claimContext,
  reviewCopy,
  type AssistantRequest,
  type AssistantSuggestions,
  type CopyField,
} from "@/lib/ai/productAssistant";
import { getBrowserSupabase } from "@/lib/supabase";
import { youtubeId } from "@/lib/youtube";
import { getAllCategories } from "@/lib/categories";
import { getDraftProductImages } from "@/lib/products";
import { newProductDraft, productDraftId, settleDraft, updateDraftVersion } from "@/lib/drafts";
import { adminErrorMessage, draftSavedMessage, isDirty } from "@/lib/adminStatus";
import { setProductStock, type LoadedSize } from "@/lib/inventory";
import { uploadProductImage } from "@/lib/storage";
import {
  getProductSizes,
  saveProductSizes,
  DEFAULT_SIZE_RUN,
  type SizeDraft,
} from "@/lib/sizes";
import { slugify, uniqueSlug, formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import {
  applySuggestion,
  checkProductContent,
  contentCheckStarted,
  type ContentInput,
  type Suggestion,
} from "@/lib/productContent";
import {
  ALT_TEXT_MAX,
  BLOUSE_PIECE_LABEL,
  FACT_MAX,
  META_DESCRIPTION_LIMIT,
  SEO_TITLE_MAX,
  altTextAdvice,
  assessProductInfo,
  effectiveProfile,
  fieldLabel,
  fieldLevel,
  publishBlockers,
  type InfoInput,
  type InfoKey,
  type InfoLevel,
} from "@/lib/productInfo";
import { productSeo, PRODUCT_TITLE_SUFFIX } from "@/lib/metadata";
import { cPath } from "@/lib/country";
import type { Category, Product } from "@/lib/types";

const emptyForm = {
  name: "",
  slug: "",
  description: "",
  price_inr: "",
  cost_price_inr: "",
  video_youtube_id: "",
  heritage_note: "",
  craft_note: "",
  care_note: "",
  // Product facts (migration 0065). Blank = not known, saved as NULL.
  dimensions: "",
  blouse_piece: "",
  fit_note: "",
  finish: "",
  weave: "",
  origin: "",
  // Search & discovery. Blank = the page composes its own (lib/metadata productSeo).
  seo_title: "",
  meta_description: "",
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
 * One photo as the form edits it. Alt text is a string here ("" = not written)
 * and NULL in the database, so a blank box never stores whitespace (0065).
 */
type Photo = { url: string; alt: string };

/**
 * Replace a product's gallery with `photos` (and their alt text), in order. Delete-then-insert rather
 * than diffing: the row count is tiny and this can't leave stale ordering.
 * Returns an error message, or null on success.
 */
async function replaceGallery(
  versionId: string,
  productId: string,
  photos: Photo[]
): Promise<{ error: string | null }> {
  // Scoped to the DRAFT version, so the live gallery is untouched until publish.
  const { error: clearError } = await getBrowserSupabase()
    .from("product_images")
    .delete()
    .eq("product_version_id", versionId);
  if (clearError) return { error: clearError.message };

  if (photos.length === 0) return { error: null };

  const { error: insertError } = await getBrowserSupabase().from("product_images").insert(
    photos.map((photo, i) => ({
      product_version_id: versionId,
      product_id: productId,
      url: photo.url,
      sort_order: i,
      // Alt text rides with its photo: written here, drafted and published
      // with the gallery (0065). Blank is NULL, never "".
      alt_text: photo.alt.trim() || null,
    }))
  );
  return { error: insertError?.message ?? null };
}

const formFromProduct = (p: Product): FormState => ({
  name: p.name,
  slug: p.slug,
  description: p.description ?? "",
  price_inr: String(p.price_inr),
  cost_price_inr: p.cost_price_inr === null || p.cost_price_inr === undefined ? "" : String(p.cost_price_inr),
  video_youtube_id: p.video_youtube_id ?? "",
  heritage_note: p.heritage_note ?? "",
  craft_note: p.craft_note ?? "",
  care_note: p.care_note ?? "",
  dimensions: p.dimensions ?? "",
  blouse_piece: p.blouse_piece ?? "",
  fit_note: p.fit_note ?? "",
  finish: p.finish ?? "",
  weave: p.weave ?? "",
  origin: p.origin ?? "",
  seo_title: p.seo_title ?? "",
  meta_description: p.meta_description ?? "",
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
  /** `message` says what the save did — always a draft, never "published". */
  onSaved: (product: Product, isNew: boolean, message: string) => void;
}) {
  const isEdit = !!product;
  // Whether customers can see SOME version of this product right now. A new
  // product, or one that was never published, has nothing live to fall back to.
  const hasPublished = isEdit && (product!.publication?.hasPublished ?? true);

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
  const [images, setImages] = useState<Photo[]>([]);
  /** What the admin is told while a photograph is on its way in. */
  const [stage, setStage] = useState<string | null>(null);
  // Sizes live OUTSIDE draft/publish — see migration 0021. Loaded and saved
  // directly, and the UI says so, because an admin who expects Publish to gate
  // a stock change would oversell.
  const [sizes, setSizes] = useState<SizeDraft[]>([]);
  // What the form showed when it opened. Every live stock change is sent WITH
  // the figure the admin was looking at, and refused if the shelf has moved on
  // since (migration 0060) — so an open form cannot overwrite a sale.
  const [loadedSizes, setLoadedSizes] = useState<LoadedSize[]>([]);
  // Product content check (lib/productContent). Read-only: the other products
  // are only compared against, never written. Runs by itself on a new product;
  // on an existing one it waits to be asked, so opening a product to change its
  // stock doesn't greet the admin with a list of things to rewrite.
  const [otherProducts, setOtherProducts] = useState<ContentInput["otherProducts"]>([]);
  const [ignoredFindings, setIgnoredFindings] = useState<Set<string>>(new Set());
  const [checkOpen, setCheckOpen] = useState(false);

  // ── AI writing suggestions ──
  // Suggestions live here and nowhere else until the admin uses one, and then
  // only in the unsaved form. Closing or switching product drops them.
  const [assistant, setAssistant] = useState<AssistantState>({ status: "idle" });
  const assistantAbort = useRef<AbortController | null>(null);
  const assistantRequestId = useRef(0);
  // A request still running when the form goes away is abandoned, not applied.
  useEffect(() => () => assistantAbort.current?.abort(), []);

  // ── Unsaved changes ──
  // What each part of the form held when it finished loading. null = still
  // loading, which never counts as a change (lib/adminStatus isDirty), so the
  // photos or sizes arriving late cannot trigger a warning on their own.
  const [baseForm, setBaseForm] = useState<FormState | null>(null);
  const [baseImages, setBaseImages] = useState<Photo[] | null>(null);
  const [baseSizes, setBaseSizes] = useState<SizeDraft[] | null>(null);
  const [baseSub, setBaseSub] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

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
    // With the country prefix, exactly as productHref builds the canonical.
    return parent && child
      ? cPath(`/${parent.slug}/${child.slug}/${slug}`)
      : `/in/product/${slug}`;
  })();

  /**
   * Margin, worked out live under the cost field.
   *
   * A cost typed a decimal place out looks like a plausible number and reads as
   * an absurd margin, so this is the check that actually catches it. Silence
   * when there is nothing to say — an empty cost is a legitimate state meaning
   * "not costed yet", not an error to nag about.
   */
  /** Says what was understood, rather than only complaining when it was not. */
  const videoHint = (() => {
    const raw = form.video_youtube_id.trim();
    if (!raw) return "Unlisted YouTube video. Nothing loads until a visitor presses play.";
    const id = youtubeId(raw);
    return id
      ? `Video ${id} — it will appear on the product page once published.`
      : "Not a YouTube link yet.";
  })();

  const marginHint = (() => {
    const price = Number(form.price_inr);
    const cost = Number(form.cost_price_inr);
    if (!form.cost_price_inr.trim()) {
      return "Blank means not costed yet — it will show as full margin in the P&L.";
    }
    if (!Number.isFinite(cost) || cost < 0) return "That cost isn't a number.";
    if (!Number.isFinite(price) || price <= 0) return "Set a selling price to see the margin.";
    if (cost > price) {
      return `Selling below cost — losing ₹${Math.round(cost - price).toLocaleString("en-IN")} a piece.`;
    }
    const margin = ((price - cost) / price) * 100;
    return `Margin ₹${Math.round(price - cost).toLocaleString("en-IN")} · ${margin.toFixed(1)}%`;
  })();

  useEffect(() => {
    if (!isOpen) return;
    if (!product?.id) {
      setSizes([]);
      setLoadedSizes([]);
      setBaseSizes([]);
      return;
    }
    setBaseSizes(null);
    void getProductSizes(product.id, getBrowserSupabase()).then((rows) => {
      const loaded = rows.map((r) => ({ id: r.id, label: r.label, stock_quantity: r.stock_quantity }));
      setLoadedSizes(loaded);
      setSizes(loaded);
      setBaseSizes(loaded);
    });
  }, [isOpen, product?.id]);

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
    setIgnoredFindings(new Set());
    assistantAbort.current?.abort();
    assistantAbort.current = null;
    setAssistant({ status: "idle" });
    setCheckOpen(!isEdit);
    // In edit mode the slug is already published, so it must never be silently
    // rewritten by editing the name.
    setSlugTouched(isEdit);
    const opening = product ? formFromProduct(product) : emptyForm;
    setForm(opening);
    setBaseForm(opening);
    setConfirmClose(false);
    setBaseSub(null);

    loadCategories().then((cats) => {
      const current = product?.category_id
        ? cats.find((c) => c.id === product.category_id)
        : undefined;
      setSubCategoryId(current?.id ?? "");
      setParentId(current?.parent_id ?? "");
      setBaseSub(current?.id ?? "");
    });

    // Slugs must be unique among published AND draft versions — a draft slug
    // is claimed even though it is not live yet, or two drafts could collide at
    // publish time.
    //
    // The same read feeds the content check its comparison set: names to test
    // for duplicates, fabric and colour spellings already in use.
    getBrowserSupabase()
      .from("product_versions")
      .select("product_id, slug, name, fabric, colour")
      .in("state", ["published", "draft"])
      .then(({ data }) => {
        const others = (data ?? []).filter((p) => p.product_id !== product?.id); // own slug isn't a collision
        setTakenSlugs(others.map((p) => p.slug));
        setOtherProducts(others.map((p) => ({ name: p.name, fabric: p.fabric, colour: p.colour })));
      });

    if (product) {
      setBaseImages(null);
      getDraftProductImages(product.id, getBrowserSupabase()).then((photos) => {
        // Fall back to the cover column if the gallery hasn't been populated,
        // so an existing product never opens looking photo-less.
        const opening: Photo[] = photos.length
          ? photos.map((p) => ({ url: p.url, alt: p.alt ?? "" }))
          : product.image_url
            ? [{ url: product.image_url, alt: "" }]
            : [];
        setImages(opening);
        setBaseImages(opening);
      });
    } else {
      setImages([]);
      setBaseImages([]);
    }
  }, [isOpen, product, isEdit, loadCategories]);

  const dirty =
    isDirty(baseForm, form) ||
    isDirty(baseImages, images) ||
    isDirty(baseSizes, sizes) ||
    isDirty(baseSub, subCategoryId);

  // Leaving the page (reload, closing the tab, typing a new address) with
  // edits in the form gets the browser's own "leave site?" question. Only when
  // something changed — an untouched form never asks.
  useEffect(() => {
    if (!isOpen || !dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isOpen, dirty]);

  // The question takes focus when it appears, on its safe answer.
  useEffect(() => {
    if (confirmClose) keepEditingRef.current?.focus();
  }, [confirmClose]);

  /**
   * Every way out of the dialog — Close, Escape, the backdrop — comes here.
   * With nothing changed it just closes. With unsaved edits it asks first;
   * asking again (a second Escape) keeps the question up rather than throwing
   * the work away.
   */
  const requestClose = () => {
    if (saving) return;
    if (!dirty) {
      onClose();
      return;
    }
    if (confirmClose) {
      keepEditingRef.current?.focus();
      return;
    }
    setConfirmClose(true);
  };

  const parents = categories.filter((c) => c.parent_id === null);
  const subCategories = categories.filter((c) => c.parent_id === parentId);
  const selectedSubCategory = categories.find((c) => c.id === subCategoryId);

  // Deferred, so a fast typist never waits on the check — it catches up a
  // frame later. Local only: no request is made as the form changes.
  const deferredForm = useDeferredValue(form);
  const deferredSizes = useDeferredValue(sizes);
  const parentCategoryName = categories.find((c) => c.id === selectedSubCategory?.parent_id)?.name ?? null;
  const contentCheck = useMemo(
    () =>
      checkOpen && contentCheckStarted(deferredForm)
        ? checkProductContent({
            name: deferredForm.name,
            description: deferredForm.description,
            fabric: deferredForm.fabric,
            colour: deferredForm.colour,
            categoryName: selectedSubCategory?.name ?? null,
            parentCategoryName,
            sizes: deferredSizes.map((s) => s.label),
            otherProducts,
            notes: [deferredForm.heritage_note, deferredForm.craft_note, deferredForm.care_note].join(" "),
          })
        : null,
    [checkOpen, deferredForm, deferredSizes, selectedSubCategory?.name, parentCategoryName, otherProducts]
  );

  // ── Product information (lib/productInfo, migration 0065) ──
  // Which facts apply is the sub-category's type. The same assessment drives
  // the completeness panel, the Required/Recommended/Optional tags and the
  // "before it can be published" line after a save — and the database enforces
  // the required half at publish, from the same rule.
  const profile = effectiveProfile(subCategoryId || null, categories);
  const levelOf = (key: InfoKey): InfoLevel => fieldLevel(key, profile);
  const labelOf = (key: InfoKey): string => fieldLabel(key, profile);
  const infoInput = (f: FormState, photos: Photo[]): InfoInput => ({
    profile,
    name: f.name,
    slug: f.slug,
    price: f.price_inr,
    hasCategory: !!subCategoryId,
    description: f.description,
    fabric: f.fabric,
    colour: f.colour,
    dimensions: f.dimensions,
    blouse_piece: f.blouse_piece,
    finish: f.finish,
    weave: f.weave,
    origin: f.origin,
    heritage: f.heritage_note,
    craft: f.craft_note,
    care: f.care_note,
    fit: f.fit_note,
    images: photos,
    seo_title: f.seo_title,
    meta_description: f.meta_description,
    isActive: product ? product.is_active : true,
  });
  const deferredImages = useDeferredValue(images);
  const info = useMemo(
    () => assessProductInfo(infoInput(deferredForm, deferredImages)),
    // infoInput reads profile and subCategoryId, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferredForm, deferredImages, profile, subCategoryId, product]
  );
  // What the search result will say, from the function the page renders with.
  const seo = productSeo({
    name: form.name || "Product name",
    description: form.description,
    categoryName: selectedSubCategory?.name ?? null,
    fabric: form.fabric,
    seoTitle: form.seo_title,
    metaDescription: form.meta_description,
  });

  /**
   * "Use suggestion": one field of the unsaved form, nothing else. No save, no
   * publish — the Save button and Review & Publish stay the only ways anything
   * reaches the shop. A name goes through the same rule as typing one: the slug
   * follows it on a new product until edited by hand, and never moves on an
   * existing product (its address is already public).
   */
  const acceptSuggestion = (s: Suggestion) => {
    if (s.field === "name") {
      setForm((f) => ({
        ...applySuggestion(f, s),
        slug: slugTouched ? f.slug : uniqueSlug(s.value, takenSlugs),
      }));
      return;
    }
    setForm((f) => applySuggestion(f, s));
  };

  // ── AI writing suggestions ──

  /**
   * The allow-list the assistant reads, from the form as it is now — unsaved
   * edits included, since those are what the admin is about to save. Price,
   * cost, stock, sizes, discounts and everything else are not in it.
   */
  const assistantRequest = (): AssistantRequest => ({
    productId: product?.id ?? null,
    profile,
    categoryName: selectedSubCategory?.name ?? "",
    parentCategoryName: parentCategoryName ?? "",
    facts: {
      fabric: form.fabric.trim(),
      colour: form.colour.trim(),
      dimensions: form.dimensions.trim(),
      blouse_piece: form.blouse_piece.trim(),
      finish: form.finish.trim(),
      weave: form.weave.trim(),
      origin: form.origin.trim(),
      care: form.care_note.trim(),
      fit: form.fit_note.trim(),
    },
    copy: {
      name: form.name.trim(),
      description: form.description.trim(),
      seo_title: form.seo_title.trim(),
      meta_description: form.meta_description.trim(),
    },
    notes: { heritage: form.heritage_note.trim(), craft: form.craft_note.trim() },
    images: images.map((p) => ({ url: p.url, alt: p.alt.trim() })),
  });

  const assistantBlocked = uploading
    ? "Wait for the photos to finish uploading."
    : !form.name.trim()
      ? "Enter a product name first."
      : undefined;

  /**
   * One explicit press, one request. Never called by an effect: no suggestion
   * is ever generated because something in the form changed.
   */
  const requestSuggestions = async () => {
    if (assistantBlocked || assistant.status === "loading") return;
    assistantAbort.current?.abort();
    const controller = new AbortController();
    assistantAbort.current = controller;
    const body = assistantRequest();
    setAssistant({ status: "loading" });
    try {
      const res = await fetch("/api/admin/product-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { suggestions?: AssistantSuggestions; imagesDropped?: number; error?: string }
        | null;
      if (controller.signal.aborted) return;
      if (!res.ok || !data?.suggestions) {
        setAssistant({
          status: "error",
          message:
            data?.error ??
            (res.status === 404 || res.status === 403
              ? "Your admin session can't use AI suggestions — sign in again with two-factor verification. Nothing in the form has changed."
              : "Suggestions aren't available right now. Nothing in the form has changed."),
        });
        return;
      }
      assistantRequestId.current += 1;
      setAssistant({
        status: "ready",
        suggestions: data.suggestions,
        imagesDropped: data.imagesDropped ?? 0,
        photosSent: body.images.length - (data.imagesDropped ?? 0),
        requestId: assistantRequestId.current,
      });
    } catch {
      if (controller.signal.aborted) return;
      setAssistant({
        status: "error",
        message: "Couldn't reach the AI service. Check your connection and try again. Nothing in the form has changed.",
      });
    } finally {
      if (assistantAbort.current === controller) assistantAbort.current = null;
    }
  };

  const cancelSuggestions = () => {
    assistantAbort.current?.abort();
    assistantAbort.current = null;
    setAssistant({ status: "idle" });
  };

  /** The same check the server ran, against the form's facts as they are now. */
  const reviewSuggestion = (field: CopyField | "alt", text: string, url?: string) => {
    const req = assistantRequest();
    return reviewCopy(field, text, claimContext(req, field === "alt"), {
      otherNames: otherProducts.map((p) => p.name),
      productName: form.name,
      otherAlts: images.filter((p) => p.url !== url).map((p) => p.alt),
    });
  };

  /**
   * "Use suggestion": that field of the unsaved form and nothing else. A name
   * follows the rule for typing one — the slug moves with it only on a product
   * that has never been saved and whose slug was never edited; an existing
   * product's address never moves.
   */
  const acceptCopySuggestion = (field: CopyField, value: string) => {
    if (field === "name") {
      setForm((f) => ({
        ...applyCopySuggestion(f, "name", value),
        slug: slugTouched ? f.slug : uniqueSlug(value, takenSlugs),
      }));
      return;
    }
    setForm((f) => applyCopySuggestion(f, field, value));
  };

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
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const of = files.length > 1 ? ` ${i + 1} of ${files.length}` : "";
      try {
        // Two words, because they are two waits and the second one is not the
        // first stalling. The photograph is sent, then it is prepared: a camera
        // original spends a couple of seconds being turned into the master the
        // shop actually serves, and silence there reads as a hang.
        setStage(`Uploading${of}…`);
        const prepared = await new Promise<Awaited<ReturnType<typeof uploadProductImage>>>(
          (resolve, reject) => {
            setStage(`Uploading${of}…`);
            uploadProductImage(file).then(resolve, reject);
            // The processing half begins as soon as the bytes are gone; the
            // exact moment is the server's, so this leans on elapsed time
            // rather than pretending to know it.
            setTimeout(() => setStage(`Processing${of}…`), 1200);
          }
        );
        uploaded.push(prepared.url);
      } catch (err) {
        failures.push(
          `${file.name}: ${err instanceof Error ? err.message : "upload failed"}`
        );
      }
    }
    setStage(null);

    if (uploaded.length) setImages((prev) => [...prev, ...uploaded.map((url) => ({ url, alt: "" }))]);
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

  const setAlt = (index: number, alt: string) =>
    setImages((prev) => prev.map((p, i) => (i === index ? { ...p, alt } : p)));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (form.video_youtube_id.trim() && !youtubeId(form.video_youtube_id)) {
      setError(
        "That does not look like a YouTube link. Paste the address from the browser, or the video ID."
      );
      return;
    }
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
      // Blank stays NULL, never 0. A zero cost reads as "free to make" and
      // would show a 100% margin in the P&L for a piece nobody has costed yet.
      cost_price_inr: form.cost_price_inr.trim() === "" ? null : Number(form.cost_price_inr),
      // Normalised to an ID here, not stored as whatever was pasted. Blank
      // clears it; anything unparseable is refused above before we get here.
      video_youtube_id: form.video_youtube_id.trim() === "" ? null : youtubeId(form.video_youtube_id),
      // Blank means "not written up yet", which is a different thing from an
      // empty string: the concierge and the product page both check for null to
      // decide whether to say anything at all.
      heritage_note: form.heritage_note.trim() || null,
      craft_note: form.craft_note.trim() || null,
      care_note: form.care_note.trim() || null,
      // Facts (0065): as typed, trimmed, or NULL for "not known". Never filled
      // in for the admin — an empty box is an honest answer.
      dimensions: form.dimensions.trim() || null,
      blouse_piece: form.blouse_piece || null,
      fit_note: form.fit_note.trim() || null,
      finish: form.finish.trim() || null,
      weave: form.weave.trim() || null,
      origin: form.origin.trim() || null,
      // Blank keeps the automatic title/snippet; only a written one is stored.
      seo_title: form.seo_title.replace(/\s+/g, " ").trim() || null,
      meta_description: form.meta_description.replace(/\s+/g, " ").trim() || null,
      category_id: subCategoryId,
      fabric: form.fabric || null,
      colour: form.colour || null,
      // Cover image stays denormalised on the product so listings, cart and the
      // concierge keep reading one column instead of joining the gallery.
      image_url: images[0]?.url ?? null,
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
      setError(adminErrorMessage(draftError, "start a draft for this product"));
      return;
    }

    // Stock is NOT part of an existing product's draft: a draft is content, and
    // publishing it never changes what is on the shelf (0060). A new product's
    // figure is its opening stock, which goes live when it is first published.
    //
    // Verified: saved only if exactly one DRAFT row changed. A draft published
    // or discarded by someone else in the meantime is refused, not overwritten
    // — and never confused with the live version.
    const saved = await updateDraftVersion<Record<string, unknown> & { product_id: string }>(
      client,
      "product_versions",
      versionId,
      isEdit
        ? payload
        : { ...payload, is_active: true, stock_quantity: Number(form.stock_quantity) || 0 },
      {
        select:
          "product_id, name, slug, description, price_inr, cost_price_inr, sku, video_youtube_id, heritage_note, craft_note, care_note, " +
          "dimensions, blouse_piece, fit_note, finish, weave, origin, seo_title, meta_description, " +
          "category_id, fabric, colour, stock_quantity, image_url, is_active, created_at, collection, discount_type, discount_value, discount_starts_at, discount_ends_at",
        action: "save this draft",
      }
    );

    if (!saved.ok) {
      setSaving(false);
      setError(
        saved.reason === "duplicate"
          ? "Nothing was saved — that web address is already used by another product. Change the slug and try again."
          : saved.message
      );
      return;
    }
    const data = saved.row;

    // Rewrite the gallery wholesale: simpler than diffing, and the row count is
    // small. Runs after the product exists so a new product has an id to hang
    // the images off.
    const savedProductId = (data as { product_id: string }).product_id;
    const { error: galleryError } = await replaceGallery(
      versionId,
      savedProductId,
      images
    );

    if (galleryError) {
      setSaving(false);
      setError(
        `The details are saved as a draft, but the photos were not. ${adminErrorMessage(galleryError, "save the photos")}`
      );
      return;
    }

    // ── Live stock, after the draft ──────────────
    // Two separate operations, not one: the description above went to the
    // draft; stock below goes live now. If stock is refused, the draft is still
    // saved and the message says exactly that — neither pretends to be atomic
    // with the other.
    //
    // Sizes are keyed to the product identity, so this needs the saved id —
    // which is why it runs here rather than beside the scalar update.
    const sizeError = await saveProductSizes(client, savedProductId, loadedSizes, sizes);
    if (sizeError) {
      setSaving(false);
      setError(
        `Your other changes are saved as a draft, but the sizes were not changed: ${sizeError}`
      );
      return;
    }

    // A new product's figure is its opening stock; an existing one's is re-read
    // below, because the shelf may have moved while this form was open.
    let liveStock = Number(form.stock_quantity) || 0;

    const typedStock = Number(form.stock_quantity) || 0;
    if (isEdit && sizes.length === 0 && typedStock !== product!.stock_quantity) {
      const result = await setProductStock(
        client,
        savedProductId,
        product!.stock_quantity,
        typedStock,
        { note: "Edited in the product form" }
      );
      if (!result.ok) {
        setSaving(false);
        setError(
          `Your other changes are saved as a draft, but the stock was not changed: ${result.message}`
        );
        return;
      }
      liveStock = result.quantity;
    }
    if (isEdit) {
      const { data: shelf } = await client
        .from("product_versions")
        .select("stock_quantity")
        .eq("product_id", savedProductId)
        .eq("state", "published")
        .maybeSingle();
      if (shelf) liveStock = Number((shelf as { stock_quantity: number }).stock_quantity);
    }
    setSaving(false);

    // Only now is the save complete — scalars AND photos. Before this point
    // "did anything change?" has no answer, because a photo-only edit leaves
    // every scalar identical.
    const settled = await settleDraft(client, "product", versionId);

    // What the admin is told. A save is a DRAFT: the sentence is about what
    // customers still see, never "published". Stock and sizes are the
    // exception that went live just now, so they are named when they moved.
    const stockMoved =
      isDirty(baseSizes, sizes) ||
      (isEdit && sizes.length === 0 && typedStock !== product!.stock_quantity);
    // A saved draft that publishing would refuse says so now, by name, rather
    // than leaving the admin to find out from the publish bar (0065).
    const blockers = settled ? [] : publishBlockers(infoInput(form, images));
    const message =
      settled && hasPublished && stockMoved
        ? `Stock for “${form.name}” updated on the shop. No other changes, so nothing is waiting to publish.`
        : draftSavedMessage({ noun: "product", name: form.name, hasPublished, settled }) +
          (stockMoved && hasPublished ? " Your stock change is already live on the shop." : "") +
          (blockers.length ? ` Before it can be published, complete: ${blockers.join(", ")}.` : "");

    // Version rows carry product_id; the table wants the Product shape keyed by
    // the stable id, with the category name resolved locally.
    const row = data as unknown as Record<string, unknown> & { product_id: string };
    const cat = categories.find((c) => c.id === subCategoryId);
    onSaved(
      {
        ...(row as unknown as Product),
        id: row.product_id,
        // The shelf, not the draft's copy of it.
        stock_quantity: liveStock,
        category: cat?.name ?? null,
        category_slug: cat?.slug ?? null,
      },
      !isEdit,
      message
    );
    onClose();
  };

  const slugChanged = isEdit && product!.slug !== form.slug;

  return (
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title={isEdit ? `Edit ${product!.name}` : "Add New Product"}
    >
      {confirmClose && (
        <div
          role="group"
          aria-labelledby="product-unsaved-question"
          className="mb-6 rounded-xl border border-terracotta/40 bg-terracotta/10 p-4"
        >
          <p id="product-unsaved-question" className="text-sm font-medium text-ink">
            You have unsaved changes. Close without saving them?
          </p>
          <p className="mt-1 text-xs text-ink/70">
            Nothing in this form has been saved. Customers aren&apos;t affected either way.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              ref={keepEditingRef}
              type="button"
              onClick={() => setConfirmClose(false)}
              className="rounded-full bg-ink px-4 py-2 text-xs font-medium text-cream hover:bg-ink-light"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmClose(false);
                onClose();
              }}
              className="rounded-full border border-terracotta-deep px-4 py-2 text-xs font-medium text-terracotta-deep hover:bg-terracotta/10"
            >
              Discard changes
            </button>
          </div>
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Where this product stands, before any field: what publishing needs
            and what would make it better. Saving a draft is never blocked. */}
        <ProductInfoPanel
          info={info}
          hidden={!!product && !product.is_active}
          categoryChosen={!!subCategoryId}
        />

        {/* ── BASIC INFORMATION ─────────────────────────────── */}
        <FormSection title="Basic information">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" level="required" required value={form.name} onChange={updateName} />
            <div>
              <Field
                label="Slug (web address)"
                level="required"
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

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-ink/70">
                Category
                <LevelTag level="required" />
              </span>
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
              <span className="font-medium text-ink/70">
                Sub-category
                <LevelTag level="required" />
              </span>
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
              label="Selling price (₹ INR)"
              level="required"
              type="number"
              step="0.01"
              min="0"
              required
              value={form.price_inr}
              onChange={update("price_inr")}
            />
            <div>
              <Field
                label="Cost price (₹ INR)"
                type="number"
                step="0.01"
                min="0"
                placeholder="What it costs us"
                value={form.cost_price_inr}
                onChange={update("cost_price_inr")}
              />
              {/* Worked out as you type, because a cost entered a decimal place
                  out is invisible as a number and obvious as a margin. Left
                  blank deliberately means "not costed yet" — see the payload. */}
              <p className="mt-1 text-xs text-ink/50">{marginHint}</p>
            </div>
          </div>

          <Field
            as="textarea"
            label="Description"
            level={levelOf("description")}
            value={form.description}
            onChange={update("description")}
          />
        </FormSection>

        {/* ── PRODUCT DETAILS ───────────────────────────────── */}
        <FormSection
          title="Product details"
          note="Facts about this piece. Fill in only what you know for certain — an empty box shows nothing on the shop, and is better than a guess."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={labelOf("fabric")}
              level={levelOf("fabric")}
              placeholder={profile === "jewellery" ? "Brass" : "Handloom Cotton-Linen"}
              value={form.fabric}
              onChange={update("fabric")}
            />
            {levelOf("colour") !== "na" && (
              <Field
                label="Colour"
                level={levelOf("colour")}
                placeholder="Indigo"
                value={form.colour}
                onChange={update("colour")}
              />
            )}
            {levelOf("weave") !== "na" && (
              <Field
                label={labelOf("weave")}
                level={levelOf("weave")}
                placeholder="e.g. Handloom"
                maxLength={FACT_MAX.weave}
                value={form.weave}
                onChange={update("weave")}
              />
            )}
            {levelOf("finish") !== "na" && (
              <Field
                label="Finish"
                level={levelOf("finish")}
                placeholder="14K gold plated"
                maxLength={FACT_MAX.finish}
                value={form.finish}
                onChange={update("finish")}
              />
            )}
            {levelOf("dimensions") !== "na" && (
              <Field
                label="Dimensions"
                level={levelOf("dimensions")}
                placeholder={profile === "jewellery" ? "Adjustable · 18 mm band" : "5.5 m × 1.15 m"}
                maxLength={FACT_MAX.dimensions}
                value={form.dimensions}
                onChange={update("dimensions")}
              />
            )}
            {levelOf("blouse_piece") !== "na" && (
              <label className="block text-sm">
                <span className="font-medium text-ink/70">
                  Blouse piece
                  <LevelTag level={levelOf("blouse_piece")} />
                </span>
                <select
                  value={form.blouse_piece}
                  onChange={(e) => setForm((f) => ({ ...f, blouse_piece: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
                >
                  <option value="">Not recorded</option>
                  <option value="included">{BLOUSE_PIECE_LABEL.included}</option>
                  <option value="not_included">{BLOUSE_PIECE_LABEL.not_included}</option>
                </select>
              </label>
            )}
            <Field
              label="Origin"
              level={levelOf("origin")}
              placeholder="e.g. Chendamangalam, Kerala"
              maxLength={FACT_MAX.origin}
              value={form.origin}
              onChange={update("origin")}
            />
          </div>

          {/* BRAND KNOWLEDGE — writing rather than filling in, so boxes with
              room to think in, each labelled with the question it answers.

              Nothing here is generated or suggested. The concierge quotes this
              text to customers as fact about the cloth, so a placeholder somebody
              forgot to replace would be a claim the shop cannot stand behind. */}
          <div className="space-y-4 rounded-xl border border-ink/10 bg-linen/30 p-4">
            <div>
              <h4 className="font-heading text-base text-ink">Story — heritage &amp; craft</h4>
              <p className="mt-1 text-xs text-ink/55">
                Shown on the product page under &ldquo;Heritage &amp; care&rdquo;,
                and it is what Ask Wovenne answers questions out of — so write it as
                you would say it. Leave a box empty and nothing is shown or claimed
                for it.
              </p>
            </div>
            <Field
              as="textarea"
              rows={3}
              label="Heritage — where it comes from"
              level={levelOf("heritage")}
              placeholder="The weaving tradition, the region, what it is called locally."
              value={form.heritage_note}
              onChange={update("heritage_note")}
            />
            <Field
              as="textarea"
              rows={3}
              label="Craft — how it was made"
              level={levelOf("craft")}
              placeholder="The loom, the technique, what makes this piece distinctive."
              value={form.craft_note}
              onChange={update("craft_note")}
            />
          </div>
        </FormSection>

        {/* ── CARE & FIT ────────────────────────────────────── */}
        <FormSection title="Care & fit">
          <div>
            <Field
              as="textarea"
              rows={3}
              label="Care instructions"
              level={levelOf("care")}
              placeholder="Washing, drying, ironing, storing."
              value={form.care_note}
              onChange={update("care_note")}
            />
            {/* Said here because it is not obvious: the product page has NO
                fallback care advice (SEO-6A, lib/care). This note is the only
                care a customer sees, and without it there is no care section. */}
            <p className="mt-1 text-xs text-ink/50">
              {form.care_note.trim()
                ? "Shown on the product page as this piece's care advice."
                : "Empty: the product page shows no care advice for this piece."}
            </p>
          </div>

          {levelOf("fit") !== "na" && (
            <Field
              as="textarea"
              rows={2}
              label="Fit & sizing"
              level={levelOf("fit")}
              placeholder="Relaxed fit. Between sizes, choose the larger."
              maxLength={FACT_MAX.fit_note}
              value={form.fit_note}
              onChange={update("fit_note")}
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {/* DERIVED, NOT TYPED, once a product has sizes (migration 0056).
                The database overwrites whatever this field sends with the sum of
                the sizes, so leaving it editable would be offering a control that
                silently does nothing — which is how 001 came to claim 2 units
                while holding 13. Stock is managed in one place: below. */}
            {sizes.length > 0 ? (
              <label className="block">
                <span className="text-sm font-medium text-ink/70">Stock Quantity</span>
                <input
                  type="text"
                  readOnly
                  tabIndex={-1}
                  value={sizes.reduce((n, sz) => n + (Number(sz.stock_quantity) || 0), 0)}
                  className="mt-1 w-full cursor-not-allowed rounded-lg border border-ink/10 bg-linen/50 px-3 py-2 text-ink/60"
                />
                <span className="mt-1 block text-xs text-ink/55">
                  Added up from the sizes below — edit it there.
                </span>
              </label>
            ) : (
              <div className="sm:col-span-2">
                <Field
                  label={isEdit ? "Stock on the shelf" : "Opening stock"}
                  type="number"
                  min="0"
                  required
                  value={form.stock_quantity}
                  onChange={update("stock_quantity")}
                />
                {/* Said plainly: this is the one field in the form that is not a
                    draft. Stock is live inventory, and Publish never changes it
                    (migration 0060). */}
                <span className="mt-1 block text-xs text-ink/55">
                  {isEdit
                    ? `Live inventory, not part of the draft: a change here goes live when you press Save, not at Publish. It is checked against the ${product!.stock_quantity} shown when you opened this, so a sale in the meantime is never overwritten.`
                    : "Goes live when the product is first published. After that, stock is changed here or in the table and saves immediately."}
                </span>
              </div>
            )}
          </div>

          <fieldset className="rounded-lg border border-ink/10 p-4">
            <legend className="px-2 text-sm font-medium text-ink/70">
              Sizes &amp; stock
            </legend>

            <p className="text-xs text-ink/60">
              Leave empty for products sold in one size — sarees, home — which use
              the single stock number above. Add sizes and this becomes the only
              place stock is managed: the product total is added up from these, and
              the field above turns into a read-out of that sum.
            </p>
            {/* Said plainly because it contradicts every other field in this
                form, and an admin who assumed otherwise would oversell. */}
            <p className="mt-2 rounded-lg bg-linen/60 px-3 py-2 text-xs text-ink/70">
              Sizes and their stock save <strong>immediately</strong> — they
              don&apos;t wait for Publish. Stock has to match what&apos;s really on
              the shelf, and an order can&apos;t wait for a publish either. Only the
              counts you change are saved, and only if nothing has sold or changed
              since you opened this.
            </p>

            {sizes.length > 0 && (
              <div className="mt-4 space-y-2">
                {sizes.map((sz, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={sz.label}
                      onChange={(e) =>
                        setSizes((rows) =>
                          rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r))
                        )
                      }
                      placeholder="Size"
                      aria-label={`Size ${i + 1} label`}
                      className="w-28 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
                    />
                    <input
                      type="number"
                      min="0"
                      value={sz.stock_quantity}
                      onChange={(e) =>
                        setSizes((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, stock_quantity: Number(e.target.value) } : r
                          )
                        )
                      }
                      aria-label={`${sz.label || `Size ${i + 1}`} stock`}
                      className="w-24 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
                    />
                    <span className="text-xs text-ink/50">
                      {sz.stock_quantity <= 0 ? "sold out" : "in stock"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSizes((rows) => rows.filter((_, j) => j !== i))}
                      className="ml-auto text-xs text-terracotta-dark hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() =>
                  setSizes((rows) => [...rows, { label: "", stock_quantity: 0 }])
                }
                className="rounded-full border border-ink/20 px-4 py-2 text-xs text-ink transition-colors hover:border-ink"
              >
                Add a size
              </button>
              {sizes.length === 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSizes(DEFAULT_SIZE_RUN.map((label) => ({ label, stock_quantity: 0 })))
                  }
                  className="rounded-full border border-ink/20 px-4 py-2 text-xs text-ink transition-colors hover:border-ink"
                >
                  Use {DEFAULT_SIZE_RUN.join(" · ")}
                </button>
              )}
            </div>
          </fieldset>
        </FormSection>

        {/* ── IMAGES ────────────────────────────────────────── */}
        <FormSection
          title="Images"
          aside={stage ?? `${images.length} added${images.length > 1 ? " · first is the cover" : ""}`}
        >
          {images.length > 0 && (
            <ol className="space-y-3">
              {images.map((photo, i) => {
                const advice = altTextAdvice(photo.alt, {
                  productName: form.name,
                  others: images.filter((_, j) => j !== i).map((p) => p.alt),
                });
                const altLevel: InfoLevel = i === 0 ? levelOf("cover_alt") : levelOf("gallery_alt");
                return (
                  <li key={photo.url} className="flex gap-3 rounded-lg border border-ink/10 p-2">
                    <div className="relative aspect-[4/5] w-20 shrink-0 overflow-hidden rounded-md bg-linen">
                      <Image
                        src={photo.url}
                        alt={photo.alt.trim() || `Photo ${i + 1}`}
                        fill
                        sizes="80px"
                        className="object-cover"
                      />
                      {i === 0 && (
                        <span className="absolute left-1 top-1 rounded bg-ink/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-cream">
                          Cover
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <label className="block text-sm">
                        <span className="font-medium text-ink/70">
                          {i === 0 ? "Main image alt text" : `Photo ${i + 1} alt text`}
                          <LevelTag level={altLevel} />
                        </span>
                        <input
                          value={photo.alt}
                          maxLength={ALT_TEXT_MAX}
                          onChange={(e) => setAlt(i, e.target.value)}
                          placeholder={
                            i === 0
                              ? "e.g. Off-white saree with a red border, draped"
                              : "e.g. Close-up of the zari border"
                          }
                          className="mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
                        />
                      </label>
                      <p className={`mt-1 text-xs ${advice ? "text-amber-700" : "text-ink/50"}`}>
                        {advice ??
                          (photo.alt.trim()
                            ? "Read aloud to customers using a screen reader."
                            : i === 0
                              ? `Empty: the shop uses the product name — “${form.name || "…"}”.`
                              : `Empty: the shop says “${form.name || "…"} — image ${i + 1} of ${images.length}”.`)}
                      </p>
                      <div className="mt-1 flex items-center gap-1">
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
                          onClick={() => moveImage(i, 1)}
                          disabled={i === images.length - 1}
                          aria-label={`Move photo ${i + 1} later`}
                          className="rounded p-0.5 text-ink/40 hover:text-ink disabled:opacity-25"
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeImage(i)}
                          aria-label={`Remove photo ${i + 1}`}
                          className="ml-2 inline-flex items-center gap-1 rounded p-0.5 text-xs text-ink/45 hover:text-terracotta"
                        >
                          <X className="h-3.5 w-3.5" /> Remove
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {/* sr-only, not display:none: a hidden input can't take focus, so
              the photo upload was unreachable from the keyboard. The ring on
              the label shows where focus is. */}
          <div>
            <label className="inline-block cursor-pointer rounded-full border border-ink/15 px-4 py-2 text-sm text-ink transition-colors focus-within:ring-2 focus-within:ring-terracotta focus-within:ring-offset-2 hover:border-terracotta">
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
                className="sr-only"
              />
            </label>
            <p className="mt-1 text-xs text-ink/50">
              The first photo is used everywhere the product is listed. Alt text
              describes each photo for people who can&apos;t see it — say what is
              in the picture, not keywords. Removing a photo here leaves the file
              in storage; it just stops being used.
            </p>
          </div>

          <div>
            <Field
              label="Product video"
              level="optional"
              placeholder="Paste the YouTube link"
              value={form.video_youtube_id}
              onChange={update("video_youtube_id")}
            />
            <p className="mt-1 text-xs text-ink/50">{videoHint}</p>
          </div>
        </FormSection>

        {/* ── SEARCH & DISCOVERY ────────────────────────────── */}
        <FormSection
          title="Search & discovery"
          note="Optional. Leave blank and the shop writes these from the product's name and details — you only need to fill them in to say something better."
        >
          <div>
            <Field
              label="SEO title"
              level={levelOf("seo_title")}
              placeholder={form.name || "Product name"}
              maxLength={SEO_TITLE_MAX}
              value={form.seo_title}
              onChange={update("seo_title")}
            />
            <p className="mt-1 text-xs text-ink/50">
              <SourceTag custom={seo.titleSource === "custom"} />
              {seo.titleSource === "custom"
                ? `${form.seo_title.trim().length}/${SEO_TITLE_MAX}. “${PRODUCT_TITLE_SUFFIX.trim()}” is added for you.`
                : "Using the product name. The shop name is added for you."}
              {seo.title.length > 65 && " Long titles are cut short in search results."}
            </p>
          </div>
          <div>
            <Field
              as="textarea"
              rows={2}
              label="Meta description"
              level={levelOf("meta_description")}
              placeholder={seo.descriptionSource === "auto" ? seo.description : undefined}
              maxLength={META_DESCRIPTION_LIMIT}
              value={form.meta_description}
              onChange={update("meta_description")}
            />
            <p className="mt-1 text-xs text-ink/50">
              <SourceTag custom={seo.descriptionSource === "custom"} />
              {seo.descriptionSource === "custom"
                ? `${form.meta_description.trim().length}/${META_DESCRIPTION_LIMIT}.`
                : form.description.trim()
                  ? "Taken from the description."
                  : "Composed from the name, fabric and category — write a description, or one here, to say more."}
            </p>
          </div>

          {/* What a search result will show, built by the function the product
              page renders its <head> with — so the two cannot disagree. */}
          <div className="rounded-lg border border-ink/10 bg-white px-4 py-3" aria-label="Search result preview">
            <p className="text-[11px] uppercase tracking-wider text-ink/40">Search result preview</p>
            <p className="mt-1 truncate text-[15px] text-[#1a0dab]">{seo.title}</p>
            <p className="truncate text-xs text-emerald-800">thewovenne.com{previewPath}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink/70">{seo.description}</p>
          </div>
        </FormSection>

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

        <ProductAssistantPanel
          state={assistant}
          canRequest={!assistantBlocked}
          blockedReason={assistantBlocked}
          onRequest={requestSuggestions}
          onCancel={cancelSuggestions}
          current={{
            name: form.name,
            description: form.description,
            seoTitle: form.seo_title,
            metaDescription: form.meta_description,
          }}
          emptyText={{
            name: "Empty",
            description: "Empty",
            seoTitle: "Empty — the shop uses the product name.",
            metaDescription: "Empty — the shop writes one from the name and details.",
          }}
          photos={images}
          review={reviewSuggestion}
          onUseField={acceptCopySuggestion}
          onUseAlt={(url, value) => setImages((photos) => applyAltSuggestion(photos, url, value))}
        />

        {checkOpen ? (
          <ProductContentCheck
            check={contentCheck}
            ignored={ignoredFindings}
            onIgnore={(id) => setIgnoredFindings((prev) => new Set(prev).add(id))}
            onRestoreIgnored={() => setIgnoredFindings(new Set())}
            onUse={acceptSuggestion}
            saveLabel="Save draft"
          />
        ) : (
          <button
            type="button"
            onClick={() => setCheckOpen(true)}
            className="rounded-full border border-ink/15 px-4 py-2 text-sm text-ink transition-colors hover:border-terracotta"
          >
            Check this product&apos;s content
          </button>
        )}

        {error && (
          <p role="alert" className="whitespace-pre-line text-sm text-terracotta-dark">
            {error}
          </p>
        )}

        <div>
          <Button
            type="submit"
            disabled={saving || uploading}
            size="lg"
            className="w-full"
            aria-describedby="product-save-meaning"
          >
            {saving ? "Saving draft…" : "Save draft"}
          </Button>
          {/* What Save does, said where it is pressed. Publishing is a separate
              step in the bar at the top of the dashboard. */}
          <p id="product-save-meaning" className="mt-2 text-center text-xs text-ink/70">
            {dirty && <span className="font-medium text-ink">Unsaved changes · </span>}
            {hasPublished
              ? "Saves a draft — customers keep seeing the live version until you publish. Stock and sizes are the exception: they change on the shop as soon as you save."
              : "Saves a draft — customers can't see this product until you publish it."}
          </p>
          {/* The same list as the panel at the top, said once more where the
              decision is made. Saving still works; this is about Publish. */}
          {!info.publishable && !(product && !product.is_active) && (
            <p className="mt-1 text-center text-xs text-terracotta-dark">
              Publishing will wait for: {info.missingRequired.join(", ")}.
            </p>
          )}
        </div>
      </form>
    </Modal>
  );
}

type FieldProps = { label: string; level?: InfoLevel } & (
  | ({ as: "textarea" } & TextareaHTMLAttributes<HTMLTextAreaElement>)
  | ({ as?: "input" } & InputHTMLAttributes<HTMLInputElement>)
);

function Field({ label, level, as = "input", ...props }: FieldProps) {
  const fieldClassName =
    "mt-1 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none";

  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">
        {label}
        {level && <LevelTag level={level} />}
      </span>
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

/**
 * One titled group of the form. A heading and a rule rather than a box, so the
 * form reads as a few clear sections instead of one wall of inputs.
 */
function FormSection({
  title,
  note,
  aside,
  children,
}: {
  title: string;
  note?: string;
  /** A short status on the right of the heading, e.g. the photo count. */
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-ink/10 pt-6 first:border-t-0 first:pt-0">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-heading text-xl text-ink">{title}</h3>
          {aside && <span className="text-xs text-ink/40">{aside}</span>}
        </div>
        {note && <p className="mt-1 text-xs text-ink/55">{note}</p>}
      </div>
      {children}
    </section>
  );
}

/** Whether the search text shown is the admin's own or the automatic fallback. */
function SourceTag({ custom }: { custom: boolean }) {
  return (
    <span
      className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
        custom ? "bg-ink text-cream" : "bg-ink/10 text-ink/60"
      }`}
    >
      {custom ? "Custom value" : "Auto-generated fallback"}
    </span>
  );
}
