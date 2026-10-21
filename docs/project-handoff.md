# The Wovenne — project handoff

Last updated: 21 October 2026. This is a starting point for a fresh working
context, not a transcript. Git history, `supabase/migrations/`, `scripts/*.test.ts`
and the code are the source of truth. `wovenne_project_status_log.md` is the
older, longer history and is not current beyond early October.

## Current production state (verified 21 Oct 2026)

| | |
|---|---|
| `main` | `fed2bc9` (PR #209, docs only). App code is unchanged since `0569e30` (PR #207) |
| Production deployment | Vercel `7230948592`, built from `fed2bc9` at 16:10 UTC (GitHub deployment record). Same app code as `0569e30` |
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

## OPERATIONAL ISSUE (WP-00) — Vercel Git auto-deploy: MITIGATED, not yet verified

**Probable cause: GitHub's incident [`nms1dpzmh9d9`](https://www.githubstatus.com/incidents/nms1dpzmh9d9), "Delays for Pull Requests and Webhook deliveries".** It was posted at 14:52 UTC on 21 Oct 2026 and was still open at 18:18 UTC. It is not a Vercel configuration fault.

Read-only checks on 21 Oct found the Vercel settings correct:
- the connected repository is `OyeItsTom/thewovenne`;
- the Production branch is `main`;
- the Ignored Build Step is "Automatic", and "skip unchanged" is off;
- there are no deploy hooks.

Git events reached Vercel late or not at all. Before 21 Oct they arrived about 4 s after a push.

| Git event (UTC) | Vercel deployment |
|---|---|
| push `bbb5b4c`, 14:27 | preview, started 14:39 (~13 min late) |
| merge `0569e30` (#207), 14:39 | **none, ever** |
| manual "Production rebuild" of the `bbb5b4c` preview, 15:26 | production `7230021215` |
| push `f2f36db`, 15:37 | preview, started 15:48 (~11 min late) |
| merge `b4a3f45` (#208), 15:40 | **production, automatic**, started 15:50 |
| push `f1434f6`, 15:52 | preview, started 15:58 |
| merge `fed2bc9` (#209), 15:52 | production `7230948592`, started 16:07 (~15 min late) |
| push `e7403ad` (PR #210), 18:39 | preview `7234330232`, Git-triggered for branch + SHA, started 18:42 (~3 min) |

**Git-triggered Preview: confirmed** (`e7403ad`). By about 18:50 UTC GitHub reported webhooks operational, though the incident stayed open for an audit-log backlog. **Automatic Production deployment on merge: not yet verified.** No merge has happened since `fed2bc9`.

The earlier version of this section said `b4a3f45` and `f2f36db` never deployed. That was written during the delay, and both did deploy.

`bbb5b4c` and `0569e30` have the identical tree, so the missing `0569e30` build lost nothing.

**Still to verify:** the next docs-only merge (PR #210 is the natural one). Pass if:
- Vercel creates a preview for the branch head SHA and a production deployment for the merge SHA, each within about a minute;
- the deployments list shows *branch + SHA*, not "Redeploy" or "Production rebuild";
- production's Source shows `main` at the merge SHA.

Until then, after every code merge, check which commit production actually runs. Never assume a merge has deployed.

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

**WP-01C (21 Oct 2026, about 18:47 UTC): production pre-rollout baseline verified.** Read-only: a `READ ONLY` transaction, catalog queries only, rolled back. No production database changes were made. Production runs PostgreSQL 17.6, and the ledger has 73 rows, latest `0073`.
- `security-posture.ts --production` → MATCHES: 40 tables/views, 105 functions, 75 RLS policies, 4 sequences.
- Default privileges of `postgres` in `public`, from `pg_default_acl`:
  - Tables: `service_role` gets SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN. This is the legacy automatic grant, still present. `anon`/`authenticated` get no SELECT, INSERT, UPDATE or DELETE. They keep legacy non-CRUD TRUNCATE, REFERENCES, TRIGGER and MAINTAIN.
  - Sequences: `service_role` gets SELECT, UPDATE and USAGE. `anon`/`authenticated` get nothing.
- The 13 legacy objects keep their intended `service_role` privileges.
- **What MATCHES does not cover:** the posture tool compares existing objects only. It does not compare default ACLs, and it does not compare TRUNCATE, REFERENCES or TRIGGER held by `anon`/`authenticated` (54 such grants across 27 tables, reported only). The default ACL above was read separately.
- **At this measurement, the legacy defaults were still in place; the rollout's actual effect on this project is unverified.** Expected after 30 Oct: `service_role` loses SELECT, INSERT, UPDATE and DELETE on new tables, and USAGE and SELECT on new sequences, while `anon`/`authenticated` are unchanged. Supabase may treat this project's non-standard defaults differently.

**Still open:**
- PR #210 (WP-01B and this record) is pending merge.
- After 30 Oct, repeat both read-only checks: the `pg_default_acl` query for `postgres` in `public` and `security-posture.ts --production` → MATCHES. They must also confirm that the rollout has actually reached the project.

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

## Roadmap — in this order

1. Supabase Data API grant compatibility and security audit. Audit and rules/tests are done (WP-01A/B).
   - WP-01A audit, WP-01B rules and regression tests, and WP-01C production pre-rollout baseline are done. PR #210 is pending merge.
   - **Next:** after 30 Oct, repeat the read-only default-ACL and posture checks (see Standing rule).
   - **In parallel:** the final WP-00 check, automatic Production deployment on merge.
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
