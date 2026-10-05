# Staging

Preview deployments and local test runs use a separate Supabase project,
**wovenne-staging**. Production keeps its own. The app and the scripts check
which project they have been given, and refuse when it is the wrong one.

```
PREVIEW (Vercel) ─┐
LOCAL STAGING ────┴─▶ wovenne-staging  (Supabase: DB, Auth, Storage)
                      Razorpay TEST · no email · own Anthropic key or none

PRODUCTION ─────────▶ production project wxumlixnmwgeqswknhpw
                      live integrations
```

Staging is a **separate project**, not Supabase Branching. Its database, auth
users, storage buckets, admins and customers have nothing in common with
production. Production data is never copied into it: not customers, profiles,
orders, addresses, wishlists, loyalty, reviews, marketing records or secrets.
Its catalogue is synthetic (see *Catalogue* below).

## The guards

### 1. A non-production deployment cannot use production (`lib/envSafety.mjs`)

`next.config.mjs` checks the environment before anything is compiled, and
`instrumentation.ts` checks it again when the server starts. The build fails
with `WOVENNE ENVIRONMENT SAFETY — refusing to start` when:

| Target | Refused if |
|---|---|
| `VERCEL_ENV=preview` or `development`, or a local `WOVENNE_ENV=staging` | any of `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_DB_URL` names the production project |
| same | those variables name **different** projects (for example a staging URL with a production service key) |
| same | `RAZORPAY_KEY_ID` or `NEXT_PUBLIC_RAZORPAY_KEY_ID` is a live key (`rzp_live_…`) |
| `VERCEL_ENV=production` | never: production needs no flag and gains no new failure |
| nothing declared (plain `npm run dev`) | never: same as before |

The production ref (`wxumlixnmwgeqswknhpw`) is written into the code on
purpose. The thing being guarded against is wrong configuration, so the answer
cannot come from configuration. The ref is not a secret, because it is the
subdomain every visitor's browser already loads.

The public Supabase URL and anon key are inlined into the browser bundle at
build time. That makes the build check the one that actually decides what a
deployment talks to.

### 2. Writing scripts refuse production by default (`scripts/lib/scriptEnv.mjs`)

Every script that changes a database or a bucket reads **one** env file and
checks it before it opens a connection:

| Situation | Result |
|---|---|
| env names production, no `--production` | **exit 2**, nothing connected |
| env names production, `--production` passed | runs, printing `target: PRODUCTION (…)` |
| env names another project, `--production` passed | **exit 2**: the flag and the env disagree |
| env variables name different projects | **exit 2** |
| `scripts/staging.mjs` with production | **exit 2**: there is no override |
| `scripts/staging.mjs` without `WOVENNE_ENV=staging` | **exit 2** |

Which file: `--env-file=<path>`, else `$WOVENNE_ENV_FILE`, else `.env.local`.
`scripts/staging.mjs` defaults to `.env.staging`.

**This changes the production workflow in one way.** `.env.local` names
production, so production migrations now need the flag:

```
node scripts/run-migration.mjs supabase/migrations/0063_x.sql --env-file=.env.staging   # first
node scripts/run-migration.mjs supabase/migrations/0063_x.sql --production               # then, deliberately
```

The same applies to `add-admin`, `reset-admin-mfa`, `restore-cost-prices`,
`seed-policy-pages`, `seo-5e-drafts`, every `*.verify.mjs`,
`style-security.test.mjs`, and the storage executors (`backfill-execute`,
`backfill-delete-execute`, `c6-normalize-execute`, `c7-reclaim-execute`,
`orphan-delete-execute`). The `*.verify.mjs` proofs roll back, but they still
write inside their transaction, so they now belong on staging.

`scripts/env-safety.test.ts` fails if a new script reads `.env.local` by hand
instead of going through the guard.

## Commands

```
node scripts/staging.mjs status                   # ledger, row counts, staff, auth users
node scripts/staging.mjs bootstrap                # apply every pending migration, in order
node scripts/add-admin.mjs --env-file=.env.staging --email you@example.com
node scripts/staging.mjs seed                     # replace the catalogue with the baseline
node scripts/staging.mjs reset --yes              # back to baseline (see below)
node scripts/staging.mjs user --email t1@example.test         # confirmed customer, no email sent
node scripts/staging.mjs delete-user --email t1@example.test
```

To run the app locally against staging, use a separate worktree whose
`.env.local` **is** the staging file:

```
git worktree add ../thewovenne-staging main
cp .env.staging ../thewovenne-staging/.env.local
cd ../thewovenne-staging && npm ci && npm run dev
```

Do not export `.env.staging` into a shell and run from this folder. Next fills
anything the shell lacks from `.env.local`, which would quietly bring in
production's Resend and Anthropic keys. With `WOVENNE_ENV=staging` in the file,
the dev server refuses to start if a production Supabase or live Razorpay value
has slipped in.

### Bootstrap

`bootstrap` replays `supabase/migrations/0001` up to the latest, **unmodified**,
each in its own transaction. It refuses:

- a database that has tables but no `schema_migrations` ledger (that is not a
  fresh project);
- a pending migration numbered below the newest applied one (merged out of
  order, so a person should decide);
- and it stops at the first failing file, rolled back, with the file named.

