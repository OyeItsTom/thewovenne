import { RECOVERY_WINDOW_SECONDS, recoverySessionOpen } from "./signInMethods";
import {
  VERIFY_FAILURE_COPY,
  initialRecoveryPhase,
  parseRecoveryUrl,
  proofFromRecoverySession,
  recoveryFormOpen,
  sessionMatchesProof,
  urlWithoutAuthParams,
  verifyRecoveryLink,
  type RecoveryAuth,
  type RecoveryPhase,
  type RecoveryProof,
  type RecoveryUrl,
} from "./passwordRecovery";

/**
 * What /in/reset-password does over time (WP-OPS-01C4): reading the link,
 * Continue, the form, saving, and ending the session a link created when the
 * reset is abandoned. ResetPasswordForm only renders the view this produces.
 *
 * It lives outside React so the ORDER of things — Supabase's own auth events
 * arriving mid-check, a sign-out during a save, another tab switching account,
 * the 15 minutes running out — can be driven and tested with stand-ins
 * (scripts/password-recovery.test.ts).
 *
 * Rules it keeps:
 *   - Nothing is verified except by continueWithLink, which only Continue calls.
 *   - The form opens only from a successful verification (or an old link's
 *     recovery session), for that user and session; auth events can close it,
 *     never open it.
 *   - Abandoning the reset — 15 minutes passing, leaving the page, or the
 *     session check failing on save — ends the session the link created, on
 *     this browser only, and only if this browser still holds that session. A
 *     different account, or a sign-in made since, is never signed out.
 *
 * What it cannot do: run when the tab is closed, the browser is killed or the
 * page is reloaded. A session created by Continue then stays signed in, as an
 * ordinary session would. See the WP-OPS-01C4 report.
 */

type MaybeSession = { access_token: string } | null;

