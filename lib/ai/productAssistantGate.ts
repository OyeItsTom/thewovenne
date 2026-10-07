/**
 * Who may ask the AI Product Assistant: a signed-in admin on a two-factor
 * session. Nobody else learns the endpoint exists.
 *
 * The route reads three things, in this order, each from the server's own view
 * of the session — never from anything the browser sent — and this decides:
 *
 *   1. getUser()         revalidates the session with Supabase; no user → 404
 *   2. is_admin()        staff AND aal2 since 0062; anything but true → 404
 *   3. the assurance level, read directly — redundant with 0062 today, and
 *      kept so that a future change to is_admin cannot quietly drop the MFA
 *      requirement from a route that spends money → 403
 *
 * 404 rather than 403 for the first two, as on every other admin route: a
 * customer who guesses the path learns nothing about what lives there.
 *
 * Pure. The route does the reading (so scripts/mfa-enforcement.test.ts can see
 * its is_admin call); the decision is here, where it can be tested.
 */

export interface GateFacts {
  userId: string | null;
  isAdmin: unknown;
  isAdminError: unknown;
  aal: { currentLevel: string | null; nextLevel: string | null } | null;
}

export type GateResult =
  | { ok: true; userId: string }
  | { ok: false; status: 404 | 403; message: string };

const NOT_FOUND: GateResult = { ok: false, status: 404, message: "Not found" };

export function decideGate(f: GateFacts): GateResult {
  if (!f.userId) return NOT_FOUND;
  if (f.isAdminError || f.isAdmin !== true) return NOT_FOUND;
  if (!(f.aal?.currentLevel === "aal2" && f.aal.nextLevel === "aal2")) {
    return {
      ok: false,
      status: 403,
      message: "Finish two-factor verification before using AI suggestions.",
    };
  }
  return { ok: true, userId: f.userId };
}