It never patches anything to make it fit. If a migration fails on the real
staging project, that is a mismatch between the migrations and production, and
it gets reported rather than worked around.

`0007_seed.sql` runs as part of the replay. Its ten placeholder products are
removed by `seed`, which mirrors what production did on 30 July 2026.
`0008_promote_admin.sql` updates nobody, and `add-admin.mjs` is the real
mechanism.

### Catalogue

`seed` deletes every product and creates five synthetic ones through the admin's
own RPCs (`create_product_draft`, `publish_one`, `save_product_sizes`,
`ensure_product_draft`), acting as the staging admin with an aal2 session.
Validation, RLS, audit and publish rules therefore all apply:

| Slug | What it is for |
|---|---|
| `staging-cotton-saree` | live, in stock (5), 2 images |
| `staging-sold-out-saree` | live, stock 0 |
| `staging-sized-kurti` | live, sizes S:3 M:0 L:2 (category Kurtis made visible) |
| `staging-pending-change-saree` | live, with an unpublished name change waiting |
| `staging-draft-only-saree` | never published, so it must not appear on the shop |

The images are generated cards reading "STAGING", uploaded to the staging
`product-images` bucket under `products/`. Nothing is read from production.

### Reset

`reset --yes`:

1. applies any pending migrations;
2. truncates every table listed as **disposable** in
   `scripts/lib/staging.mjs` (orders, carts, wishlists, reviews, loyalty,
   coupons, credit notes, expenses, marketing, AI spend, stock history, the
   audit log, style submissions, products and their versions, images and
   sizes);
3. deletes every auth user that is not staff, through the Auth API, so their
   profiles cascade;
4. empties the `product-images` and `style-photos` buckets;
5. re-seeds the catalogue.

It keeps staff logins, the migration ledger, categories, site content, pages
and journal posts. Reset **refuses** if the database has a table that is in
neither list. A future migration that adds customer data has to say which side
it is on.

Reset does not restore categories, pages, site content or journal posts that a
test has edited. When those need to go back too, delete the staging project,
create it again, and bootstrap: it takes about ten minutes.

## Vercel environment variables

Vercel → thewovenne → Settings → Environment Variables. Each variable is set
**per environment**: tick only the boxes shown.

| Variable | Production | Preview | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | production URL | **staging URL** | the guard fails Preview builds until this changes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | production | **staging** | |
| `SUPABASE_SERVICE_ROLE_KEY` | production | **staging** | Preview needs it for admin and checkout routes |
| `SUPABASE_DB_URL` | not needed by the app | not needed | scripts only, kept in local env files |
| `NEXT_PUBLIC_SITE_URL` | `https://www.thewovenne.com` | leave as is | `customerOrigin()` already ignores `*.vercel.app` |
| `RAZORPAY_KEY_ID` / `NEXT_PUBLIC_RAZORPAY_KEY_ID` | as today | **`rzp_test_…`** | live keys fail the Preview build |
| `RAZORPAY_KEY_SECRET` | as today | test secret | |
| `RAZORPAY_WEBHOOK_SECRET` | as today | a **different** secret | only if a test-mode webhook is pointed at a preview |
| `RESEND_API_KEY` | as today | **unset** | no key means no email is sent |
| `EMAIL_FROM`, `EMAIL_REPLY_TO` | as today | unset | |
| `ANTHROPIC_API_KEY` | as today | unset, or a separate low-cap key | unset turns the concierge off |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | as today | same DSN is fine | events are tagged `vercel-preview` automatically |
| `WHATSAPP_*` | as today | unset | |

`VERCEL_ENV` is set by Vercel. Do not create it.

## First-time setup

These steps are for Tom. They create a free Supabase project and change
Preview settings on Vercel, and nothing here touches production.

1. **Supabase → New project.** Organisation: the Wovenne one. Name:
   `wovenne-staging`. Generate a database password and keep it in your
   password manager. Region: the same as production. Plan: Free.
2. When it is ready, open **Project Settings → API** and copy the Project URL,
   the `anon` key and the `service_role` key.
3. **Connect** (top bar) **→ Session pooler**: copy the connection string and
   put the database password in it.
4. Locally: `cp .env.staging.example .env.staging`, then fill in those four
   values. Leave Resend and Anthropic unset. Add Razorpay **test** keys if you
   want checkout to work.
5. **Authentication → URL Configuration.** Site URL: `http://localhost:3000`.
   Redirect URLs: `http://localhost:3000/**` and
   `https://*-thewovenne-s-projects.vercel.app/**`.
6. Run:
   ```
   node scripts/staging.mjs bootstrap
   node scripts/add-admin.mjs --env-file=.env.staging --email <your email>
   node scripts/staging.mjs seed
   node scripts/staging.mjs status
   ```
7. **Vercel → Settings → Environment Variables.** Edit the three Supabase
   variables so that **Preview** has the staging values and **Production** keeps
   its own. Vercel lets you split an existing variable: edit it, untick Preview,
   save, then add a new one with the same name for Preview only. Remove Preview
   from `RESEND_API_KEY`, `ANTHROPIC_API_KEY` and any live Razorpay keys.
8. Redeploy the newest Preview. The build log should no longer show the safety
   error, and the bundle should name the staging ref.

Until step 7 is done, **every Preview build fails** with the safety error. That
is the guard working: before this change, those previews were quietly writing
to production.
