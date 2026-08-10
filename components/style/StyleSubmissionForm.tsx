"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Check, Loader2, Upload, X } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { PHOTO_GUIDANCE, LINK_HELP, parseStyleLink } from "@/lib/styleMedia";
import { PhotoUnreadableError, prepareStylePhoto, type PreparedPhoto } from "@/lib/stylePhoto";
import type { MySubmission } from "@/lib/style";

/**
 * "Share your style" — a customer sending us a photograph of something they own.
 *
 * THE RULES ARE NOT HERE. Verified purchase, consent, one per product, nobody
 * self-approving: all of that is enforced by RLS and by 0053's function. This
 * form's job is to ask well and to explain what happens next; if it disagreed
 * with the database the database would win, which is the correct way round.
 *
 * WHAT IT IS CAREFUL ABOUT is consent. The checkbox is unticked, it is separate
 * from the credit-name question, and neither is bundled into "submit". Being
 * happy for a photograph to appear and being happy to be named beside it are two
 * different permissions, and a form that collects them as one has collected
 * neither properly.
 */

type Stage = "idle" | "preparing" | "sending" | "done";

export default function StyleSubmissionForm({
  productId,
  productName,
  existing,
  onDone,
}: {
  productId: string;
  productName: string;
  /** Their previous submission, if any — this form doubles as the resubmit form. */
  existing?: MySubmission | null;
  onDone?: () => void;
}) {
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [link, setLink] = useState("");
  const [caption, setCaption] = useState("");
  const [creditName, setCreditName] = useState("");
  const [consent, setConsent] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Object URLs are a leak if the component goes away mid-flow.
  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.previewUrl);
  }, [photo]);

  const parsedLink = link.trim() ? parseStyleLink(link) : null;
  const linkBad = link.trim().length > 0 && parsedLink === null;
  const hasSomething = Boolean(photo || parsedLink);
  const isResubmit = Boolean(existing && existing.status === "rejected");

  async function choose(file: File | undefined) {
    if (!file) return;
    setError(null);
    setStage("preparing");
    try {
      const prepared = await prepareStylePhoto(file);
      if (photo) URL.revokeObjectURL(photo.previewUrl);
      setPhoto(prepared);
    } catch (e) {
      setError(
        e instanceof PhotoUnreadableError
          ? e.message
          : "That photograph could not be prepared. Try another one."
      );
    } finally {
      setStage("idle");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!hasSomething) return setError("Add a photograph or a link first.");
    if (linkBad) return setError(LINK_HELP);
    if (!consent) return setError("We need your permission before we can show it.");

    setStage("sending");
    const client = getBrowserSupabase();

    try {
      const {
        data: { user },
      } = await client.auth.getUser();
      if (!user) throw new Error("Please sign in again — your session has expired.");

      let photoUrl: string | null = null;
      if (photo) {
        // The path starts with the user's id because the storage policy (0052)
        // requires it: a customer may only write inside their own folder.
        const path = `${user.id}/${crypto.randomUUID()}.jpg`;
        const { error: uploadError } = await client.storage
          .from("style-photos")
          .upload(path, photo.file, { cacheControl: "31536000", upsert: false });
        if (uploadError) throw uploadError;
        photoUrl = client.storage.from("style-photos").getPublicUrl(path).data.publicUrl;
      }

      const shared = {
        photo_url: photoUrl,
        photo_width: photo?.width ?? null,
        photo_height: photo?.height ?? null,
        video_platform: parsedLink?.platform ?? null,
        video_url: parsedLink?.url ?? null,
        caption: caption.trim() || null,
        credit_name: creditName.trim() || null,
      };

      let submissionId = existing?.id ?? null;

      if (existing) {
        // A second INSERT is refused by the one-per-customer-per-product index,
        // so a replacement goes through 0053's function — which also puts it back
        // in front of an admin and clears the old rejection.
        const { error: rpcError } = await client.rpc("resubmit_style", {
          p_id: existing.id,
          p_photo_url: shared.photo_url,
          p_photo_width: shared.photo_width,
          p_photo_height: shared.photo_height,
          p_video_platform: shared.video_platform,
          p_video_url: shared.video_url,
          p_caption: shared.caption,
          p_credit_name: shared.credit_name,
        });
        if (rpcError) throw rpcError;
      } else {
        const { data: inserted, error: insertError } = await client
          .from("style_submissions")
          .insert({
            product_id: productId,
            user_id: user.id,
            ...shared,
            // The moment permission was given, recorded as a fact rather than
            // inferred later from the row existing.
            consented_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (insertError) throw insertError;
        submissionId = inserted?.id ?? null;
      }

      // ── Ask the server to tell the shop ──
      // AFTER the submission is saved and OUTSIDE its error handling, on
      // purpose. Nobody's photograph should appear to have failed because the
      // shop's own notification did — the customer is done either way. A miss
      // here leaves admin_notified_at null, which is what the queue shows as
      // un-announced rather than losing quietly.
      if (submissionId) {
        void fetch("/api/style/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: submissionId }),
          // keepalive so the request still goes if this component unmounts
          // or the customer navigates away the moment they press send.
          keepalive: true,
        }).catch(() => {
          /* Their submission is safe; the shop finds it in the queue. */
        });
      }

      setStage("done");
      onDone?.();
    } catch (e) {
      setStage("idle");
      const message = e instanceof Error ? e.message : "Something went wrong.";
      setError(
        // The database's own words are usually right — 0053 raises sentences on
        // purpose — but a duplicate-key error is machine noise, so it is
        // translated into the thing that actually happened.
        /duplicate key|already exists/i.test(message)
          ? "You've already shared a photograph of this piece. We'll be in touch about it."
          : message
      );
    }
  }

  if (stage === "done") {
    return (
      <div className="rounded-2xl border border-ink/10 bg-linen/40 p-6 text-center">
        <Check className="mx-auto h-6 w-6 text-terracotta" />
        <p className="mt-3 font-heading text-xl text-ink">Thank you</p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-ink/65">
          We look at every photograph ourselves, so it may be a day or two before
          it appears. We&apos;ll email you either way.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {isResubmit && existing?.rejectReason && (
        <div className="rounded-lg bg-linen/60 px-4 py-3 text-sm text-ink/75">
          <p className="font-medium text-ink">About your last photograph</p>
          <p className="mt-1">{existing.rejectReason}</p>
          <p className="mt-1 text-xs text-ink/55">
            Send another whenever you like — this replaces it.
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      {/* ── The photograph ── */}
      <div>
        <span className="text-xs uppercase tracking-wider text-ink/50">
          Your photograph
        </span>

        {photo ? (
          <div className="mt-2 flex items-start gap-4">
            {/* Unoptimised: this is a blob: URL for a file that has not been
                uploaded yet, and Next's optimizer cannot fetch one. */}
            <Image
              src={photo.previewUrl}
              alt=""
              width={photo.width}
              height={photo.height}
              unoptimized
              className="h-32 w-auto rounded-lg object-cover"
            />
            <div className="text-xs text-ink/55">
              <p>
                {photo.width}×{photo.height}
              </p>
              {photo.wasSmall && (
                // Said, not enforced. A photograph somebody is happy with is
                // worth more than one that met a number.
                <p className="mt-1 text-ink/70">
                  A little small, so it may look soft at full width — still very
                  welcome.
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(photo.previewUrl);
                  setPhoto(null);
                  if (fileInput.current) fileInput.current.value = "";
                }}
                className="mt-2 inline-flex items-center gap-1 text-ink/55 hover:text-terracotta-dark"
              >
                <X className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          </div>
        ) : (
          <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-ink/25 px-4 py-6 text-sm text-ink/70 transition-colors hover:border-terracotta">
            {stage === "preparing" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {stage === "preparing" ? "Preparing…" : "Choose a photograph"}
            <input
              ref={fileInput}
              type="file"
              accept={PHOTO_GUIDANCE.acceptAttribute}
              className="hidden"
              onChange={(e) => void choose(e.target.files?.[0])}
            />
          </label>
        )}

        <p className="mt-2 text-xs text-ink/55">{PHOTO_GUIDANCE.help}</p>
      </div>

      {/* ── Or a link ── */}
      <div>
        <label className="block text-sm">
          <span className="text-xs uppercase tracking-wider text-ink/50">
            Or a link you&apos;ve already posted
          </span>
          <input
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="instagram.com/reel/… or youtube.com/watch?v=…"
            className="mt-2 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
          />
        </label>
        <p className="mt-1 text-xs text-ink/55">
          {linkBad ? (
            <span className="text-terracotta-dark">{LINK_HELP}</span>
          ) : parsedLink ? (
            `${parsedLink.platform === "youtube" ? "YouTube" : "Instagram"} — we'll show it as a link, never embedded.`
          ) : (
            LINK_HELP
          )}
        </p>
      </div>

      <label className="block text-sm">
        <span className="text-xs uppercase tracking-wider text-ink/50">
          Anything you&apos;d like to say (optional)
        </span>
        <textarea
          rows={2}
          maxLength={300}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={`Wearing the ${productName}…`}
          className="mt-2 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
        />
      </label>

      {/* ── Consent, and credit, as two separate questions ── */}
      <div className="space-y-3 rounded-xl bg-linen/40 p-4">
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1"
          />
          <span>
            I agree to have this featured publicly on The Wovenne&apos;s website
            and social media
            <span className="mt-0.5 block text-xs text-ink/55">
              You can change your mind at any time and it comes down straight
              away — no need to ask us.
            </span>
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink/70">
            First name to credit (optional)
          </span>
          <input
            type="text"
            maxLength={40}
            value={creditName}
            onChange={(e) => setCreditName(e.target.value)}
            placeholder="Leave empty to appear anonymously"
            className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
          />
          {/* Separate from consent on purpose: agreeing to appear and agreeing to
              be named are two permissions, and one checkbox cannot carry both. */}
          <span className="mt-1 block text-xs text-ink/55">
            First name only. Leave it empty and your photograph appears without a
            name.
          </span>
        </label>
      </div>

      <button
        type="submit"
        disabled={stage === "sending" || !hasSomething || !consent}
        className="inline-flex items-center gap-2 rounded-full bg-terracotta px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-terracotta-dark disabled:opacity-50"
      >
        {stage === "sending" && <Loader2 className="h-4 w-4 animate-spin" />}
        {isResubmit ? "Send this one instead" : "Share your style"}
      </button>
    </form>
  );
}
