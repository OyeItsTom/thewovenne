# THE WOVENNE — project status log

Last updated: 9 August 2026 (seventh session)

> **Read the seventh-session section at the bottom first.** The shop took its
> first ever order today, through the in-person screen, and three of the bugs
> fixed in that section all fired on it. It has since been repaired — credit note
> `CN-2026-0008` — and the story is under "The first real order, and what
> happened to it", because it is the clearest description of what those bugs
> actually did.

---

## Session summary

Everything below is built, merged to `main`. Migrations `0024`–`0041` are
applied to Supabase and verified; `0042` is written and awaiting a run.

**One thing is not verified end to end: a real payment.** See "The gap" at the
bottom — it is the single largest remaining risk and it cannot be closed from
this side.

---

## Bug fixes

### Admin session falsely denied after refresh — FIXED

The middleware *and* the login page both treated a **failed** `is_admin()` call as
**"not an admin"**. Those are different facts, and collapsing them meant a token
refreshing mid-flight looked identical to a revoked account.

The middleware redirected to `?denied=1`. Worse, the login page called
`signOut()` on the same conflation — **destroying a valid session**, which is why
recovery needed a second login rather than a refresh.

Both now retry once and separate the outcomes: a definite no denies, a failure
says so and leaves the session alone. The login page explains which happened.

Files: `middleware.ts`, `lib/auth.ts`, `app/(admin)/admin/login/page.tsx` · PR #49

### Password reveal on admin login — ADDED

Without it, a password mistyped unseen returns "invalid credentials", which reads
as *wrong account* rather than *wrong keystroke*.

### `handle_new_user` broke all non-form signups — FIXED

`0026` introduced `(metadata ->> 'marketing_consent') = 'true'`. When the key is
absent that expression is **NULL, not false**, and NULL went into a NOT NULL
column, taking the whole `auth.users` insert down with it.

The storefront form always sends the field, so it kept working. What broke was
`scripts/add-admin.mjs`, the Supabase dashboard, and the Admin API — **adding a
fourth partner would have failed** with an opaque `Could not create user: {}`.

Fixed with `coalesce`, which is also the correct default: silence is not consent.
The script now prints the real error. Migration `0030`.

### MFA scripts misreported enrolment — FIXED (earlier this session)

Both admin scripts read `user.factors` from `listUsers()`, which never populates
it. `reset-admin-mfa.mjs --delete` would have reported success while deleting
nothing — **failing in the exact emergency it exists for**. Now uses
`getUserById`. PR #47

---

## Security

### Admin idle timeout — 15 minutes

No pointer, key, scroll or touch input. Warning with a "Stay signed in" button in
the final minute.

Idle means no **input**, not no network traffic, so a background poll cannot hold
a session open on nobody's behalf.

**No MFA conflict.** Ends the local session only; Supabase token lifetimes are
untouched. The next sign-in goes through password *and* authenticator, because
`aal2` belongs to a session and this ends the session. Local scope, so other
devices are unaffected.

File: `components/admin/IdleTimeout.tsx` · PR #49

---

## Marketing consent

**It did not exist before this session.** It was in the original brief, was not
built with customer signup, and the omission was not flagged.

- `profiles.marketing_consent` + `marketing_consent_at`, defaulting to false
- **No backfill.** Under the DPDP Act consent is given, not assumed, so every
  pre-existing account is recorded as never having consented — which is true
- Signup checkbox, **unchecked and never pre-ticked**
- Existing customers opt in at `/account/preferences`
- Consent joins the `0004` column grant, so it is the customer's to give and
  withdraw and sits beside the restriction that stops them setting `is_admin`

Verified against real signups: `"1"`, `"yes"`, `"TRUE"` and `{"a":1}` all record
**false**; only `"true"` counts.

Migrations `0026`, `0030` · PRs #50, #52

---

## Customer segmentation

One row per customer — account or not — segmented from paid orders:

| Segment | Rule |
|---|---|
| VIP | ≥ `vip_min_orders` **or** ≥ `vip_min_spend_inr` (editable; seeded 3 / ₹15,000) |
| Regular | more than one order |
| New | exactly one |
| No orders yet | account, no purchases |

- **Guests are included but never marketable** — no account, never asked
- Eligibility is decided in **one place**, `marketable()` in `lib/customers.ts`
- Orders keyed on lower-cased email, so `Tom@` and `tom@` are one customer
- **Every view is written to the audit log** — which admin, when, how many rows;
  deliberately not the rows themselves

Verified: guest with 3 orders → VIP, not marketable. Guest who spent ₹20,000 →
VIP, not marketable. Mixed-case emails merged. Consented account was the only
`marketable()` result.

Migrations `0027`, `0028` · PR #51

---

## Loyalty points

A **ledger**, not a balance column — points are money, so "how did this customer
end up with 4,000?" has to be answerable. Corrections are new rows.

**Ships disabled.** `loyalty_enabled = false`; the account panel renders nothing
at all rather than a zero balance.

- Earned on **goods, not the total** — awarding on postage pays people to live
  far away
- **Guests earn nothing**; not backdated if they later create an account
- **Redemption recomputed server-side** from the real balance; the browser's
  number is a request, not a fact
- Clamped to the goods total, so points can't pay for delivery or drive the
  charge below zero
- Deduction before award, so nobody spends points earned on the same order

**Two guards:** a unique partial index allows one award per order (a retry can't
pay twice), and a per-customer advisory lock serialises redemptions.