/** The part of the Supabase auth client the page uses. */
export interface RecoveryFlowAuth extends RecoveryAuth {
  getSession(): Promise<{ data: { session: MaybeSession } }>;
  onAuthStateChange(callback: (event: string, session: MaybeSession) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
}

export interface RecoveryFlowDeps {
  auth: RecoveryFlowAuth;
  savePassword(password: string): Promise<{ ok: boolean; error: string | null }>;
  /** Ends THIS browser's session only (scope "local"), never every device. */
  signOutLocal(): Promise<void>;
  location: { href(): string; replace(path: string): void };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface RecoveryView {
  phase: RecoveryPhase;
  signedIn: boolean;
  /** Beside Continue, after a check that may succeed if tried again. */
  notice: string | null;
  saving: boolean;
  /** Supabase refused the new password (too short, the same as before…). */
  saveError: string | null;
}

export const INITIAL_RECOVERY_VIEW: RecoveryView = {
  phase: "checking",
  signedIn: false,
  notice: null,
  saving: false,
  saveError: null,
};

export interface RecoveryFlow {
  /** Call on mount; returns the unmount cleanup. Safe to repeat (Strict Mode). */
  mount(): () => void;
  continueWithLink(): Promise<void>;
  save(password: string): Promise<void>;
  view(): RecoveryView;
}

export function createRecoveryFlow(deps: RecoveryFlowDeps, onChange: (view: RecoveryView) => void): RecoveryFlow {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let view = INITIAL_RECOVERY_VIEW;
  // In memory only: never rendered, stored or sent anywhere but verifyOtp.
  let url: RecoveryUrl | null = null;
  let token: string | null = null;
  let proof: RecoveryProof | null = null;
  let verifying = false;
  let mounted = false;
  let expiry: unknown = null;

  const set = (patch: Partial<RecoveryView>) => {
    view = { ...view, ...patch };
    onChange(view);
  };

  const clean = () => {
    const next = urlWithoutAuthParams(deps.location.href());
    if (next !== null) deps.location.replace(next);
  };

  const stopExpiry = () => {
    if (expiry !== null) clearTimer(expiry);
    expiry = null;
  };

  /** Sign out here only if this browser still holds the session `p` was made for. */
  async function endSession(p: RecoveryProof) {
    try {
      const { data } = await deps.auth.getSession();
      if (sessionMatchesProof(data.session?.access_token, p)) await deps.signOutLocal();
    } catch {
      // Best effort: the session is then an ordinary one, as after any sign-in.
    }
  }

  /** The reset is over without a save: close the form, end the link's session. */
  async function close() {
    const p = proof;
    proof = null;
    token = null;
    stopExpiry();
    set({ phase: "closed", saving: false });
    if (p) await endSession(p);
  }

  function openForm(p: RecoveryProof) {
    proof = p;
    set({ phase: "form", notice: null });
    stopExpiry();
    const left = p.verifiedAtMs + RECOVERY_WINDOW_SECONDS * 1000 - now();
    expiry = setTimer(() => {
      expiry = null;
      // A save already under way finishes; it re-checks the window itself.
      if (view.phase === "form" && !view.saving) void close();
    }, Math.max(0, left));
  }

  function onAuthEvent(_event: string, session: MaybeSession) {
    // While saving, the outcome is the save's to decide (its own sign-out
    // fires SIGNED_OUT); a failed save re-checks the session afterwards.
    if (view.saving || view.phase === "saved") return;
    set({ signedIn: !!session });
    if (view.phase === "form" && !recoveryFormOpen(session?.access_token, proof, now())) void close();
  }

  function mount() {
    mounted = true;
    // Parsed once: Strict Mode mounts twice, and the second mount would see
    // the address already cleaned.
    if (!url) {
      url = parseRecoveryUrl(deps.location.href());
      if (url.link.kind === "token") token = url.link.tokenHash;
    }
    const link = url;
    // A token or an error in the fragment goes now. An old link's `?code=`
    // waits until the client has finished with it (getSession below).
    if (!link.legacyCode) clean();
    if (link.link.kind === "token" && view.phase === "checking") set({ phase: "confirm" });

    const { data: sub } = deps.auth.onAuthStateChange(onAuthEvent);
    let live = true;

    // getSession waits for the client's start-up, including an old link's code
    // exchange, so there is no timer guessing at it.
    deps.auth.getSession().then(({ data }) => {
      if (!live) return;
      clean();
      if (view.saving || view.phase === "saved") return;
      set({ signedIn: !!data.session });
      if (view.phase !== "checking") return;
      const accessToken = data.session?.access_token;
      const phase = initialRecoveryPhase(link, recoverySessionOpen(accessToken, now()));
      const legacy = phase === "form" ? proofFromRecoverySession(accessToken) : null;
      if (legacy) openForm(legacy);
      else set({ phase: phase === "form" ? "noLink" : phase });
    });

    return () => {
      live = false;
      mounted = false;
      sub.subscription.unsubscribe();
      stopExpiry();
      // Leaving the page with the form open abandons the reset. A save under
      // way finishes and signs out on its own.
      const p = proof;
      if (p && !view.saving) {
        proof = null;
        void endSession(p);
      }
    };
  }

  async function continueWithLink() {
    const tokenHash = token;
    // One request at a time: a double tap must not spend the token twice and
    // report the second answer ("already used") over the first.
    if (!tokenHash || verifying || view.phase !== "confirm") return;
    verifying = true;
    set({ phase: "verifying", notice: null });
    const result = await verifyRecoveryLink(deps.auth, tokenHash, now);
    verifying = false;

    if (!result.ok) {
      if (result.failure === "invalid" || result.createdAccessToken) {
        token = null;
        set({ phase: "invalid" });
      } else {
        // The token may well be unspent (the request never arrived), so
        // Continue stays. If it was spent, the retry says so.
        set({ phase: "confirm", notice: VERIFY_FAILURE_COPY[result.failure] });
      }
      if (result.createdAccessToken) {
        const created = result.createdAccessToken;
        try {
          const { data } = await deps.auth.getSession();
          if (data.session?.access_token === created) await deps.signOutLocal();
        } catch {
          // As endSession.
        }
      }
      return;
    }

    token = null;
    const p = result.proof;
    // Left the page while the check ran: nobody is here to use the form.
    if (!mounted) return void (await endSession(p));
    const { data } = await deps.auth.getSession();
    if (!mounted) return void (await endSession(p));
    if (recoveryFormOpen(data.session?.access_token, p, now())) openForm(p);
    else {
      // Another tab changed the account mid-check. Close; endSession leaves
      // that other session alone.
      set({ phase: "closed" });
      await endSession(p);
    }
  }

  async function save(password: string) {
    if (view.phase !== "form" || view.saving) return;
    set({ saving: true, saveError: null });

    // Again, right before saving: updateUser changes whichever account the
    // browser now holds, so it must still be the one the link proved.
    const before = await deps.auth.getSession();
    if (!recoveryFormOpen(before.data.session?.access_token, proof, now())) return void (await close());

    const result = await deps.savePassword(password);
    if (!result.ok) {
      set({ saving: false, saveError: result.error });
      const p = proof;
      if (!mounted) {
        proof = null;
        if (p) await endSession(p);
        return;
      }
      const after = await deps.auth.getSession();
      if (!recoveryFormOpen(after.data.session?.access_token, proof, now())) await close();
      return;
    }

    // ONE USE: end this session too (Supabase has ended the others), then say
    // so. The page shows "saved" whatever the sign-out reports: the password
    // is saved either way.
    proof = null;
    token = null;
    stopExpiry();
    try {
      await deps.signOutLocal();
    } catch {
      // Still saved; see above.
    }
    set({ phase: "saved", saving: false, saveError: null });
  }

  return { mount, continueWithLink, save, view: () => view };
}
