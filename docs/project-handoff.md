# The Wovenne — project handoff

Last updated: 31 October 2026. This is a starting point for a fresh working
context, not a transcript. Git history, `supabase/migrations/`, `scripts/*.test.ts`
and the code are the source of truth. `wovenne_project_status_log.md` is the
older, longer history and is not current beyond early October.

## Current production state (main + deploy verified 31 Oct 2026; ledger and posture last checked 21 Oct)

| | |
|---|---|
| `main` | `7908d86` (PR #217 merge: shared email layout, WP-EMAIL-E1; no email converted yet). Before it: `ca6aa16` (#216, handoff docs), `5860f22` (#215, email emblem asset), `7e2e798` (#213, cross-device password recovery code) |
| Production deployment | GitHub deployment `7463489341` (vercel[bot], Production, ref `7908d86`), Git-triggered from `main`; succeeded 31 Oct |
| Migration ledger | 73 rows, latest `0073_style_photo_storage_security.sql` (`public.schema_migrations`) |
| Security posture | `scripts/security-posture.ts --production` → MATCHES `supabase/security-posture.json` |
| Background processes | None |

- **Stack:** Next.js 14.2.5 (App Router), React 18, TypeScript 5, Tailwind 3. Supabase: Postgres 17, Auth, Storage and PostgREST, through `@supabase/ssr` and `supabase-js` 2. Hosted on Vercel; `sharp` runs server-side.
- **No staging.** Production is the working database. Every production migration, merge and config change needs explicit owner approval, one narrow step at a time.
- **Migrations** are applied with `node scripts/run-migration.mjs <file>`. It runs in one transaction and records the ledger row.
- **Razorpay is still on Test keys.** Live activation is deferred to final go-live.

## Recent production work, all live and verified

- **Google Sign-In** (#202), with same-email linking. Guest checkout is unchanged.
- **Password changes use the emailed link only** (#203). The reset form opens only for a `recovery` session in a 15-minute window, and signs the user out after saving. Reset codes are single-use.
- **Password minimum is 12 characters** (#206), in both Supabase and the app, with no required uppercase, number or symbol.
  - Helper text: "Use at least 12 characters. Spaces are allowed, so a short phrase works well."
  - Supabase "Secure password change" and "Require current password" are **off**. Turning on the latter first needs `/admin/account` to send `current_password`.
- **Admin protection:** MFA/AAL2, live-session validation, and revoked-session protection at the database (#191, #192).
- **First-party analytics:** collection, daily aggregation and dashboard (1A, 1B, 1C; migrations 0068–0070).
- **Image derivatives and egress reduction** (#200): w1080 derivatives, so the optimizer no longer pulls 3 MB masters. Supabase egress is being watched against the 5 GB quota.
- **Delete Account wording** corrected (#204).
- **Style-photo storage security** (#207 and 0073), below.
- **Cross-device password recovery** (#213, WP-OPS-01C), below. Branded r4 reset email active, with the emblem from #215; core device tests passed (owner-reported).

## Password recovery across devices — WP-OPS-01C (live; core device tests passed, owner-reported 31 Oct)

- **Problem:** the reset link only worked in the browser that asked for it (`@supabase/ssr` forces PKCE; the verifier cookie lives in that browser). Other devices, in-app browsers and link prefetchers saw "That link has expired".
- **Fix (Option B), PR #213:** commits `4a812bb` + `ab071cd`, merged as `7e2e798` on 27 Oct 2026 19:32 UTC. The reset page also accepts `#token_hash=…&type=recovery` behind a **Continue** button (client `verifyOtp`). Old `?code=` PKCE links still work. Secrets in the URL are redacted from Sentry. Lookup or save failures fail closed.
- **Verified:** Production deploy `7368470676` succeeded; `/in/reset-password` returns 200 (noindex) on `www`, apex 308s to `www`, and the live page chunk contains the 01C7 strings.
- **Automated tests (run by us, stand-in auth client, before merge):** `scripts/password-recovery.test.ts` 200/0, `password-policy` 40/0, `customer-google-auth` 127/0; `tsc` exit 0. These do not touch real Supabase or real email.

### Email template r4 (WP-OPS-01C9E–G)

- **Template:** the owner reports the branded **r4** Reset Password template is **activated** in Supabase → Templates → Reset Password (31 Oct). Subject `Reset your password for THE WOVENNE`. We did not read the live dashboard; the approved source is `reports/email-auth/wp-email-design-2026-10-29/proposed-reset-password.html` (SHA-256 `f5dc547f…`, gitignored, LaCie r4 backup).
- **Recovery link** (the only placeholder, `{{ .TokenHash }}` once; no `{{ .ConfirmationURL }}`): `https://www.thewovenne.com/in/reset-password#token_hash={{ .TokenHash }}&amp;type=recovery`. The token sits in the `#` fragment, so browsers do not send it to Vercel or our request logs; the page sends it only to Supabase `verifyOtp` after **Continue**. Link expiry stays 1 h; the form window stays 15 min.
- **Emblem:** `https://www.thewovenne.com/email/wovenne-emblem-v1.png` from `public/email/`, added by PR #215 (merge `5860f222be6b09f6b2f47ddcc83c49675901c495`, Production deployment `7459862239`). Verified live 31 Oct: 200, `image/png`, 11,964 bytes, SHA-256 `28abe141a55b720ab37386374452d8149d112113c5398d9afdfef7489014f6c3`, byte-identical to the repo file. Never change or delete it in place: sent emails keep loading it. A new logo goes in as `-v2`.
- **Unchanged:** SMTP (Supabase → Resend), DNS, Resend click tracking (owner confirmed off before activation).

### Owner live tests — owner-reported, not independently executed

The owner ran these on production with their own account and reported the results on 31 Oct 2026. We did not observe them, and no automated test covers real email or real devices.

| Test | Result |
|---|---|
| Same-browser reset (request and open in one browser) | PASS |
| Mac request → open on iPhone | PASS |
| Sign in on iPhone with the newly changed password | PASS |
| iPhone request → open on Mac | PASS |

### Still to test (owner, owner-controlled account, one fresh email each)

- **Reused link:** open an already-used link again. Expected: invalid-link screen, no form.
- **Expired link:** a link older than 1 hour, or one with a damaged hash. Expected: invalid, no form.
- **Superseded link:** request two resets, open the older one. Expected: invalid (a new request replaces the old token). Wait out the resend limit first: a rate-limited request sends nothing and leaves the older link valid.
- **Gmail app in-app browser** (iPhone): request → open from Gmail → Continue → save → sign in.
- **Already signed in** on that browser, as the same account and as a different account: Continue warns that it signs this browser out; the other account is not shown.
- **Old password fails** after a reset; the new one works on both devices.
- **No regressions:** Google sign-in, signup email code, ordinary email + password login, Settings "Change password" email, admin login with MFA.
- **Rendering:** Gmail, Apple Mail and one Outlook client, plus dark mode and images off.
- **Logs:** Sentry events show `token_hash` only as `[redacted]`; the Resend log shows the link not rewritten.

Full checklist: `reports/email-auth/wp-ops-01c9a-2026-10-27/REPORT.md` §5 (tests 5–13).

### Rollback

1. Restore the original template first: paste `original-template/ORIGINAL-reset-password-subject.txt` and `ORIGINAL-reset-password-body.html` (in `reports/email-auth/wp-email-design-2026-10-29/`, checksums in `SHA256SUMS`) into Supabase → Templates → Reset Password. New emails go back to the old `{{ .ConfirmationURL }}` link at once.
2. Keep the PR #213 code live for at least 1 hour after the last new-format email was sent; never revert it while such links can still be opened. A code revert is a separate decision.
3. Keep `public/email/wovenne-emblem-v1.png` deployed; already-sent emails reference it.
4. Record the time of the restore and of the last new-format email.

Reports: `reports/email-auth/wp-ops-01c*-2026-10-27/` and `wp-email-design-2026-10-29/` (gitignored) with LaCie backups.

## Customer emails — WP-EMAIL (E1 merged 31 Oct 2026)

- **Audit (31 Oct, read-only):** `reports/email-auth/wp-email-brand-audit-2026-10-31/REPORT.md` (gitignored). Inventory of every customer email, findings, work packages E1–E10, owner decisions D1–D9.
- **E1 merged:** PR #217 (`ae447bb` + `f8e8ec6`, merge `7908d86`), Production deployment `7463489341`. Adds `lib/emails/layout.ts` (shared r4-style shell: emblem, wordmark, 560px tables, Ink button, transactional / security / marketing footers), `scripts/email-layout.test.ts` (150 passed) and `scripts/email-layout-preview.ts` (writes samples outside the repo only). **Nothing imports it yet: every email still sends exactly as before.**
- **Rules for adopters:** plain strings are always escaped; trusted markup only via the module's `html` tag. `safeHref` accepts only `https://www.thewovenne.com` / `https://thewovenne.com`, paths on it, or one `mailto:` at `@thewovenne.com`. Pass **paths**, not `NEXT_PUBLIC_SITE_URL` URLs (localhost is refused), so emails sent from dev link to production. Courier tracking links are refused until an allowlist is approved.
- **Footer wording:** transactional "Need help? Our contact details are on our website." (no claim that replies are read: monitoring of `hello@` / `orders@` is unverified); marketing "Essential emails about your orders are separate from marketing preferences."
- **Known gaps (from the audit):** no shipping email exists, yet the order confirmation and checkout both promise one; invoice emails (manual + resend) are unbranded and do not escape the customer name; current confirmation and cancellation copy says replies "reach us directly".
- **Sender identity (owner-verified 31 Oct):** Supabase → Authentication → SMTP Settings shows custom SMTP on, sender email `orders@thewovenne.com`, sender name `The Wovenne`. A real Gmail reset email showed From `The Wovenne <orders@thewovenne.com>`, mailed by `send.thewovenne.com`, signed by `thewovenne.com`, and still a green "O" avatar. So the display name is set and the audit's sender-name theory is wrong; renaming it to `THE WOVENNE` is not a fix.
- **Inbox avatar ("O"/"T"):** a separate sender-image branding issue, not a display-name setting. Needs its own assessment: BIMI, DMARC enforcement, the certificate Gmail requires (VMC or CMC), and whether a Google account exists for `orders@` whose name or photo Gmail shows. None of this is configured or verified; BIMI's requirements are not met today (no `default._bimi` record and DMARC `p=none`, per the WP-OPS-01A DNS check of 23 Oct; not re-checked since).
- **Next:** E9 is reframed as a read-only sender-avatar assessment (BIMI / DMARC / certificate / Google account for `orders@`), owner-gated, no DNS or dashboard change without approval. E2 order confirmation waits on owner decisions D1 (shipping promise), D2 (invoice number / order link), D6 (greeting and closing). E3 shipping email needs a migration and a server route. Real mail-client testing is due with E2.

## Style-photo security — final state

The original problem: anyone signed in could upload any file to a public, listable bucket. That is **closed on production.**

- **Buckets:**
  - `style-photos` is **private**. Originals live at `<owner>/<product>/<uuid>.jpg`. Admins read them through 10-minute signed URLs.
  - `style-gallery` is **public** and holds approved copies only, at `<submission>/<uuid>.jpg`. Files are fetched by exact URL; nobody can list the bucket.
  - Both buckets accept `image/jpeg` only, up to 4 MiB.
- **Uploads are server-mediated.** `POST /api/style/submit` runs these steps in order:
  1. same-origin check, then the user from the session;
  2. `style_photo_upload_allowed`: a paid and delivered order for that product, and at most 5 files per product;
  3. size check;
  4. JPEG signature check;
  5. sharp decodes with a pixel ceiling, re-encodes, and strips EXIF/GPS;
  6. stored privately with the service key;
  7. the row is saved with the **customer's** session, so RLS and trigger `style_submission_media_guard` apply.
- The browser cannot write to either bucket.
- **Approval** (`/api/admin/style/moderate` → `approve_style`) publishes a separate **1200 px re-encoded JPEG** with `Cache-Control: max-age=60`.
- **Never public:** pending, rejected and withdrawn photos.
- **No optimizer caching.** Gallery photos render `unoptimized`. In `next.config.mjs`, the Supabase `remotePatterns` entry is limited to `/storage/v1/object/public/product-images/**`. Live, `/_next/image` returns 400 for style buckets and 200 for products.
- **Cleanup happens at each event:** failed save, resubmission, withdrawal, take-off, rejection, admin delete and account deletion.
  - The public copy is removed *before* the database change, except for account deletion, which goes database-first.
  - The backstop is `style_photo_garbage()`, swept when an admin opens the style queue. There is no Vercel cron; Storage files cannot be removed from SQL, so pg_cron (used for analytics, 0070) cannot do it.
- **Revocation window:** about 2 minutes realistic worst case. That is the 60 s cache plus the Supabase CDN dropping deleted files in 33–75 s (measured 26 Sep). It is not guaranteed and not instant.
- **Production has 0 style submissions and 0 style files.**

**STYLE PHOTO E2E LIFECYCLE TEST: DEFERRED — NO SAFE PAID + DELIVERED ORDER FIXTURE.**
On 21 Oct no production order was paid *and* delivered, so no customer is eligible. Run the test, including live measurement of the 60 s cache and CDN removal, once a genuine delivered order or a deliberately created safe test fixture exists. Do not fake or edit a real order to run it.

## WP-00 — Vercel Git auto-deploy: VERIFIED (21 Oct 2026)

The 21 Oct delays were GitHub's incident [`nms1dpzmh9d9`](https://www.githubstatus.com/incidents/nms1dpzmh9d9) ("Delays for Pull Requests and Webhook deliveries"), not Vercel configuration. Read-only checks found the Vercel settings correct (repo `OyeItsTom/thewovenne`, Production branch `main`, Ignored Build Step "Automatic", no deploy hooks).

**Verification merge:** PR #210 merged at 19:49:46 UTC as `3e83d930330b0af7fdaba5a72155363a3ca81ecf`.
- Vercel set the commit status to pending at 19:49:49 UTC, about 3 s after the merge.
- Production deployment `7235810837` (GitHub deployment record by `vercel[bot]`, environment Production, ref = the merge SHA) succeeded at 19:52:57 UTC.
- It was Git-triggered for `main` at the merge SHA, not a redeploy or manual rebuild, and the live domain served the new build.
- The branch head `e7403ad` had also got a Git-triggered preview (`7234330232`).

During the incident, merge `0569e30` (#207) never deployed; production was rebuilt manually from the identical tree `bbb5b4c` (`7230021215`), so nothing was lost. Keep checking which commit production runs after each code merge.

## Standing rule — Supabase Data API grants (platform change, 30 Oct 2026)

From 30 October, new tables and sequences in `public` get **no** automatic Data API grants. That applies to `anon`, `authenticated` and **`service_role`**. The full rules are in `supabase/README.md` ("Rules for new migrations" and "Supabase's 30 October 2026 Data API change").

- **One explicit decision per object.** Every new table, view and sequence makes a grant/revoke decision for each of `anon`, `authenticated` and `service_role`. That includes a sequence created by an identity or serial column. The simplest form is `revoke all … from anon, authenticated, service_role`, then grant only what a real caller does.
- **Never blanket `grant all`** to `anon` or `authenticated`.
- **`service_role` only when needed.** It gets grants only where trusted server code (`createServiceClient()`) uses the table. "No Data API access" is a valid decision.
- **`GRANT` decides reach; RLS decides rows.** A grant decides whether a role can reach a table through the API at all; RLS separately decides which rows. Both are needed. Direct database connections (`scripts/`) are not the Data API and never justify an API grant.
- **Migrations alone.** A fresh environment, preview branch or `db reset` must reproduce the intended grants from migrations alone. The posture replay checks this.
- **0004 is not proof.** Its default privileges still give `service_role` every new table *in rebuilds*, so a plain replay passes a migration that will fail in production. `scripts/privilege-baseline.test.ts` section 9 models Supabase's change after `0073` and fails such a migration.
- **Existing objects keep their grants.** Thirteen legacy objects get `service_role` access only from 0004's defaults. They are listed in the README, and the test pins that list.

**Audit status (WP-01A, 21 Oct 2026): PASS WITH FINDINGS.**
- Existing tables, RLS and `anon`/`authenticated` grants are compatible.
- The gap was future `service_role` access, masked by 0004.

**WP-01B (21 Oct 2026): rules and tests done.** Local results:
- `privilege-baseline.test.ts` passes, with section 9 and the text-rule cases.
- `security-posture.ts --replay` → MATCHES.
- Mutation checks confirmed that both guards fail when they should.

**WP-01A–E: COMPLETE (21 Oct 2026), all before Supabase's 30 Oct rollout.** A = audit, B = rules and 114 passing regression tests, C = production baseline (below), D = baseline recorded here and in the README, E = controlled merge of PR #210 (`3e83d93`) and production verification (see WP-00). No migration was added; the ledger stays at 73 rows, latest `0073`.

**WP-01C (21 Oct 2026, about 18:47 UTC): production pre-rollout baseline verified.** Read-only: a `READ ONLY` transaction, catalog queries only, rolled back. No production database changes were made. Production runs PostgreSQL 17.6, and the ledger has 73 rows, latest `0073`.
- `security-posture.ts --production` → MATCHES: 40 tables/views, 105 functions, 75 RLS policies, 4 sequences.
- Default privileges of `postgres` in `public`, from `pg_default_acl`:
  - Tables: `service_role` gets SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN. This is the legacy automatic grant, still present. `anon`/`authenticated` get no SELECT, INSERT, UPDATE or DELETE. They keep legacy non-CRUD TRUNCATE, REFERENCES, TRIGGER and MAINTAIN.
  - Sequences: `service_role` gets SELECT, UPDATE and USAGE. `anon`/`authenticated` get nothing.
- The 13 legacy objects keep their intended `service_role` privileges.
- **What MATCHES does not cover:** the posture tool compares existing objects only. It does not compare default ACLs, and it does not compare TRUNCATE, REFERENCES or TRIGGER held by `anon`/`authenticated` (54 such grants across 27 tables, reported only). The default ACL above was read separately.
- **At this measurement, the legacy defaults were still in place; the rollout's actual effect on this project is unverified.** Expected after 30 Oct: `service_role` loses SELECT, INSERT, UPDATE and DELETE on new tables, and USAGE and SELECT on new sequences, while `anon`/`authenticated` are unchanged. Supabase may treat this project's non-standard defaults differently.

**Still open — read-only post-rollout check, after 30 Oct (not yet done):**
- the `pg_default_acl` query for `postgres` in `public`, confirming the rollout has actually reached the project;
- `scripts/security-posture.ts --production` → MATCHES;
- the 13 legacy objects still have their `service_role` access;
- record any rollout-specific deviation from the expected change above.

**Deferred decisions:**
- R3: recording default ACLs in the posture tool.
- R4: a no-op `0074` granting the 13 legacy objects explicitly.
- Removing the legacy non-CRUD table privileges held by `anon`/`authenticated`.

## Search & AI Discovery — one programme

**Foundation done:**
- crawlable storefront;
- sitemaps;
- canonicals;
- Product and Breadcrumb structured data;
- image and performance optimisation;
- technical metadata.

**Not done (do not claim):**
- final catalogue rebuild;
- Screaming Frog crawl;
- final Search Console work;
- GA4, Google Ads and Consent Mode;
- Merchant Center;
- full AI-discovery optimisation.

**Future scope:**
- Google Search and Search Console;
- Bing Webmaster Tools and IndexNow;
- Merchant Center and free listings;
- verifying access for OAI-SearchBot, Claude-SearchBot and Claude-User;
- training crawlers: a separate owner decision;
- ChatGPT merchant and product-feed opportunity;
- Google AI, Gemini, Bing and Claude discovery;
- genuine content, authority, reviews and backlinks.

This is one programme. Do not create separate GEO, AEO or LLMO projects.

## Roadmap

**Completed.** Reports are gitignored under `reports/`, with private backups.

- **WP-00, WP-01A–E:** Vercel auto-deploy verified; Data API grant audit and rules merged (`3e83d93`).
- **WP-02A (21 Oct):** read-only catalogue audit of all 34 products. The owner questions it raised are still open.
- **Owner strategy (23 Oct):** India first. Move gradually towards linen and other natural fabrics, while selling or clearing suitable existing saree stock.
- **WP-SEO-01A (23 Oct):** initial technical SEO and AI-readiness audit.
- **WP-SEO-02A–C (23 Oct):** product JSON-LD and og:image use the w1080 derivative. Merged as PR #212 (`0d56fdc`).
- **WP-SEO-02D (24 Oct):** investigated 404 pages. Next 14.2.5 renders a page-level `notFound()` as an empty HTML shell; the 404 status and noindex are correct. This is a framework limit, deferred to a future Next.js 15 upgrade.
- **WP-OPS-01A (23 Oct):** email authentication audit. **WP-OPS-01B (24 Oct):** owner testing; Supabase sends through Resend SMTP. It found the cross-device reset failure.
- **WP-OPS-01C (27–31 Oct):** code merged as PR #213 (`7e2e798`); emblem PR #215 (`5860f22`); r4 template activated and core device tests passed, owner-reported 31 Oct (see Password recovery across devices).
- **WP-EMAIL audit + E1 (31 Oct):** shared email layout merged as PR #217 (`7908d86`), not yet used by any email (see Customer emails).

**Pending, independent of the catalogue:**

- After 30 Oct: the read-only Supabase Data API permissions check (see Standing rule).
- WP-OPS-01C remaining live tests (reused, expired and superseded links, Gmail in-app browser, signed-in states, regressions), owner-run; see "Still to test".
- WP-OPS-01A DNS findings (root SPF, DMARC reporting), owner-gated.
- WP-EMAIL E2–E10 (see Customer emails): owner decisions D1–D9 first.

**Catalogue and SEO, in this order:**

1. Owner decides KEEP / IMPROVE / REBUILD / RETIRE for each product. **Not complete.** The strategy above does not decide any single product.
2. Product editing and description improvements: **deferred by the owner.** Do not start without approval.
3. Rebuild and fix the final catalogue.
4. Preserve URLs, with redirects where needed. Follows the product decisions.
5. Final Screaming Frog crawl and technical QA. Follows the catalogue decisions.
6. Final technical and on-page SEO. Follows the catalogue decisions.
7. Google Search Console.
8. Bing Webmaster Tools and IndexNow.
9. GA4, Consent Mode and Google Ads.
10. Google Merchant Center and free product listings. Blocked while Razorpay is on Test keys.
11. Search & AI Discovery audit.
12. Content, reviews, authority, PR and backlinks.
13. Ongoing measurement of rankings, AI visibility and conversion.

## Do not reopen without new evidence

Completed phases (the Completed list and the production sections above) are not re-audited for their own sake. Reopen one only for:
- a regression;
- a platform change that affects it;
- new evidence of a real gap.

## Reconstructing a fresh context

1. This file.
2. `git status`, `git log --oneline -20`, and the commits relevant to the task.
3. The migrations relevant to the task.
4. Targeted source and tests.
   - There is no `npm test`: run `npx --cache <dir> --yes tsx@4.19.2 scripts/<name>.test.ts`.
   - Database suites need `PG_HARNESS_DIR`, with embedded-postgres 17.6.
5. Broader repository reading only if still needed.