Verified: 5,000 awarded on ₹5,000 goods; a second award call changed nothing;
**two simultaneous 3,000-point redemptions from a 4,000 balance → one succeeded,
one refused, balance never negative**; guest order awarded 0.

Settings (rate, value, minimum) are admin-editable.

Migration `0029` · PR #52

---

## Ask Wovenne visibility toggle

Admin → Settings. **Enforced in `/api/chat`, not just by hiding the widget** —
that endpoint is public, and a hidden button still leaves it answering direct
callers.

Also confirmed working end to end this session: live replies quoting real
catalogue data, and the 10-per-hour message cap recorded its first row.

Migration `0026` · PR #50

---

## Store settings (admin-editable, no deploy)

`site_content.store_settings` — Ask Wovenne on/off, VIP thresholds, loyalty rates.

Written to **both** `value` and `draft_value`, so they apply immediately and never
enter the publish queue. Same reasoning as per-size stock: operational, not
editorial. A switch pressed because something is wrong now isn't a switch if it
needs a second click in another tab.

---

## Marketing email

Three triggers: **wishlist waiting**, **low stock on a saved item**, **cart
abandoned**.

**Consent is enforced in the database, twice, and neither check is the UI filter:**

1. `marketing_targets()` returns consented account-holders only
2. `record_marketing_send()` re-checks immediately before each send — and the
   send only happens if it returns true

The recording **authorises** the send rather than following it. The other order
would mean discovering after an email had gone that it shouldn't have.

- Guests unreachable by construction — the query starts from `profiles`
- **Seven-day cooldown per trigger**; a failed send still leaves its row, so a
  provider having a bad minute can't become a retry loop
- Recipient count loads before sending, plus a second confirmation
- Every email says why it arrived, how to stop it, and that order mail is separate

Verified including the case that matters: **consent withdrawn between building
the list and sending → send refused.**

Migrations `0031`, `0032` · PRs #53, #54

---

## Cart persistence

**Signed-in customers only**, by decision. A guest's cart never leaves their
browser: catching guests would mean recording what signed-out visitors browse,
and a guest can't be emailed anyway — the reach given up couldn't have been acted
on.

- One row per customer; a cart is a current intention, not a history
- **Admins cannot read carts.** Nobody needs to browse what individuals are
  considering
- Restoring only fills an **empty** cart — merging would resurrect items
  deliberately removed elsewhere
- Abandoned = holds something, untouched 24h, **and nothing bought since**

Verified: stale + consent → targeted; no consent → excluded; touched → drops out;
**paid order after the cart → excluded**, so nobody is chased to finish an order
they already completed.

Migration `0032` · PR #54

---

## Admin logout → login flow

Signing out — by timeout or by the button — and logging straight back in was
unreliable: the Sign In button looked dead, and refreshing landed on the 2FA
prompt having never been asked for a password. **Four separate faults**, each
reproduced in a browser against a production build before and after.

### 1. The idle timer never stopped

A passed deadline stays passed, so after firing once the interval re-ran the
entire sign-out — network call, navigation, router refresh — **every second,
indefinitely**. The layout also kept it mounted on the login page.

Measured on `/admin/login?timeout=1`: **three requests per second, forever.**

So whoever typed their password next had their brand-new session signed out from
under them about a second later. **That is what made the button look dead** —
nothing was ever wrong with the button. Measured after: two requests when it
fires, then zero.

### 2. Middleware sent a half-finished session to the dashboard

The rule "signed-in admin on the login page → dashboard" did not distinguish a
verified session from one that had only done the password step. The dashboard
then bounced it to `/admin/mfa` — **the jump straight to 2FA**.

Asking for the login page now means "I want to log in": a session that has not
finished signing in is ended there and the form is shown.

### 3. Navigation after sign-in used the client router cache

`router.push()` served the dashboard **cached from the previous session** with no
server round trip, so middleware never ran and an unverified session appeared to
walk into the dashboard.

**Nothing was actually authorised** — the token was confirmed `aal1`, middleware
and RLS still gate every real request, and a reload went back to the 2FA prompt.
But it looked like the gate had been skipped. Both pages now do a full page load.

`router.refresh()` looks like the fix and is not: it re-requests `/admin/login`,
where fault 2 correctly ends the session that was just created. It was tried, it
broke the login, and that is why the fix is a hard navigation.

### 4. Two GoTrue clients on one storage key

The anonymous client in `lib/supabase.ts` is built in the browser by any client
component importing the module, and shared the real session client's storage key.
Supabase said so itself: *"Multiple GoTrueClient instances detected … may produce
undefined behavior."* It has its own key now.

### Also

The 2FA page could sit on "Preparing…" forever under a "Set up two-factor"
heading with no control on it, if `listFactors` failed. It now reports the
failure with a retry, and does not claim you are enrolling until it knows.

| Flow | Result |
|---|---|
| Password → 2FA → dashboard | correct URL at each hop |
| Sign Out → re-login, **first attempt** | 2FA prompt |
| Idle timeout → re-login, **first attempt** | 2FA → dashboard |
| Login page with a half-finished session | shows the form |
| Idle timer after firing | 0 further requests |
| Duplicate GoTrue warnings | 0 |

Tested with a disposable admin (own password, own TOTP secret), deleted
afterwards; the real admin accounts were untouched. The timeout was exercised
with the constant shortened to 20s — identical code, only the number differs, and
it ships at 15 minutes.

