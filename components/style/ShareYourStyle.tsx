"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { getBrowserSupabase } from "@/lib/supabase";
import { getMySubmission, type MySubmission } from "@/lib/style";
import StyleSubmissionForm from "./StyleSubmissionForm";

/**
 * The way in, on a delivered order.
 *
 * WHY HERE. A customer who has just received something is the only person who
 * can submit — has_purchased() wants a paid, DELIVERED order — and their orders
 * page is where they already are. The product page gets its own entry point when
 * the gallery lands; this one needs no new route and no new query, because the
 * order already knows what they bought.
 *
 * The state is loaded on OPEN rather than on render. A customer with six items in
 * an order should not make six queries for submissions they have not thought
 * about yet, and the answer is only interesting once they have clicked.
 */
export default function ShareYourStyle({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const [open, setOpen] = useState(false);
  const [existing, setExisting] = useState<MySubmission | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setExisting(await getMySubmission(productId, getBrowserSupabase()));
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/55 transition-colors hover:text-terracotta"
      >
        <Camera className="h-3.5 w-3.5" />
        Share your style
      </button>

      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={existing && !canReplace(existing) ? "Your photograph" : `Share your ${productName}`}
      >
        {loading ? (
          <p className="py-6 text-center text-sm text-ink/55">One moment…</p>
        ) : existing && !canReplace(existing) ? (
          <Status submission={existing} />
        ) : (
          <StyleSubmissionForm
            productId={productId}
            productName={productName}
            existing={existing}
            onDone={load}
          />
        )}
      </Modal>
    </>
  );
}

/**
 * Whether the form should be shown rather than a status.
 *
 * A rejected submission can be replaced (0053). An approved or pending one
 * cannot: pending is waiting on us, and approved is public and may only be
 * withdrawn — replacing a photograph an admin agreed to with one nobody has seen
 * is the thing the whole moderation model exists to prevent.
 */
function canReplace(submission: MySubmission): boolean {
  return submission.status === "rejected" && !submission.withdrawnAt;
}

function Status({ submission }: { submission: MySubmission }) {
  const [busy, setBusy] = useState(false);
  const [withdrawn, setWithdrawn] = useState(Boolean(submission.withdrawnAt));

  /**
   * Withdrawal is one UPDATE the customer is allowed to make themselves (0047),
   * and it takes effect immediately — the public view filters on withdrawn_at, so
   * nothing waits on an admin. That is the point: under the DPDP Act taking
   * consent back must be as easy as giving it.
   */
  async function withdraw() {
    setBusy(true);
    const { error } = await getBrowserSupabase()
      .from("style_submissions")
      .update({ withdrawn_at: new Date().toISOString() })
      .eq("id", submission.id);
    setBusy(false);
    if (!error) setWithdrawn(true);
  }

  if (withdrawn) {
    return (
      <p className="py-4 text-sm text-ink/70">
        Taken down. It is no longer shown anywhere on the site.
      </p>
    );
  }

  return (
    <div className="space-y-4 py-2">
      <p className="text-sm text-ink/70">
        {submission.status === "pending"
          ? "We have your photograph and are looking at it. We'll email you either way — usually within a day or two."
          : "Your photograph is on the site. Thank you — it makes a real difference to people deciding."}
      </p>

      {submission.status === "approved" && (
        <button
          onClick={() => void withdraw()}
          disabled={busy}
          className="text-xs uppercase tracking-wider text-terracotta-dark transition-colors hover:underline disabled:opacity-40"
        >
          Take it down
        </button>
      )}
    </div>
  );
}
