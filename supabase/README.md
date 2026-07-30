# Database

Ordered migrations. Run them **in number order** in the Supabase SQL editor
(Project → SQL Editor → New query): open a file, Select All, paste, Run.

| File | What it does |
|---|---|
| `0001_core_tables.sql` | categories, products, orders, site_content, journal_posts |
| `0002_admin_identity.sql` | `profiles` + `is_admin()` — everything below depends on it |
| `0003_row_level_security.sql` | Public read policies, admin-only writes |
| `0004_grants.sql` | Base privileges for `anon`, `authenticated`, `service_role` |
| `0005_storage.sql` | `product-images` bucket + policies |
| `0006_product_images.sql` | Multi-photo galleries |
| `0007_seed.sql` | Categories, placeholder products, homepage copy, journal posts — **do not re-run on production**, see below |
| `0008_promote_admin.sql` | **Manual.** Makes you an admin — edit the email first |

Every file is idempotent: `create … if not exists`, `drop policy if exists`
before each policy, `on conflict do nothing` on every seed. Re-running any of
them on a populated database is safe. Skip `0007` if you don't want the
placeholder catalogue.

## Why these are split

They replace a single 418-line `schema.sql`. That file stopped being runnable —
a failure anywhere aborted every statement after it, and because the Supabase
SQL editor reports only the first error, it was impossible to tell how far it
had got. The production database ended up built from hand-pasted fragments, so
the file no longer described it.

Smaller files fail visibly and can be re-run individually. The split was
verified statement-by-statement against the retired `schema.sql`: 113
statements in, 113 out, none lost, duplicated or invented.

## Gotchas

**`0002` does not create a trigger on `auth.users`.** Doing so needs ownership
of that table, which the SQL-editor role may not have, and the failure aborts
everything after it. `handle_new_user()` exists but is deliberately unwired —
see the comment in the file for how to attach it if your role permits, or
handle profile creation in application code when customer signup ships.

**`0008` is not optional.** Nothing else promotes anyone. Skip it and `/admin`
lets you sign in, then shows an empty dashboard, because every admin policy
returns false and `lib/auth.ts` fails closed.

**`0007` is no longer safe on production.** Its ten placeholder products were
deleted on 2026-07-30 once real products existed. `on conflict do nothing` only
protects rows that still exist — those slugs are free again, so re-running the
file would resurrect all ten with `placehold.co` covers that Next's optimizer
rejects, putting ten broken products back on the live shop. The categories and
`site_content` blocks in that file are still safe to re-run.

**`service_role` grants in `0004` matter more than they look.** Supabase's
defaults were not in place on this project, so every `service_role` query
failed with `42501` — which silently broke order recording, since the Razorpay
route writes the order with that key after verifying the payment signature.