PR #58

---

## Migrations 0034–0036 — applied and verified

Verified by exercising the rules through **real user tokens**, not the service
key — the service key bypasses RLS, which is the thing under test.

| Check | Result |
|---|---|
| `orders.delivery_updates` accepts `whatsapp` | ✅ |
| enum rejects `sms` | ✅ rejected |
| `has_purchased` true for a delivered buyer | ✅ |
| `has_purchased` false for a product they didn't buy | ✅ |
| `has_purchased` false for a non-buyer | ✅ |
| Review from a non-purchaser | ✅ blocked by RLS |
| Review forged under another `user_id` | ✅ blocked |
| Anonymous review | ✅ blocked |
| Verified purchaser can review | ✅ |
| Second review from the same person | ✅ blocked, `23505` |
| Rating outside 1–5 | ✅ blocked |
| `product_reviews_for` leaks no email | ✅ |
| `product_rating` aggregates | ✅ 4.0 from 1 |
| `set_review_hidden` / `admin_reviews` for a non-admin | ✅ refused |
| Admin hides → gone from the page and the average | ✅ |
| Hidden review invisible to its own author | ✅ |
| Hide keeps the row and stamps who did it | ✅ |
| Unhide restores it and clears the stamp | ✅ |
| Admin delete | ✅ really gone |
| Customer can save their default address | ✅ |
| Customer cannot make themselves admin | ✅ blocked at write |

**40 checks, 0 failures.** Three apparent failures in the first pass were the
test calling `set_review_hidden` with the service key: `auth.uid()` is null
there, so `is_admin()` refused it — the function working, not failing. Re-run
through a real admin token, all passed.

Test accounts and their orders were deleted afterwards. Database is back to
**0 orders, 0 reviews**.

---

## The nine-item batch

### Account submenu duplication — FIXED

Orders and Wishlist each rendered their own `AccountNav` **on top of** the
shared layout's sidebar. Both pages predate that layout and kept their own
container, nav and eyebrow. Verified: one nav, one `h1`, all four sections.

### Guest vs account at checkout

A choice, not a gate — "Continue as guest" is listed first and is a real
option. Forcing an account is the most reliable way to lose a sale that was
otherwise made. `from` now threads through signup → verify → login, so creating
an account returns you to the checkout instead of your profile.

### Product search

Icon expands below the nav; results at `/search?q=`. Scored in memory over the
**same visibility-scoped listing every other page uses**, so a hidden category
cannot be reached by guessing a product name. Every term must match somewhere,
or "red saree" returns every red thing alongside every saree. Past ~1000
products this wants a `tsvector` index.

Verified on real data: `shirts` → Cotton, `sarees` → Mul Cotton, `dresses` →
Dress 1 — all category matches rather than name matches.

### Checkout stops re-asking signed-in customers

Name and email come from the account and are **shown, not asked**; retyping an
email invites a typo that sends the receipt where the account cannot see it.
Only address and phone are asked, because those vary per parcel.

**Delivery updates: email and WhatsApp. No SMS.**

- **Email** is the only channel actually wired up, costs nothing on the verified
  domain, and already carries the confirmation
- **WhatsApp** is recorded but cannot send — `sendReply` is still a TODO and
  needs a provider plus template approval. The checkout says so plainly rather
  than implying a message is coming
- **SMS** was skipped: India's DLT regime means registering the entity, sender
  ID and every template with the operators, for the weakest of the three

### Profile and Settings

Profile now shows details **plus the wishlist inline with photos**. Password,
address, preferences and deletion moved to Settings. `/account/preferences`
308s so links in already-sent marketing emails keep working.

**"Update Address" did not exist** — addresses were only ever captured per
order. `0035` builds it: one saved address, not a book, and it can never
redirect an order already placed, because each order keeps its own copy.

### Homepage

Hero → Seasonal → Curated → Instagram → Why us. Our Story removed — and the nav
and footer links pointing at the now-deleted `/#story` anchor were repointed at
`/about`, the dead link that moving content always leaves behind.

**Personalisation uses only the wishlist.** There is no browsing or search
history because none has ever been collected, and collecting it was deliberately
deferred until there is a consent and retention policy for it. Guests and empty
wishlists get new arrivals, and the heading says which one is on screen rather
than calling new arrivals "picked for you".

**It cannot fire yet.** The four current products share no colour, fabric or
category with one another, so every customer correctly sees the fallback. It
starts working the moment two products share an attribute. The threshold is two
matches, kept deliberately low so it is not unreachable on a small catalogue.

### Product reviews

**Verified purchase is enforced by RLS, not by hiding the form**:
`has_purchased()` requires a paid, *delivered* order containing that product.
Compared as text rather than cast to `uuid` — this sits inside an RLS policy,
and one malformed id in order history would start refusing reviews for
everybody.

The list renders server-side so it stays in the cached HTML for crawlers; the
form gates itself in the browser so a per-customer check does not make every
product page dynamic. Admins **hide** (reversible, keeps the row) or **delete**
(asks first) — a moderation decision that leaves no trace is not a decision.

### Header

Emblem only, storefront and admin. The wordmark moved into the hero at full
size beneath the mark.

PR #60

---

## Customer account system

### BUG — admin credentials worked on the customer login form — FIXED

