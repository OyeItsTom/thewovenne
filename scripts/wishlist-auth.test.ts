/**
 * A signed-in customer's heart saves the product. It never sends them to log in.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/wishlist-auth.test.ts
 *
 * The defect (10 Oct 2026, found verifying #189 signed in): tapping a heart on
 * a product card sent a signed-in customer to /in/login. The wishlist store
 * read the session ONCE per page lifetime and cached the answer as a boolean.
 * Browsing the shop signed out cached "signed out"; the login form then signs
 * in and navigates client-side, so the store survived the sign-in still
 * believing it — and every heart pushed the customer back to the login page.
 * A failed session read (offline, a 5xx) cached "signed out" the same way.
 * Present since the heart shipped (36a9126, 3 Aug); #189 only changed how the
 * client is imported.
 *
 * Also proven here: one session read and one wishlist query per page however
 * many hearts mount (production fired one of each PER CARD — 26 on /in/shop).
 *
 * The store runs against an in-memory Supabase double, so every timing — a tap
 * before the session is read, a sign-in mid-load — is set by the test, not by a
 * network.
 */
import fs from "node:fs";
import { createWishlistStore } from "../lib/wishlistStore";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const SAREE = "9de8314b-2b6d-4af0-81a5-25c3e8499334";
const RING = "8a2dc6c3-dc57-429c-9377-6501361ee011";

type Row = { user_id: string; product_id: string };
type Listener = (event: string, session: { user: { id: string } } | null) => void;

