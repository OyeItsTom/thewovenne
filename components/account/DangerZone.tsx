"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { logOut } from "@/lib/customerAuth";
import AuthMessage from "./AuthMessage";

/**
 * Deleting the account.
 *
 * Placed last, behind a disclosure, and requiring the word DELETE typed out —
 * not to discourage anyone, but because it cannot be undone. Deletion is a
 * right under the DPDP Act, so it is genuinely reachable: one click to open,
 * no support ticket, no email to write.
 *
 * What actually happens is spelled out before the button, because "delete my
 * account" means different things at different shops and a customer is entitled
 * to know which one this is.
 */
export default function DangerZone() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);

    const { data, error: rpcError } = await getBrowserSupabase().rpc(
      "delete_my_account"
    );
    if (rpcError) {
      setBusy(false);
      return setError(rpcError.message);
    }

    const result = data as { ok: boolean; reason?: string };
    if (!result?.ok) {
      setBusy(false);
      return setError(result?.reason ?? "We couldn't delete the account.");
    }

    // The account is gone; the session in this browser is not, until it is
    // ended. Leaving it would show a signed-in shell pointing at nothing.
    await logOut();
    router.push("/?deleted=1");
    router.refresh();
  }

  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h2 className="font-heading text-xl text-ink">Advanced</h2>

      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="mt-3 text-sm text-ink/50 underline-offset-4 hover:text-terracotta hover:underline"
        >
          Delete my account
        </button>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="rounded-lg bg-linen/60 p-4 text-sm leading-relaxed text-ink/70">
            <p className="flex items-start gap-2 font-medium text-ink">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
              This cannot be undone.
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li>Your profile, wishlist, saved basket and preferences are deleted.</li>
              <li>Any loyalty points are lost — they can&apos;t be transferred.</li>
              <li>
                Past orders are kept as financial records, but with your name,
                email, phone and address removed from them.
              </li>
              <li>You&apos;ll be signed out and won&apos;t be able to sign back in.</li>
            </ul>
            <p className="mt-3">
              If an order is still on its way, we&apos;ll ask you to wait until it
              arrives — we need your address to deliver it.
            </p>
          </div>

          {error && <AuthMessage tone="error">{error}</AuthMessage>}

          <label className="block text-sm">
            <span className="font-medium text-ink/70">
              Type DELETE to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink focus:border-terracotta focus:outline-none"
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={remove}
              disabled={busy || typed !== "DELETE"}
              className="inline-flex items-center gap-2 rounded-full bg-terracotta-dark px-5 py-2.5 text-sm font-medium text-cream transition-colors hover:opacity-90 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete my account
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setTyped("");
                setError(null);
              }}
              className="text-sm text-ink/50 hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