Admin and customer accounts share one Supabase project, so a correct admin
password authenticated on the shop's login form perfectly well. RLS was never at
risk — an admin in the customer area sees only their own rows — but staff signing
in there landed in an account area that is not theirs.

The session is now ended immediately, and **the message is identical to a wrong
password**. Saying "that's an admin account" would confirm which addresses are
staff to anyone who tried a few.

**Side effect worth knowing: admin emails can no longer shop.** Use a different
address to place a real customer order.

Files: `lib/customerAuth.ts` · PR #56

### BUG — signed-in customer sent back to login — FIXED

Not a session or middleware problem. `NavbarClient.tsx` read
`const ACCOUNT_HREF = "/login"` — hardcoded, so the person icon sent everyone to
the login page whether signed in or not.

It now points at the account area, and middleware forwards guests to
`/login?from=`, so one href serves both states without the nav needing to know
who is signed in.

Files: `components/layout/NavbarClient.tsx` · PR #56

### Customer profile area

A shared layout with a sidebar — Profile, Orders, Wishlist, Preferences — so a
new section cannot arrive with the navigation subtly different.

- **Email is shown but not editable.** Changing it needs re-verification at both
  addresses; a field that quietly changed it would leave the account signing in
  with an address nobody proved.
- **Phone is read from the most recent order**, not stored on the profile, because
  a delivery number legitimately differs between orders.
- **Password change requires the current password.** Supabase's `updateUser` does
  not ask — an open session is enough — which is too weak on a shared machine:
  anyone finding a logged-in browser could lock the owner out.
- **Addresses is deliberately absent from the menu.** Nothing stores a customer
  address book; addresses exist per order, captured at checkout. Adding it means
  a new table, a default-address concept and checkout changes. A menu item
  leading to an empty page is worse than no menu item.

Files: `app/(storefront)/account/*`, `components/account/*` · PR #56

### Account deletion

**Keeps the books, loses the person.** Orders are financial records the business
must retain, so they are anonymised rather than deleted: totals, items, dates and
status survive; name, email, phone and address are stripped, and the order is
annotated with the deletion date.

Two refusals, both deliberate:

- **In-flight orders block deletion.** Stripping the address off something
  undelivered leaves a parcel nobody can send and a customer nobody can contact.
- **Admins cannot self-delete this way.** Losing an admin through a
  customer-facing button is how a shop ends up with nobody able to get in.

Placed last, behind a disclosure, requiring `DELETE` typed out — but one click to
open, no ticket to raise. Deletion is a right under the DPDP Act, not a favour.
What actually happens is spelled out before the button.

**Verified through the real auth path** — password grant, then the RPC with that
customer's own token, not the service key:

| Test | Result |
|---|---|
| In-flight order | refused, with a readable reason |
| Delivered order | allowed, 1 order anonymised |
| PII on the order | email, name, phone, address all null |
| Financial record | ₹2,000, items, status `delivered` — intact |
| Auth account | gone |
| In-flight account | survives |
| Profile + saved cart | cascaded away |

Migration `0033` · PR #56

### Terms & Conditions at signup

Required checkbox, **separate from the marketing box** — bundling them would mean
agreeing to terms also opted you into email, which is consent to neither. Links
to `/policies`, already an admin-editable page, so the real wording can be
written without a deploy.

**Marketing consent was already on signup** and has been since it was built. It
is in both places; nothing was moved.

Files: `components/account/SignupForm.tsx` · PR #56

---

## Fifth session — PRs #69–#77

This section exists because the log stopped at **#68** and eight PRs landed after
it. Anyone reading the log alone would have had no idea the storefront had moved
URL, or that the homepage caching had been rewritten.

### Homepage Content could not save at all — FIXED

**Every "Save changes" button under Homepage Content failed** with "Couldn't save
— try again". All five blocks: hero, why linen, seasonal edit, lookbook, brand
story. The editor had been unusable since **4 August, 07:23**.

The cause is one line in `ContentEditor.tsx`. #66 changed the save from
`UPDATE ... WHERE key = ?` to an upsert, for a good reason: the new `lookbook`
key had no seeded row, and an UPDATE matching nothing reports success, so the
editor would have said "Saved" and lost the work on reload.

But PostgREST compiles an upsert to `INSERT ... ON CONFLICT DO UPDATE`, and
**Postgres checks NOT NULL on the proposed insert row before it resolves the
conflict**. `site_content.value` is `NOT NULL` with no default (migration 0001)
and cannot be sent from this editor without publishing the copy — which is the
one thing the draft system exists to prevent. So every save returned `23502`,
including saves to the four keys that already existed and only ever needed an
UPDATE. The upsert fixed a trap that had never fired and broke the path that
worked.

It is now `UPDATE ... .select()`: the returned rows make a zero-row match
**detectable**, which is what the upsert was actually reaching for, and an
insert runs only when nothing matched. That insert seeds `value` from
`DEFAULT_CONTENT`, not from the edit, so a first save on a brand-new key still
cannot put anything live ahead of publish.

Verified against the live database: all five keys save through the UPDATE branch;
a key with no row takes the INSERT branch and lands with `value` ≠ `draft_value`;
a second save on that key returns to the UPDATE branch and leaves `value`
untouched. The publish queue stayed empty throughout.

**It was not the performance work**, which is where the search started. The
audit trigger on `site_content` records the last successful write at 07:22:15 —
45 seconds before #66 merged — and nothing since. The perf PRs landed six hours
later. The failure reproduces against Supabase with no application in the path
at all, so caching, `force-dynamic`, Sentry and framer-motion could not have
produced it.