/** One browser's Supabase client over one shared database. */
function fakeSupabase(db: Row[], opts: { user: string | null; userDelay?: number; userError?: object | null }) {
  const calls = { getUser: 0, select: 0, insert: 0, delete: 0, listen: 0 };
  const listeners: Listener[] = [];
  const session = { user: opts.user as string | null, userError: opts.userError ?? null };

  const client = {
    auth: {
      async getUser() {
        calls.getUser++;
        await tick(opts.userDelay ?? 0);
        if (session.userError) return { data: { user: null }, error: session.userError };
        if (!session.user)
          return { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } };
        return { data: { user: { id: session.user } }, error: null };
      },
      onAuthStateChange(cb: Listener) {
        calls.listen++;
        listeners.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    from(table: string) {
      if (table !== "wishlists") throw new Error(`unexpected table ${table}`);
      return {
        async select() {
          calls.select++;
          await tick();
          // RLS: the caller's own rows only.
          const mine = db.filter((r) => r.user_id === session.user);
          return { data: mine.map((r) => ({ product_id: r.product_id })), error: null };
        },
        async insert(row: Row) {
          calls.insert++;
          await tick();
          if (row.user_id !== session.user) return { error: { message: "new row violates row-level security" } };
          db.push(row);
          return { error: null };
        },
        delete() {
          calls.delete++;
          const where: Record<string, string> = {};
          const chain = {
            eq(col: string, val: string) {
              where[col] = val;
              return chain;
            },
            then(resolve: (v: { error: null }) => void) {
              for (let i = db.length - 1; i >= 0; i--) {
                const r = db[i];
                if (r.user_id === session.user && r.user_id === where.user_id && r.product_id === where.product_id)
                  db.splice(i, 1);
              }
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  };

  return {
    client,
    calls,
    session,
    /** What Supabase does on signInWithPassword / signOut in this tab. */
    emit(event: string, user: string | null) {
      session.user = user;
      for (const l of listeners) l(event, user ? { user: { id: user } } : null);
    },
  };
}

/** A page load: a fresh store, its client arriving lazily like supabaseLazy's. */
function page(sb: ReturnType<typeof fakeSupabase>, loaderDelay = 5) {
  let loaderCalls = 0;
  const store = createWishlistStore(async () => {
    loaderCalls++;
    await tick(loaderDelay);
    return sb.client as never;
  });
  return { store, loaderCalls: () => loaderCalls };
}

/**
 * Wait for a background reload (one the auth listener started) to finish. A
 * fixed sleep raced it under a loaded machine; this waits for the state itself,
 * with a ceiling so a store that never settles still fails rather than hangs.
 */
async function settled(store: ReturnType<typeof createWishlistStore>, ms = 2000) {
  const end = Date.now() + ms;
  while (store.getState().auth === "unknown" && Date.now() < end) await tick(5);
  await tick(5);
}

const has = (db: Row[], user: string, product: string) =>
  db.some((r) => r.user_id === user && r.product_id === product);

async function main() {
  console.log("\n=== 1. signed in, session read: the heart toggles ===");
  {
    const db: Row[] = [];
    const sb = fakeSupabase(db, { user: ALICE });
    const { store } = page(sb);
    await store.getState().load();
    t("the store knows who is signed in", store.getState().auth === "signedIn" && store.getState().userId === ALICE);
    const added = await store.getState().toggle(SAREE);
    t("first tap saves", added === "added" && store.getState().ids.has(SAREE) && has(db, ALICE, SAREE), added);
    const removed = await store.getState().toggle(SAREE);
    t("second tap removes", removed === "removed" && !store.getState().ids.has(SAREE) && !has(db, ALICE, SAREE), removed);
  }

  console.log("\n=== 2. signed in, session still loading: no login redirect ===");
  {
    const db: Row[] = [];
    const sb = fakeSupabase(db, { user: ALICE, userDelay: 40 });
    const { store } = page(sb, 20);
    // Mounting hearts start the load; the customer taps before it resolves.
    void store.getState().load();
    t("the answer is UNKNOWN while loading, not signed out", store.getState().auth === "unknown");
    const result = await store.getState().toggle(SAREE);
    t("the tap waits for the session and saves", result === "added" && has(db, ALICE, SAREE), result);
    t("…without a second session read", sb.calls.getUser === 1, `getUser ×${sb.calls.getUser}`);
  }
  {
    // A tap before ANY heart has started loading takes the same path.
    const db: Row[] = [];
    const sb = fakeSupabase(db, { user: ALICE, userDelay: 30 });
    const { store } = page(sb, 30);
    const result = await store.getState().toggle(RING);
    t("a tap that is the very first thing on the page still saves", result === "added" && has(db, ALICE, RING), result);
  }

  console.log("\n=== 2b. THE DEFECT: signed out on the shop, then signed in ===");
  {
    const db: Row[] = [];
    const sb = fakeSupabase(db, { user: null });
    const { store } = page(sb);
    await store.getState().load();
    t("browsing signed out reads signed out", store.getState().auth === "signedOut");
    // LoginForm: signInWithPassword in this tab, then router.push — no reload.
    sb.emit("SIGNED_IN", ALICE);
    t("sign-in drops the cached answer at once", store.getState().auth !== "signedOut");
    const result = await store.getState().toggle(SAREE);
    t("the next tap saves instead of sending them to log in", result === "added" && has(db, ALICE, SAREE), result);
    t("the store now belongs to the customer who signed in", store.getState().userId === ALICE);
  }
  {
    const db: Row[] = [];
    const sb = fakeSupabase(db, { user: null });
    const { store } = page(sb);
    await store.getState().load();
    sb.emit("SIGNED_IN", ALICE);
    await settled(store);
    t("sign-in reloads on its own, before any tap", store.getState().auth === "signedIn" && store.getState().userId === ALICE);
  }

  console.log("\n=== 2c. a failed session read is not \"signed out\" ===");
  {
    const db: Row[] = [];
    const sb = fakeSupabase(db, { user: ALICE, userError: { name: "AuthRetryableFetchError", status: 0 } });
    const { store } = page(sb);
    await store.getState().load();
    t("offline: the answer stays unknown", store.getState().auth === "unknown");
    const result = await store.getState().toggle(SAREE);
    t("a tap reports an error, never a login redirect", result === "error", result);
    sb.session.userError = null; // back online
    const retry = await store.getState().toggle(SAREE);
    t("the next tap asks again and saves", retry === "added" && has(db, ALICE, SAREE), retry);
  }
  {
    const sb = fakeSupabase([], { user: ALICE, userError: { name: "AuthApiError", status: 503 } });
    const { store } = page(sb);
    t("a 5xx from auth is no redirect either", (await store.getState().toggle(SAREE)) === "error");
  }

  console.log("\n=== 3. signed out: the login flow ===");
  {
    const db: Row[] = [];
    const sb = fakeSupabase(db, { user: null });
    const { store } = page(sb);
    const result = await store.getState().toggle(SAREE);
    t("a signed-out tap asks them to sign in", result === "signin", result);
    t("…and writes nothing", db.length === 0 && sb.calls.insert === 0);
    t("…and fills no heart", !store.getState().ids.has(SAREE));
  }

  console.log("\n=== 4. the lazily-loaded client ===");
  {
    const sb = fakeSupabase([{ user_id: ALICE, product_id: RING }], { user: ALICE });
    const { store, loaderCalls } = page(sb, 50);
    const loading = store.getState().load();
    t("nothing is decided before the client arrives", store.getState().auth === "unknown");
    await loading;
    t("once it arrives the session is read and the hearts filled", store.getState().auth === "signedIn" && store.getState().ids.has(RING));
    t("the client is fetched once for the load", loaderCalls() === 1, `loader ×${loaderCalls()}`);
  }
  {
    const lazy = fs.readFileSync("lib/supabaseLazy.ts", "utf8");
    const browser = fs.readFileSync("lib/supabase.ts", "utf8");
    t("the lazy loader hands back the memoised session client",
      lazy.includes('import("./supabase").then((m) => m.getBrowserSupabase())') &&
        /if \(!browserClient\) \{\s*browserClient = createBrowserClient/.test(browser));
    const store = fs.readFileSync("lib/wishlistStore.ts", "utf8");
    t("the store imports no Supabase runtime up front", !/from "\.\/supabase"/.test(store) && !/from "@supabase\/supabase-js"(?!.*type)/.test(store.replace(/import type[^\n]*\n/g, "")));
  }

  console.log("\n=== 5. hydration keeps the customer's saved state ===");
  {
    const db: Row[] = [
      { user_id: ALICE, product_id: SAREE },
      { user_id: ALICE, product_id: RING },
      { user_id: BOB, product_id: "33333333-3333-4333-8333-333333333333" },
    ];
    const sb = fakeSupabase(db, { user: ALICE });
    const { store } = page(sb);
    await store.getState().load();
    const ids = [...store.getState().ids].sort();
    t("every saved product is a filled heart", ids.join() === [RING, SAREE].sort().join());
    t("…and nobody else's", ids.length === 2);
  }

  console.log("\n=== 6. a refresh keeps the wishlist ===");
  {
    const db: Row[] = [];
    const first = page(fakeSupabase(db, { user: ALICE }));
    await first.store.getState().toggle(SAREE);
    const second = page(fakeSupabase(db, { user: ALICE })); // the reload
    await second.store.getState().load();
    t("the saved heart is still filled after a reload", second.store.getState().ids.has(SAREE));
    await second.store.getState().toggle(SAREE);
    const third = page(fakeSupabase(db, { user: ALICE }));
    await third.store.getState().load();
    t("and a removal survives a reload too", !third.store.getState().ids.has(SAREE) && db.length === 0);
  }

  console.log("\n=== 7. one session read per page, however many hearts ===");
  {
    const sb = fakeSupabase([], { user: ALICE, userDelay: 10 });
    const { store, loaderCalls } = page(sb);
    await Promise.all(Array.from({ length: 33 }, () => store.getState().load()));
    t("33 hearts mount: ONE getUser", sb.calls.getUser === 1, `×${sb.calls.getUser}`);
    t("33 hearts mount: ONE wishlist query", sb.calls.select === 1, `×${sb.calls.select}`);
    t("33 hearts mount: ONE auth listener", sb.calls.listen === 1, `×${sb.calls.listen}`);
    t("33 hearts mount: the client is fetched once", loaderCalls() === 1, `×${loaderCalls()}`);
    await store.getState().load();
    t("a later mount reads nothing again", sb.calls.getUser === 1 && sb.calls.select === 1);
    sb.emit("TOKEN_REFRESHED", ALICE);
    await tick(20);
    t("a token refresh for the same customer reloads nothing", sb.calls.getUser === 1 && store.getState().auth === "signedIn");
  }

  console.log("\n=== 7b. sign-out and account switches ===");
  {
    const db: Row[] = [{ user_id: ALICE, product_id: SAREE }];
    const sb = fakeSupabase(db, { user: ALICE });
    const { store } = page(sb);
    await store.getState().load();
    sb.emit("SIGNED_OUT", null);
    t("signing out empties the hearts at once", store.getState().ids.size === 0);
    await settled(store);
    t("…and the store reads signed out", store.getState().auth === "signedOut");
    sb.emit("SIGNED_IN", BOB);
    await settled(store);
    t("the next customer does not inherit the last one's hearts", store.getState().userId === BOB && !store.getState().ids.has(SAREE));
  }
  {
    // A load for Alice still in flight when she signs out must not land.
    const db: Row[] = [{ user_id: ALICE, product_id: SAREE }];
    const sb = fakeSupabase(db, { user: ALICE, userDelay: 30 });
    const { store } = page(sb);
    const stale = store.getState().load();
    await tick(10);
    sb.emit("SIGNED_OUT", null);
    await stale;
    await settled(store);
    t("a load overtaken by a sign-out is discarded", store.getState().auth === "signedOut" && store.getState().ids.size === 0);
  }
  {
    // The session ended elsewhere: the write fails, the heart reverts, and only
    // now is "sign in" the right answer.
    const db: Row[] = [];
    const sb = fakeSupabase(db, { user: ALICE });
    const { store } = page(sb);
    await store.getState().load();
    sb.session.user = null; // expired, no event in this tab
    const result = await store.getState().toggle(SAREE);
    t("a write refused because the session ended asks them to sign in", result === "signin", result);
    t("…and the heart does not stay filled", !store.getState().ids.has(SAREE));
  }

  const button = fs.readFileSync("components/shop/WishlistButton.tsx", "utf8");
  const card = fs.readFileSync("components/shop/ProductCard.tsx", "utf8");

  console.log("\n=== 8. the heart's two states ===");
  t("saved is a filled red heart", button.includes('saved && "fill-red-600 text-red-600"'));
  t("unsaved is an ink outline on a frosted disc, legible on any photograph",
    button.includes("bg-white/85 text-ink") && button.includes("backdrop-blur-sm"));
  t("the white-glyph overlay that vanished on pale cloth is gone",
    !button.includes("bg-transparent text-white shadow-none"));
  t("hover previews the saved colour", button.includes("hover:text-red-600"));

  console.log("\n=== 9. what a screen reader hears ===");
  t("state is exposed with aria-pressed", button.includes("aria-pressed={saved}"));
  t("the label names the product and the action",
    button.includes("`Save ${productName} to your wishlist`") &&
      button.includes("`Remove ${productName} from your wishlist`"));
  t("only a definite \"signin\" navigates to the login page",
    /if \(result === "signin"\) \{\s*router\.push\(`\/in\/login\?from=/.test(button) &&
      (button.match(/router\.push/g) ?? []).length === 1);

  console.log("\n=== 10. the card stays keyboard-operable ===");
  t("the heart is a native <button>", /<button\s+onClick=\{handleClick\}/.test(button));
  t("it is never taken out of the tab order", !/tabIndex=\{?-1/.test(button));
  t("its 44px target survives", button.includes("tap-44"));
  t("a tap on it does not also follow the card's link",
    button.includes("e.preventDefault();") && button.includes("e.stopPropagation();"));
  t("the card still renders one heart per product", (card.match(/<WishlistButton/g) ?? []).length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

void main();
