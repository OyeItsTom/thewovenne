# Image derivatives and Supabase egress

## Why this exists

In October 2026 the project's Supabase **cached egress** ran over the free quota: 5.36 / 5 GB in the cycle from 14 Sep to 14 Oct.

The cause was found in Supabase's edge logs and Vercel's usage figures:

- **Optimizers download whole files.** Every product photograph reaches visitors through an image optimizer: Vercel's in production, and Next's own in local `next start` / `next dev`. On a cache miss the optimizer downloads the *whole* source object from Supabase. That happens once per photograph, per width, per region, per server.
- **The masters are far larger than anything shown.** Masters are 2400 px on the short edge at JPEG q92, about 3.2 MB each. Nothing on the site is wider than 1920 px.
- **Local work was the biggest share.** Local development and testing was over half of the egress. Fresh `.next` caches and worktrees re-fetched every master, and so did Lighthouse and screenshot sweeps.

## What a derivative is

A derivative is a smaller copy of a master, made once and stored under a **new name**. Nothing is ever overwritten: Supabase's CDN keeps serving an overwritten object's old bytes, as found in SEO-6B.

| Tier | Width | Used for | Measured size (real master, 3.22 MB) |
|---|---|---|---|
| `w1080` | 1080 px | product cards, gallery thumbnails | 534 KB (−83%) |
| `w1920` | 1920 px | PDP gallery frame, zoom viewer, JSON-LD, og:image | 1,725 KB (−46%) |

- **Recipe:** JPEG q88, 4:4:4, progressive, tagged sRGB, rotation baked in. A photograph with real transparency gets lossy WebP with alpha instead.
- **How the recipe was chosen:** measurements are in `lib/imageDerivatives.ts`. Every candidate differs from the master by less than the optimizer's own WebP q75 loss.
- **The master is unchanged.** It is the archival copy and the fallback. The cart, orders, emails, chat and Admin keep naming it.

### Names

```
products/<stem>.<ext>  →  derived/<folder>-<stem>-w1080-r<recipe>.jpg
                          derived/<folder>-<stem>-w1920-r<recipe>.jpg
```

- Names are deterministic, so retries land on the same name, and uploads are `upsert: false`.
- `derived/` sits outside `products/`, which is the only prefix the orphan and cleanup tooling may consider.
- `lib/imageReferences` also classifies `derived/` as `DERIVED_DELIVERY_COPY`, which is never deletable.

## How the storefront chooses

1. **The registry.** `public.image_derivatives` (migration 0071) holds one row per master, tier and recipe: `ready` (with file facts) or `not_needed`. It is public-read. Admins may insert; nobody may update or delete through the API.
2. **The data layer.** `lib/products.ts` (`finish`, `finishListing`) calls `attachImageVariants` once per product fetch. Each product gets `imageVariants`, holding only its own photographs that have a `ready` copy for the current recipe.
   - A product with none gets **no new key**, so the payload is unchanged.
   - If the read fails (for example 0071 is not applied yet), every image is served from its master and the warning is logged once.
3. **One selection function.** `imageFor(master, "card" | "detail", variants)` in `lib/imageVariants.ts`:
   - `card` prefers `w1080`, then `w1920`, then the master.
   - `detail` prefers `w1920`, then the master. It never uses `w1080`, so zoom is never downgraded.
4. **One component.** `components/ui/DeliveryImage.tsx` wraps `next/image`, applies `imageFor`, and if the copy fails to load, **falls back to the master once**. Every other prop (`sizes`, `priority`, `loading`, `fill`, `onLoad`) passes through unchanged.
   - Product cards, gallery frames, gallery thumbnails and both zoom layers use it.
5. **SEO.** JSON-LD and og:image name `/_next/image?url=<the file the page shows>`. `lib/seo` accepts the exact `derived/` name shape.

## How copies are made

**New uploads.** `app/api/admin/images/normalize` makes both tiers from the master bytes already in memory, after the master is proven readable and before the staged original is removed. It uses the admin's own session, never the service role.

- Each tier is uploaded, then proven by a one-byte ranged GET against its MD5, then registered `ON CONFLICT DO NOTHING`.
- An existing object counts as success only when it is proven to be the same bytes.
- Failures never affect the master or the upload. They are logged and returned as `derivatives: { status, registered, tiers }`, and the product editor shows a note.

**Existing photographs.** Use `scripts/image-derivatives-backfill.ts`:

```sh
# plan (default; read-only SQL, no downloads)
npx tsx --env-file=.env.local scripts/image-derivatives-backfill.ts
# one batch (default 10, max 50)
npx tsx --env-file=.env.local scripts/image-derivatives-backfill.ts --execute --limit 10
# one photograph
npx tsx --env-file=.env.local scripts/image-derivatives-backfill.ts --execute --only products/<key>
```

- **Planning reads facts only.** It reads product rows, `storage.objects` and the registry over a read-only transaction.
- **Each source is downloaded once,** through the service role's authenticated object route, then processed exactly like an upload.
- **It is resumable.** Registered sources are skipped without a download.
- **Every outcome is logged** to `reports/image-derivatives/ledger.ndjson`, which is git-ignored.
- `--objects-only` makes and verifies objects without registering them, for use before 0071 exists.

### Rollout order

1. Apply 0071 with `scripts/run-migration.mjs`. Then `security-posture.ts --production` should report MATCHES.
2. Merge and deploy. Nothing visible changes yet, because the registry is empty.
3. Run the backfill in batches. Each registered photograph switches over on its page's next ISR render.

## Local development rule

The local optimizer bills Supabase exactly like Vercel's does.

- **Never clear `.next/cache/images`** (no `rm -rf .next`) unless a task truly needs a cold cache.
- **Share the cache across worktrees:** `scripts/share-image-cache.sh <worktree>`.
- **Don't run sweeps against an empty cache.** Repeated Lighthouse or screenshot runs on a cold cache re-download every master. Warm the cache once, then measure.
- **Automated tests never download catalogue photographs.** Synthesize images with sharp, as `scripts/image-derivatives.test.ts` does. Keep testing the same properties; only the technique changes.
- **Production checks stay minimal:** one request per question, never a crawl.