Files: `components/admin/ContentEditor.tsx` · PR #77

### The other ten admin sections

Checked, and **none of them can hit this**. `ContentEditor` was the only admin
writer using an upsert; Products, Categories, Journal and Pages write to their
`*_versions` draft tables with UPDATE, Orders and Settings use UPDATE, Reviews
uses RPCs, Marketing posts to `/api/admin/marketing`. An UPDATE leaves omitted
columns alone, so a NOT NULL column it never mentions cannot fail it. Every
admin-written table was audited for the same shape — a NOT NULL column with no
default that its writer omits — and `site_content.value` is the only one.

Settings was exercised directly and saves. Orders and Reviews have no rows to
exercise. **Products, Categories, Journal and Pages were not driven end to end**:
their `ensure_*_draft` RPCs are `SECURITY DEFINER` and gated on `is_admin()`, so
they cannot be reached without a signed-in admin session. The reasoning above is
structural, not a test — and this log has already recorded three bugs that lived
in code which read correctly and had never been run.

### Storefront moved under /in — #69

Every customer-facing path now carries a market prefix: `/in/shop`,
`/in/women/sarees/kerala-kasavu`. Done before launch deliberately — moving URLs
after they are bookmarked, shared and indexed costs rankings.

**`/admin` is outside this on purpose.** One back office serves the whole
business; prefixing it would imply a separate UK admin exists.

Two consequences worth knowing. The middleware matcher is now
**everything except `/api`, `/_next` and files with an extension** — it has to
see paths that no longer have a route of their own, like a bare `/shop`, to
redirect them. And admin-typed links are stored unprefixed and rewritten at
render by `adminHref()`, so one stored link keeps working when a second market
opens.

Files: `lib/country.ts` · `lib/urls.ts` · `middleware.ts` · PR #69

### Guest account modal and checkout gate — #70, #71, #72

The person icon offers create / sign in / continue as guest on the spot rather
than bouncing guests to a login form. It is portalled out of the header, because
inside it the header's stacking context trapped it. The checkout gate was then
matched to it in wording and button colour — they are the same decision asked
twice and looked like two different products.

Files: `components/account/GuestAccountModal.tsx` ·
`components/cart/CheckoutGate.tsx` · PRs #70, #71, #72

### Performance — #73, #74, #75, #76

**Full detail is in `wovenne_performance_baseline.md`**, including five
conversions that were tried and reverted. The headline: the homepage was
`force-dynamic` at 993ms TTFB against 64–130ms elsewhere, because the curated set
could vary per customer. It is `revalidate = 60` again, cached for everyone, and
a signed-in customer's browser swaps in their own set after paint via
`/api/curated`. Guests never make the request. 993ms → 19ms, and the build marks
`/in` static again.

`ProductCard` came off framer-motion to an IntersectionObserver
(`lib/useReveal`), taking the category route 213kB → 175kB. `AskWovenne` is
lazy-loaded.

The reverts are the more useful record: CartDrawer, NavbarClient and CareAccordion
were converted off framer-motion, all three broke visibly while typecheck, lint
and build stayed clean, and none of them moved its route's bundle at all. Sentry
was reviewed and deliberately left as is.

Files: `wovenne_performance_baseline.md` · PRs #73, #74, #75, #76

---

## Sixth session — PRs #78–#89

Twelve PRs, four migrations. The log had stopped at #77, which is why this
section is long: nothing between the cart fix and the reporting system had been
recorded anywhere but in commit messages.

### The cart followed one customer to the next — FIXED, #78

A signed-in customer who added items and logged out left their cart on the
device for the next person. **Worse than it looked**: CartSync restores only
into an empty cart, so a second customer signing in had their own cart NOT
restored, and 1.5s later the sync wrote the FIRST customer's items into the
SECOND customer's row. A cross-account write, not just a disclosure.

The cart now carries an `ownerId` and the rule lives in `lib/cartOwner.ts` as a
pure function with 14 assertions. Two bugs surfaced in testing that read
perfectly correctly: the first version cleared guest carts on every page load,
and the flush of already-deployed carts used `migrate`, which zustand never
calls when the stored blob has no numeric version — so it missed every cart it
existed to clear.

### Six customer-facing account bugs — #79

Error above the email field, a duplicate eye icon that turned out to be the
BROWSER's own reveal control, "code expired" for a code that was merely wrong
(Supabase sends one message for both), the reset link landing on the homepage,
Save address doing nothing, and login landing on the wishlist.

The reset link was a regression from #69: `redirectTo` was unprefixed, and the
allow-list rejected it so Supabase fell back to the Site URL. Save address was
TWO bugs — the settings page read the address from the last ORDER while the
panel wrote it to `profiles.default_address`, and the write could not tell a
blocked update from a real one.

### Preview mode leaked to customers — #80

Next's draft cookie is independent of the Supabase session, so an admin who
previewed and logged out left a browser still claiming to preview. Preview is
DERIVED now: the cookie says what was asked for, `is_admin()` says whether it
is still allowed. `/in` still builds static, so #74's caching is intact.

### Coupons and invoices — #81, #82, migration `0037`

Coupons are applied server-side in the Razorpay route from the priced subtotal.
`redeem_coupon()` moves the counter in one guarded UPDATE and is claimed on
PAYMENT, not checkout-start, so abandoned modals cannot burn a launch code.
Loyalty accrual needed no change: `0029` already earns on the captured total.

