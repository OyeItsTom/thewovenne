import { create } from "zustand";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBrowserSupabase } from "./supabaseLazy";

/**
 * The signed-in customer's saved products.
 *
 * Loaded once per page and shared, rather than each product card asking the
 * database whether it is saved — a grid of twenty would otherwise fire twenty
 * queries to render twenty hearts. "Once" means one request in flight at a
 * time: every heart on the grid calls load() as it mounts, and they all share
 * the same promise.
 *
 * WHO IS SIGNED IN HAS THREE ANSWERS, not two. "unknown" is the state before
 * the session has been read, and after a read that failed (offline, a 5xx). It
 * is never treated as signed out: doing that sent a signed-in customer to the
 * login page from the heart. A heart tapped while the answer is unknown waits
 * for it.
 *
 * The answer follows the session. The store outlives page navigations, and the
 * login form signs in and navigates client-side, so a store that read "signed
 * out" on the shop page and never looked again went on believing it after the
 * customer had signed in — every heart then sent them back to log in (fixed 10
 * Oct 2026). It now listens for sign-in, sign-out and account switches, and
 * reloads for whoever is signed in now; a signed-out device drops the previous
 * customer's hearts.
 *
 * Writes are optimistic. A heart that waits for a round trip feels broken, and
 * the cost of being wrong is that one item's state flickers back, which the
 * revert below handles.
 */

export type WishlistAuth = "unknown" | "signedIn" | "signedOut";
export type ToggleResult = "added" | "removed" | "signin" | "error";

export interface WishlistState {
  ids: Set<string>;
  auth: WishlistAuth;
  /** Whose hearts `ids` holds; null unless auth is "signedIn". */
  userId: string | null;
  load: () => Promise<void>;
  toggle: (productId: string) => Promise<ToggleResult>;
}

type User = { id: string } | null;
type AuthError = { name?: string; status?: number } | null;

/**
 * Does a getUser() without a user mean "nobody is signed in", or "we could not
 * find out"? Only the second may be retried; only the first may send anyone to
 * log in. A network failure or a server error says nothing about the session.
 */
function couldNotTell(error: AuthError): boolean {
  if (!error) return false;
  if (error.name === "AuthRetryableFetchError") return true;
  const status = error.status ?? 0;
  return status === 0 || status === 429 || status >= 500;
}

export function createWishlistStore(
  getClient: () => Promise<SupabaseClient> = loadBrowserSupabase
) {
  let inflight: Promise<void> | null = null;
  // Bumped on every session change, so a load that started for the previous
  // customer cannot land its result on top of the next one's.
  let generation = 0;
  let listening = false;

  return create<WishlistState>((set, get) => {
    async function read(gen: number) {
      const supabase = await getClient();
      listen(supabase);

      const {
        data: { user },
        error,
      } = (await supabase.auth.getUser()) as { data: { user: User }; error: AuthError };
      if (gen !== generation) return;

      if (!user) {
        if (couldNotTell(error)) {
          console.error("wishlist session:", error?.name ?? error);
          return; // stays "unknown"; the next load or tap asks again
        }
        set({ auth: "signedOut", userId: null, ids: new Set() });
        return;
      }

      // RLS limits this to the caller's own rows, so no user_id filter is
      // needed — adding one would imply the policy were optional.
      const { data, error: listError } = await supabase.from("wishlists").select("product_id");
      if (gen !== generation) return;
      if (listError) console.error("wishlist load:", listError.message);
      set({
        auth: "signedIn",
        userId: user.id,
        ids: new Set((data ?? []).map((r) => (r as { product_id: string }).product_id)),
      });
    }

    function listen(supabase: SupabaseClient) {
      if (listening) return;
      listening = true;
      supabase.auth.onAuthStateChange((event, session) => {
        if (event === "INITIAL_SESSION") return; // load() reads that itself
        const now = session?.user?.id ?? null;
        const { auth, userId } = get();
        // A token refresh for the same customer changes nothing they can see.
        if (auth === "signedIn" && now === userId) return;
        if (auth === "signedOut" && now === null) return;

        generation++;
        inflight = null;
        set({ auth: "unknown", userId: null, ids: new Set() });
        // Deferred: Supabase holds its own auth work open while it calls this
        // listener, and a getUser() from inside it is what it warns deadlocks.
        setTimeout(() => void get().load(), 0);
      });
    }

    return {
      ids: new Set(),
      auth: "unknown",
      userId: null,

      load: () => {
        if (get().auth !== "unknown") return Promise.resolve();
        if (!inflight) {
          const gen = generation;
          inflight = read(gen).finally(() => {
            if (gen === generation) inflight = null;
          });
        }
        return inflight;
      },

      toggle: async (productId: string) => {
        if (get().auth === "unknown") {
          try {
            await get().load();
          } catch (e) {
            console.error("wishlist session:", e);
          }
        }
        const { auth, userId, ids } = get();
        // Still unknown means the session could not be read. Saying "log in"
        // to someone who may well be logged in is the bug this guards against.
        if (auth === "unknown" || (auth === "signedIn" && !userId)) return "error";
        if (auth === "signedOut") return "signin";

        const saved = ids.has(productId);
        const next = new Set(ids);
        if (saved) next.delete(productId);
        else next.add(productId);
        set({ ids: next });

        const supabase = await getClient();
        const { error } = saved
          ? await supabase
              .from("wishlists")
              .delete()
              .eq("product_id", productId)
              .eq("user_id", userId!)
          : await supabase.from("wishlists").insert({ product_id: productId, user_id: userId! });

        if (error) {
          // Put it back: a heart that stays filled after a failed save is a lie.
          console.error("wishlist toggle:", error.message);
          if (get().userId === userId) set({ ids });
          // The write may have failed because the session ended (expired, or
          // signed out elsewhere). Only then is "log in" the right answer.
          const {
            data: { user },
            error: userError,
          } = (await supabase.auth.getUser()) as { data: { user: User }; error: AuthError };
          if (!user && !couldNotTell(userError)) {
            generation++;
            set({ auth: "signedOut", userId: null, ids: new Set() });
            return "signin";
          }
          return "error";
        }
        return saved ? "removed" : "added";
      },
    };
  });
}

export const useWishlistStore = createWishlistStore();
