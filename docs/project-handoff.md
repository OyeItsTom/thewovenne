# The Wovenne — project handoff

Last updated: 21 October 2026. This is a starting point for a fresh working
context, not a transcript. Git history, `supabase/migrations/`, `scripts/*.test.ts`
and the code are the source of truth. `wovenne_project_status_log.md` is the
older, longer history and is not current beyond early October.

## Current production state (verified 21 Oct 2026)

| | |
|---|---|
| `main` | `0569e30` (merge of PR #207) |
| Production deployment | Vercel `7230021215`, built from `bbb5b4c`, same tree as `0569e30` |
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

## OPEN OPERATIONAL ISSUE — Vercel Git auto-deploy

As of 21 Oct 2026, Vercel stopped reacting to Git pushes and merges after about 14:42 UTC:

- The #207 merge `0569e30` did **not** trigger a production deployment.
- The #208 docs merge `b4a3f45` did **not** trigger a deployment.
- The docs branch push `f2f36db` did not get a preview deployment either.
- The last automatic deployment was the `bbb5b4c` preview at 14:42 UTC.

The #207 code reached production only through a manual promotion or redeploy, as deployment `7230021215`. Production runs `bbb5b4c`, which has the same code as `main`'s #207 contents. `main` adds only documentation after that.

**Before the next code merge:**
1. Check Vercel → Project → Settings → Git.
2. Confirm the connected GitHub repository is correct.
3. Confirm the Production Branch is `main`.
4. Check whether an Ignored Build Step or another deployment rule is blocking builds.
5. Confirm the GitHub–Vercel integration and its webhooks are still connected.
6. Don't assume a merge has deployed just because GitHub says it merged.
7. After every code merge, check which commit production is actually running, until auto-deploy is proven fixed.

## Standing rule — Supabase Data API grants (platform change, 30 Oct 2026)

From 30 October, new tables in `public` must not rely on automatic Data API grants.

- Every `CREATE TABLE` migration makes an explicit, least-privilege `GRANT` decision. Never blanket `grant all` to `anon` or `authenticated`.
- `GRANT` decides whether a role can reach a table through the API at all; RLS separately decides which rows. Both are needed.
- A fresh environment, preview branch or `db reset` must reproduce the intended grants from migrations alone. The posture replay checks this.
- Existing tables are not changed by the platform change.

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

## Roadmap — in this order

1. Supabase Data API grant compatibility and security audit.
2. Catalogue triage: inspect every current product, read-only.
3. Owner decides KEEP / IMPROVE / REBUILD / RETIRE for each product.
4. Rebuild and fix the final catalogue.
5. Preserve URLs, with redirects where needed.
6. Screaming Frog crawl and technical QA.
7. Final technical and on-page SEO.
8. Google Search Console.
9. Bing Webmaster Tools and IndexNow.
10. GA4, Consent Mode and Google Ads.
11. Google Merchant Center and free product listings.
12. Search & AI Discovery audit.
13. Content, reviews, authority, PR and backlinks.
14. Ongoing measurement of rankings, AI visibility and conversion.

## Do not reopen without new evidence

Completed, production-verified phases (all of the above) are not re-audited for their own sake. Reopen one only for:
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