Invoices are a gapless `WOV-YYYY-NNNN` sequence assigned once at paid;
`assign_invoice_number()` is idempotent. The PDF renders ON DEMAND from the
order's own snapshot. **The rupee sign does not exist in PDF's built-in fonts** —
it printed as a stray mark, found by rendering the document and looking at it,
so amounts read "INR 8,900".

### The reporting system — #83–#89, migrations `0038`–`0041`

Built in six PRs, organised by what CANNOT be reconstructed later.

`0038` captures cost snapshotted per order line, actual courier cost, Razorpay
gateway fees, and stock movements — `product_sizes` had never been audited, so
nothing recorded stock MOVING, only its current value. Three things would have
broken it: `create or replace` with a new parameter OVERLOADS rather than
replaces (checkout would have failed on the next payment), a changed return type
cannot be replaced in place, and the carry-through trap had ALREADY fired —
`0037` added `hsn_code` to products and versions but to neither publish path.

`0039` made cost hand-editable with a live margin readout and logged manual
stock edits, which had been invisible. It also fixed a latent data-loss bug:
`saveProductSizes` deleted every size row then re-inserted, so a failed insert
would have left a product with no sizes and no stock.

`0040` added expenses, audited, with the double-counting rule written into the
migration, the table comment AND the form: per-order courier cost is
authoritative, and the shipping CATEGORY is only for spend not attributable to
one order.

`0041` is the P&L. Discounts are reported, never subtracted — `total_inr` is
already net of them. It leads with what it cannot know, because a missing cost
cannot be subtracted and therefore every gap makes the shop look MORE
profitable. Verified against seeded data whose answer was computed
independently: revenue 5,000, gross 3,000, net 1,732.

#87 and #88 added Excel exports across seven datasets with a column picker and
the financial-year bundle. PostgREST returns numerics as STRINGS, so without
coercion every money column would have landed as text and every SUM returned
zero — 17 assertions against a real written-and-reloaded workbook.

#89 added imports with templates, a validation preview and nothing written until
approved. A blank cell means "leave alone", never "set to zero".

### What is still not exercised

**No order has ever been placed.** Invoice numbering, coupon redemption, loyalty
accrual, cost snapshotting, gateway-fee capture and stock movements have each
been verified in isolation and have never run together. The Razorpay test
purchase remains the single largest gap, as it has been since session four.

**Credit notes do not exist.** Returns & Refunds was scoped in detail and
deferred. Anything depending on it — cancelling an order, a P&L that reflects
cancellations — is unbuilt.

---

## The gap — the only remaining unverified item

### A Razorpay test-mode purchase has never been made

Every piece below is verified **individually**. **None has been exercised as a
single sequence**, because that requires a real payment:

1. Checkout contact + address capture
2. Shipping cost calculation and charge
3. Per-size stock decrement (`reserve_stock`)
4. Order confirmation email
5. Admin Orders view
6. Customer order tracking page
7. Analytics (all panels read from orders)
8. Loyalty accrual on a paid order
9. Abandoned-cart suppression after purchase
10. Account deletion against a **real** order — the refusal and the anonymisation
    were proven against orders created for the test, not orders that came from a
    payment
11. Reviews against a **real** purchase — the verified-purchase rule is proven,
    but against an order inserted directly rather than one that came from a
    payment

**Recommendation:** one test-mode purchase, watched from the admin. It would
close all eleven at once.

Use an address that is **not** an admin one — since this session, admin emails are
rejected by the customer login form, so a partner address cannot place an order.

### Why this matters more than it sounds

**Three bugs this session were in code that read correctly and had never been
executed** — `create_product_draft`, the MFA factor lookup, and `handle_new_user`.
All three were found by testing, not by anything visibly failing. The consent bug
would have surfaced the next time a partner was added, with an error that said
nothing.

The risk is not in the logic anyone reasons about. It is in the paths nothing has
run.

---

## Current data state

| | |
|---|---|
| Orders | **0** |
| Customer accounts | 1 (`tomthms7776@`) |
| Consented customers | **0** |
| Products | 4 published |
| Product sizes set | 0 |
| Carts | 1 (admin's own, from testing) |
| Loyalty ledger | 0 |
| Admins | 3 — only `admin@` has MFA enrolled |

Analytics, segmentation and marketing will all correctly report **empty**. That
is the honest state, not a fault — but it means a working feature and a broken
one currently look identical on screen.

---

## Shiprocket — half built, and the half that's missing was never logged

**What exists and works:** the admin Orders view, and dispatch details recorded
by hand. An admin books the shipment on Shiprocket's own dashboard, then types
the courier and AWB into the order. It saves (`orders.courier_name`,
`awb_number`, `shipped_at` from `0024`), the audit log records it, and the
customer's tracking page shows the number and carrier.

**What does not exist:** any Shiprocket API integration. No API client, no
credentials, no env vars, nothing. Specifically, the part of the original brief
that said *"admin sees courier options for a paid order and selects one"* was
never built — there is no call that fetches courier options or rates.

**How it got here.** It was a deliberate decision, and the reasoning is sound —
booking happens where the rates and options already are, and the API can replace
the typing later without changing what is stored. But that decision was recorded
**only in a code comment in `OrdersManager.tsx`**, which is the one place the
owner would never look. It never reached this log, and it never reached the
outstanding list. It was not dropped on purpose; it fell off the reporting.

**To finish it** would need: Shiprocket API credentials, a token exchange (their
auth expires and needs refreshing), a serviceability/rate call, an order-create
call returning the AWB, and a webhook for status changes. The manual flow keeps
working throughout, so this is an upgrade rather than a prerequisite for
shipping anything.

---

## Seventh session — the in-person order and cancellation fixes

Two PRs, split by urgency: what could put the books wrong, then what makes the
screen usable.

### The first real order, and what happened to it — SINCE REPAIRED

At **14:26 today** an order was recorded through the in-person screen. It is the
**first order this shop has ever had**, and it exercised three of the bugs below
at once. It is still in the database, and putting it right is a call for the
owner rather than something to do quietly:

| | |
|---|---|
| Invoice | `WOV-2026-0005`, ₹182,289 |
| Recorded | 2 lines — `001` size M × 4, `Dress 1` × 111 |
| Stock taken | **none at all**, for either line |
| Status | `cancelled` |
| Credit note | **none** |
| `cancelled_at` | **null** |

What happened, in order:

1. **`Dress 1` × 111 was sold against 8 in stock.** `reserve_stock` is one call
   and one transaction, so the whole reservation was refused — **including the
   `001` line, which had 9 in stock and was perfectly sellable**. The order was
   written anyway and flagged, which is what the old code did on purpose.
2. **The review flag was then cleared**, which is what that button is for — but
   the stock was still never taken.
3. **It was cancelled with the old "Cancel this order" button**, which set the
   status and nothing else. So there is no credit note, `cancelled_at` is null,
   and the P&L still counts ₹182,289 of revenue and ₹210,900 of cost against a
   sale that is marked cancelled and was never dispatched.

**Repaired the same evening, on the owner's instruction**, at **18:12**: set back
to `confirmed`, then cancelled through `cancel_order()` — the same function the
new button calls. Deleting the row was the alternative and was rejected, because
it would have meant deleting an issued invoice, which this shop's whole numbering
scheme exists to prevent.

| | |
|---|---|
| Credit note | `CN-2026-0008`, ₹182,289, against `WOV-2026-0005` |
| Stock returned | **no** — correctly, there was no `sale` movement to reverse |
| `cancelled_at` | stamped |
| Invoice | unchanged, as issued |
| August P&L | gross revenue 182,289, credits 182,289 → **net revenue 0**, COGS fully reversed, **net profit 0** |

`stock_returned: false` is the guard from `0045` doing exactly what it was built
for: `Dress 1` is still 8 and `001` M is still 9, rather than 119 and 13.

**The cancellation email was then sent to that order's address** — the customer
address on it is the owner's own, so this was also the first real run of the email
and the attachment. `CN-2026-0008.pdf` rendered at 41,758 bytes and Resend
accepted it (`007bf24e-28a2-45cc-9937-a806c50a4f3e`). It went through
`buildCreditNote`, `CreditNoteDocument`, the `orderCancelled` templates and
`sendEmail` — the production path for everything that shapes and sends the
message. Only the reading differed: the route reads through PostgREST with the
admin's session, and there was no browser session to borrow here.

**It found one thing worth fixing, by looking at the document that was sent.** An
in-person order has no Razorpay id, and both document builders fell back to the
raw uuid — so the credit note printed
`a53c16f7-b5d3-48e5-b825-ed84aa335d59`, wrapped over two lines, where the
customer's email, their order page and the admin all say `A53C16F7`. Two
documents about one order quoting two different references is the kind of thing
that gets queried. The fallback is now the short reference; an online order still
prints the Razorpay id, because that is what a bank would quote.

### The bypass button — REMOVED, and refused by the database

`StatusControls` kept a **"Cancel this order"** button from before credit notes
existed. It ran a plain `UPDATE ... set status = 'cancelled'`, which admins are
allowed to run because they are allowed to move an order along. It sat directly
above the correct control, looked like the obvious one, and was one click — and
it is what cancelled the order above.

It is now shown **only for unpaid orders**, where there is no invoice and no money
and therefore nothing to credit.

**Removing the button is half the fix.** The `UPDATE` is still available to
anything holding an admin session, and "we removed the button" lasts until the
next screen is written. Migration **`0049`** refuses it in the database: a paid
order cannot enter `cancelled` unless a credit note exists against it. It also
stamps `cancelled_at`, so that column is right whichever path did the cancelling.

`0049` is **applied and verified** — 21 assertions inside a transaction that was
rolled back, with the guard itself created and dropped inside it, so the rule was
exercised against the real database before being added to it. A plain UPDATE is
refused with a message naming what to use instead; dispatch details still save
and status still moves forward, so the guard did not turn Orders into a read-only
page; `cancel_order()` still works and stamps everything; an unpaid order is
still cancellable by hand.

The verification also **found the broken order above** — its first version
asserted the orders table was empty afterwards, which had been true until this
morning. The assertion now reads a baseline first, because a test that assumes an
empty database reports a fault in the shop instead of one in itself.

Files: `supabase/migrations/0049_cancel_needs_a_credit_note.sql` ·
`scripts/cancel-guard.verify.mjs` · `components/admin/OrdersManager.tsx`

### The cancellation email — IT DID NOT EXIST

Cancelling issued a credit note, put the stock back, marked the order — and told
the customer **nothing**. They had already had a confirmation and an invoice; the
next thing they would have known about it is a parcel that never came, or a
refund appearing with no explanation.

The call moved from the browser to `/api/admin/orders/cancel`, because email
cannot be sent from a browser. It uses the **admin's own session, not the service
key**: `cancel_order()` is gated on `is_admin()` and stamps `issued_by` from
`auth.uid()`, and with the service key that is null.

- **The credit note is now a document**, rendered like the invoice and attached to
  the email. `CreditNoteDocument` deliberately shares the invoice's typesetting —
  a customer holding both should be in no doubt they came from the same shop.
- **It is downloadable** from the admin invoice list and from the customer's own
  Orders page, because an email is easy to lose. Authorised by RLS rather than by
  a hand-written check, exactly as the invoice route is.
- **The email never says "you have been refunded"**, and `STATUS_BLURB` no longer
  says it either. A credit note records what is owed; the money moves in Razorpay
  or in cash and nothing here can see it land. An in-person sale is told plainly
  that someone will be in touch, because there is no gateway payment to reverse.
- **The email failing is never fatal.** By the time it is attempted the
  cancellation has happened; failing the request would say it had not, and a
  second press would be refused as already-cancelled. The outcome is reported on
  screen instead — including "the customer was NOT emailed", said out loud.

Verified by rendering the document and **looking at it**, which is how the missing
rupee glyph was found last session: `scripts/credit-note-preview.ts`. Also
rendered for an anonymised order with no item snapshot, which is what a deletion
request (`0033`) leaves behind.

### Cancelled orders had nowhere to go — FILTERED

Orders was one long list. A cancelled order sat among the live ones, struck
through, looking exactly like work still to do until you read the pill. There are
now five views — **To fulfil, Delivered, Cancelled, Needs attention, All** —
opening on To fulfil, each carrying its own count so nothing appears to have
vanished, and the heading says which one is on screen.

### Stock enforcement on in-person sales — NOW CHECKED FIRST

The old flow recorded the sale, watched `reserve_stock` refuse it, flagged the
order and carried on. That is right for an online payment: the money has already
left the customer's account, and refusing to record it would lose the order
rather than fix the shelf.

**In person it is the wrong way round.** The operator is holding the piece and can
look at the shelf, and the far likelier reading of "no stock" is a size left
unchosen or a count nobody has updated — which is exactly what happened at 14:26.

Availability is now read **before the order is written**, the same way
`reserve_stock` reads it: per size where a product has sizes, from the published
version's own count where it has none. `products.stock_quantity` looks like the
right column and is not the one a sale decrements.

- Quantities are **summed per product and size first**. Two lines of the same size
  can each sit inside the count and be over it together, and a per-line check
  would wave that through — then the whole order is refused at the till.
- A product with **no count on record reads as none**, not as unlimited. That is
  the direction that avoids overselling.
- **Recording it anyway is still possible**, and is now a decision rather than a
  message read afterwards: the shortage is named, and a checkbox has to be ticked
  before the sale submits. The order is then flagged, and the screen says plainly
  that **no** stock came off — for any line, not just the short one.
- **Per-line reservation was considered and rejected.** `0045` returns stock on
  cancellation only where a `sale` movement exists, so an order that reserved
  some of its lines would be credited back in full and invent the difference.

### Mandatory fields — A NAME, A CONTACT, AND A REAL SIZE

- **Name** was optional while being printed on the invoice.
- **Email or phone**, one of the two. Neither means no way to reach someone about
  a return, and a stall is the one moment they are standing in front of you.
  Either will do, so nobody is made to hand over an address they would rather not.
- **A size, where the product has sizes.** The form offered "One Size" as the
  default for every product including sized ones, and nothing refused it —
  `reserve_stock` looks a size row up by label, so a sized piece sold as "One
  Size" matched nothing and the sale was recorded as if the shelf were empty.

The rules live in `lib/manualOrder.ts` as pure functions and run in **both** the
form and the route: the form's copy exists so the operator finds out while the
customer is still there, the route's copy is what decides. **39 assertions**,
headless, `npx tsx scripts/manual-order.test.ts` — including the two-lines-of-one-size
case and the "One Size" one that fired this morning.

PR #97

---

## Outstanding, owner action

- ~~**The 14:26 order**~~ — DONE, repaired at 18:12 with credit note
  `CN-2026-0008` and the cancellation email sent. See the seventh-session section
- **Razorpay test purchase** — above. Still the largest gap, and now the only
  path in the shop that has never run: the in-person one has
- **Admin save check, signed in** — Products, Categories, Journal and Pages save
  through `is_admin()`-gated RPCs that cannot be reached without an admin
  session, so they were reasoned about rather than tested. One save in each,
  while logged in, closes all four
- **Product sizes** — none set, so no Size filter appears anywhere
- **Shipping config** — seeded Kerala free / ₹120 / free over ₹3,000; confirm
  these are the real numbers
- **Loyalty** — switch on when ready; rates are editable
- **Partners' first login** — `hello@` and `care@` still show `MFA: not enrolled`
- **T&C wording** — `/policies` holds placeholder content; edit it in the admin
- **Shiprocket API** — not built; dispatch is typed in by hand today. See the
  section above for what finishing it needs
- **Customer addresses** — BUILT. `0035` stores one saved address per
  customer, editable under Settings and pre-filled at checkout. It is
  deliberately one address rather than a book, and it cannot redirect an order
  already placed.
