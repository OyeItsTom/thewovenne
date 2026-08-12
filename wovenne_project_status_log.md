# THE WOVENNE — project status log

Last updated: 10 August 2026 (seventh session)

> **PRs #97–#100 are all merged to `main`.** Migrations `0044`–`0051` are applied
> and verified against the database.
>
> **ASK WOVENNE IS SWITCHED OFF** (`store_settings.ask_wovenne_enabled: false`),
> so the concierge work in #99 and #100 reaches nobody until that toggle is on.
> See "Status check" at the bottom.
>
> **Read the seventh-session section at the bottom first.** The shop took its
> first ever order today, through the in-person screen, and three of the bugs
> fixed in that section all fired on it. It has since been repaired — credit note
> `CN-2026-0008` — and the story is under "The first real order, and what
> happened to it", because it is the clearest description of what those bugs
> actually did.

---

## Session summary

Everything below is built and merged to `main`. Migrations `0024`–`0051` are all
applied to Supabase and verified — including `0042`, which this section used to
describe as awaiting a run (`product_versions.allow_no_images` exists; checked
10 August).

**One thing is not verified end to end: a real payment.** See "The gap" at the
bottom — it is the single largest remaining risk and it cannot be closed from
this side. As of 10 August the database still holds zero stock movements with
reason `sale`, which is the same fact stated in data.

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

### The screen itself — PR #98

The second PR, and none of it changes what is recorded. It changes how long it
takes to record it, and what is asked while the customer is there.

**Marketing consent, asked at the stall.** Migration `0050`, **applied and
verified**, 19 assertions in a rolled-back transaction. Unticked, never
pre-ticked, and written as the words to say out loud rather than as a field
label. What it does and does not promise is stated on the form itself:

- It **records that they said yes**, on the order, with the moment — which under
  the DPDP Act is the only thing that makes a later send defensible.
- It makes them **marketable only if they have an account**, because
  `marketing_targets()` starts from `profiles` and always has. Where an account
  exists for that address the consent is set on it and they join the list
  properly, matched on the lower-cased email so `Tom@` and `tom@` are one
  person. Where one does not, the record sits on the order and reaches nobody —
  and the screen says so afterwards instead of implying otherwise.
- **An existing consent date is never overwritten.** The date that matters is the
  first time they said yes, not the last time somebody asked.
- **It does not leak into a later signup.** If they open an account next month
  they are asked again, unticked, by `handle_new_user`.
- Refused for an order with no email address, for an order that does not exist,
  and for a non-admin session — all three verified.

**Existing-customer search.** A returning customer is found by name or email and
their details filled in, rather than retyped — retyping is how a receipt ends up
one letter away from the account that should be able to see it. The phone comes
from their **most recent order**, because that is the only place the shop holds
one and a delivery number legitimately differs between orders; everything filled
stays editable. The list is fetched **on demand rather than on mount**, because
`admin_customers()` writes an audit row every time it is called and a screen that
called it on opening would fill that log with reads nobody made. Someone who has
already opted in shows as such, with no box to tick.

**The logo on the invoice.** Both documents carried the wordmark letterspaced and
nothing else, so the one thing a customer recognises at a glance was missing from
the page that ends up in their records. The emblem sits above the wordmark on the
invoice and the credit note.

It is **embedded as base64, not read from `public/`** — these render inside
serverless functions where `public/` is served as static assets and is not part
of the function bundle, so a path would have worked locally and produced a
logo-less invoice in production, for real customers only. Sized by rendering it
at 34, 44 and 56pt and looking at all three: below about 44pt the interlaced
strands close up and the weave stops reading as a weave.

**The product picker.** One `<select>` of every product was fine with four pieces
and stops being fine at forty — and at a stall the operator is holding the item,
so they know its name or its category, not its position in an alphabetical list.
There is now a category filter and a search box, offering up to eight matches
with **the stock count on each button**, because the most useful moment to know a
piece is sold out is before adding it. A parent category includes its children,
since "Women" at a stall means everything under it, and every search term has to
match somewhere — the same rule the storefront search uses, or "red saree" offers
every red thing alongside every saree.

PR #98

---

## Current data state — 9 August 2026, after the seventh session

The table further up this log said 0 orders, 1 customer account and 0 consented
customers. All three had changed by this morning; this is the state now.

| | |
|---|---|
| Orders | **1** — the 14:26 one, cancelled and credited |
| Credit notes | **1** — `CN-2026-0008` |
| Customer accounts | 4 |
| Consented customers | 4 |
| Admins | 3 |
| Products published | 4 |
| Products with sizes set | **1** of 4 (2 size rows) |
| Saved carts | 5 |
| Stock movements | 7 — all hand corrections and restocks, **no sale** |
| Loyalty ledger | 0 |
| Reviews | 0 |
| Expenses | 0 |

**No `sale` movement exists anywhere**, which is the same fact as "no order has
ever taken stock". The 14:26 order is paid and has none.

The first real credit note is **`CN-2026-0008`**, not `0001`: numbers 1 to 7 were
consumed by verification transactions that were rolled back, and a sequence does
not roll back with them. Harmless — the series only ever promises not to reuse a
number — but worth knowing before someone asks where the first seven went.

---

## Ask Wovenne knows what it is selling — PR #99

The concierge used to be told the catalogue and then trusted to remember it. It
now looks things up: four read-only tools, and a per-product field holding the
part of the story a price and a fabric name cannot carry.

**This is an upgrade to the existing design, not a new one.** Three of the four
tools wrap read helpers that already existed — `searchProducts` from `/search`,
`getProductBySlug`, `getProductSizes` — which is why they inherit the property
that matters: they read PUBLISHED versions inside `getVisibleCategoryIds()`, so a
hidden category cannot be reached by asking the concierge nicely.

### Brand knowledge — migration `0051`, applied and verified

Three hand-written fields per product: **heritage** (the tradition, the region),
**craft** (loom, technique, what makes this piece distinctive), **care** (how to
wash, dry, store this piece). Three columns rather than one JSONB blob — each is
separately diffable in the publish queue and can be handed to the concierge as a
named field instead of a shape it has to parse.

They live on `product_versions`, so they inherit draft/publish for free: written,
previewable on the real product page, published with the rest of an edit.

**Both carry-through points are named, and the migration asserts it.** A
`product_versions` column reaches `products` by two separate explicit routes — the
column list inside `ensure_product_draft`, and `0038`'s publish trigger. `0037`
missed both with `hsn_code`; `0046` documented the trap. `0051` re-declares both
functions and its verify block fails if either stops mentioning all three columns.

**13 assertions** in a rolled-back transaction (`scripts/brand-knowledge.verify.mjs`),
including the two that matter: publishing copies all three onto `products`, and a
draft forked from that published version still carries them.

**Nothing is generated and nothing is backfilled.** All four products read null,
which is true — nobody has written them up yet. The concierge is told to say so
rather than improvise, and the tests assert that instruction is present.

### The bug this turned up: every product edit was wiping its cost price

`getAdminProducts` fetched `cost_price_inr` and `sku`, and `mapProduct` — which
builds its result field by field — never copied either. `Product` declares both
optional, so nothing type-checked wrong. The cost price therefore arrived in the
product editor as `undefined`, rendered as an empty box, and **the form saves what
it shows**: opening a product to fix a typo in its description silently un-costed
it, and the P&L then read that piece as pure margin.

It is the same failure as #94's missing video, one layer over, and it would have
happened to brand knowledge too — the new fields load by exactly the same route.

Fixed with a second mapper, `mapAdminProduct`, kept OUT of `mapProduct` on
purpose: that one is the storefront allow-list, and what a piece costs us must not
ride a public page payload even as a null.
`scripts/product-mapping.test.ts` now covers the admin columns as well — **46
assertions**, including that `mapProduct` still refuses to carry cost or heritage.

### On the product page, and in the admin

- A **&ldquo;The story of this piece&rdquo;** section renders heritage and craft below the
  video. A server component with no JavaScript — it is prose about cloth, there is
  nothing to toggle. It renders nothing at all when both are empty: a heading with
  no content reads as a shop that forgot, and a placeholder paragraph about
  tradition nobody wrote would be worse than silence.
- **The care note replaces the fabric-generic advice** in `CareAccordion` rather
  than sitting beside it. Advice from a lookup table under advice from a person
  invites the two to contradict each other, with no way for a customer to know
  which to follow. The admin form says which one is in force as you type.
- **Not added to `PRODUCT_SELECT`.** Three paragraphs per product on every category
  page, for text only the product page and the concierge read, is the weight
  #73–#76 spent four PRs removing. One extra query on the one page that shows it.

### The four tools

| Tool | Wraps | Notes |
|---|---|---|
| `search_products` | `lib/search.ts` | Same scorer as `/search`; returns the slugs the other tools take |
| `get_product_details` | `getProductBySlug` + sizes | Says explicitly that heritage is elsewhere, so it looks it up instead of composing it |
| `check_availability` | `getProductSizes` | **Per size, then the published version's count** — the way `reserve_stock` reads it |
| `search_brand_knowledge` | `0051` + a new scorer | By slug, or across every piece's notes |

`check_availability` deliberately does not read `products.stock_quantity`. That
column looks like the right one and is not the one a sale decrements — quoting it
would let the concierge promise a size the till then refuses. Same trap as #97.

**Read-only structurally, not by convention.** Every executor uses `ANON_CTX` —
the anonymous client, under RLS. Not "we didn't write an UPDATE": the client it
holds cannot write and cannot see a hidden category, so neither can the
concierge. No SQL is generated anywhere; tools take typed parameters and build
PostgREST queries. The one privileged read in the chat path (an order, matched on
exact id **and** email, service key) stays in `lib/chat.ts` and is **not** a tool —
the model must not be able to decide to go looking for orders. The test asserts
`lib/chatTools.ts` contains no service client and no writer at all.

### The loop, and one model setting that mattered

`streamChat` yields text now instead of returning one Anthropic stream: a single
customer message becomes several model calls with lookups in between. The web
route pipes it to the browser, the WhatsApp path concatenates it, and neither
knows how many rounds happened — so both channels run the identical loop.

**Thinking was disabled here for latency, and that is the wrong setting for a
tool-using concierge:** on this model a thinking-off turn reaches for tools
noticeably less, which is exactly the behaviour the tools exist to produce. It is
adaptive thinking at **low** effort now. Thinking text is never forwarded.

Bounded at four lookups; the final round is asked with tools switched **off**
rather than simply cut off, so a customer who asked a question gets an answer
built from what was gathered instead of silence. **20 assertions** drive the loop
with a fake model (`scripts/chat-loop.test.ts`), covering the parts that fail
silently: text from every round reaching the caller, the assistant's `tool_use`
blocks being appended before the results, **all** results returning in ONE user
message (splitting them teaches the model to stop asking in parallel), and
termination.

### Signed-in customers get a bigger allowance — the tier that did not exist

The log has claimed a login tier for a while. There wasn't one: the cap was
10 messages an hour for everybody, and a customer who had created an account,
verified an email and bought something was limited exactly like a passing
scraper. `SIGNED_IN_MESSAGE_LIMIT = 40` now applies, decided from the **session
cookie server-side** — the browser cannot claim it by sending a user id, because
nothing reads one — and keyed on the customer's own id rather than their address,
so two customers behind one office NAT no longer eat each other's allowance.

Not unlimited: an account costs an email address, so an uncapped signed-in tier is
one signup away from an uncapped anonymous one.

**One message still costs one message** whatever the concierge does next. A reply
needing three lookups is three model calls and a single spend — the cap is on what
the customer asked for, not on how hard the answer was to find.

### Verified, and what is not

- `0051` applied; **13** database assertions in a rolled-back transaction
- **35** tool assertions against the real anonymous client
  (`scripts/chat-tools.test.ts`) — every refusal path included
- **20** loop assertions with a fake model (`scripts/chat-loop.test.ts`)
- **46** mapping assertions, now covering the admin columns
- typecheck, lint and build clean; `/in` still builds static

**NOT VERIFIED: whether the live model actually reaches for the tools.** That is a
property of the prompt and the model, not of the code, and it cannot be checked
from here — `.env.local` holds the placeholder key, so the real one only exists in
Vercel. `scripts/concierge-live.ts` exists for exactly this and prints which tools
were called:

```
npx tsx scripts/concierge-live.ts "is this real handloom, and how do I wash it?"
```

Run it after any edit to the system prompt or a tool description. A change that
reads like an improvement and quietly stops the lookups happening is the failure
mode, and the script says `NO TOOLS WERE CALLED` when it happens.

### Also worth knowing

- **Latency and cost per message go up.** Each lookup is a round trip: expect
  +1–3s on questions that need one, and 2–4 model calls where there was one.
- **Order tracking is still unreachable in practice.** `lookupOrder` wants an
  order id *and* an email and the widget sends neither. Now that the route reads
  the session, passing that customer's verified email through is a one-line
  change — deliberately not made here, since it was not asked for.

PR #99

---

## Order tracking actually works now — PR #100

`lookupOrder` has existed since the concierge shipped and has **never once been
reachable**. It needs an order id *and* an email from the request body; the widget
sends neither, so the code was dead. Two things were wrong beyond that:

1. **It compared the full uuid.** Every customer-facing surface shows
   `orderRef()` — the first block, uppercased, `A53C16F7` — because that is what
   somebody can read down a phone. A customer quoting the only reference they have
   ever been given could never have matched.
2. **The email came from the browser.** An email in a request body is a claim. Any
   caller who guessed an id/email pair would have been handed the order.

**The email now comes from the verified session**, read server-side in the route —
the same read that decides the message allowance. And there is a fifth tool,
`get_my_order`, offered **only when that session exists**.

### Why the email is not a parameter

It is closed over from the session and the query is pinned to it. The model
chooses *which of that customer's orders* to describe and can choose nothing else:
there is no argument it could pass, and no prompt anyone could send it, that
widens the query to somebody else's order. The reference is filtered **in
JavaScript over rows already pinned to that email**, so a reference cannot become
a filter for another row either.

**A guest is offered no tool at all**, rather than a tool that refuses — a tool in
the list is a tool that gets tried, and the prompt tells it to ask them to sign in
instead of asking for an order number it cannot verify.

### It stays out of `lib/chatTools.ts`

Orders are not publicly readable, so this one needs the service role. Every tool
in `chatTools.ts` reads through the anonymous client and a test asserts that file
contains no service client and no writer at all. Keeping that boundary legible was
worth more than keeping all five tools in one file, so the privileged one sits
next to the privileged function that already existed, and the loop decides whether
to offer it.

### What it tells the model

Status, items, total, invoice number, courier and AWB once dispatched — and for a
cancelled order, **an explicit instruction not to say the refund has been paid**,
because a credit note records what is owed and the money moving is not visible
from here. The same care as the cancellation email in #97.

**18 assertions** (`scripts/order-tool.test.ts`), against the real orders table:
four tools for a guest and five for a customer, the short reference resolving in
upper and lower case and by full id, an unrelated session seeing nothing, and — the
one that matters — **a known reference belonging to someone else refused, with
nothing about them in the refusal**. The cancelled-order instruction is covered by
real data, since the 14:26 order is cancelled.

The widget needed no change: a same-origin fetch already sends the session cookie.
There is now a comment saying so, because "nothing here" is otherwise indistinguishable
from an oversight.

PR #100

---

## The cost-price bug: what it actually cost

The audit log answers this exactly, because `log_admin_action` records
`{column: {from, to}}` for every update. **Two products lost a cost price**, both
on 9 August, both to the mechanism described under PR #99:

| Product | Cost wiped | When | By |
|---|---|---|---|
| `001` | **₹600** | 9 Aug, 11:31:25 | `admin@thewovenne.com` |
| `Cotton` | **₹200** | 9 Aug, 11:33:22 | `admin@thewovenne.com` |

The log shows the mechanism in the timestamps. Costs were set on **8 August at
17:20–17:21** (null → 600, 200, 1900, 2000). On **9 August at 11:31**, `001` was
edited: an `insert` of 28 fields — `ensure_product_draft` forking a draft and
carrying the cost correctly — followed **0.27 seconds later** by an `update`
setting `cost_price_inr` from `600.00` to `null`. That second row is the product
form saving what it had shown, which was an empty box. `Cotton` repeats it exactly
two minutes later.

`Dress 1` (₹1,900) and `Mul Cotton` (₹2,000) still have their costs **only because
they have not been edited since**. Their next edit would have taken them too.

This is also the answer to the P&L's `products_without_cost: 2` — it was not two
products nobody had costed. It was two products whose costs were erased.

### RESTORED — 10 August, 00:43

Both put back **through the normal draft/publish path**, not a direct UPDATE:
`ensure_product_draft` forked a draft, the cost went on the draft, `publish_one`
published it, and `0038`'s trigger carried it onto `products`. Three reasons that
mattered — it is the same route the admin form takes, so a restore that worked
proves the form does; the audit trigger records it as an ordinary edit rather than
a value that changed by magic; and it re-exercises the carry-through this session
has now touched twice.

One transaction per product, refusing to run if either had an open draft (which
would have published somebody's unfinished edit alongside the cost) or already had
a cost (which would have overwritten it). Verified on **both** `products` and the
published version before committing — a half-copied restore is the original bug
again.

| | Cost | `products` | Published version |
|---|---|---|---|
| `001` | ₹600 | ✅ | ✅ |
| `Cotton` | ₹200 | ✅ | ✅ |

**The P&L now reports `products_without_cost: 0`.** All four products are costed,
four published versions, no drafts left open, the storefront still reads all four.

Script: `scripts/restore-cost-prices.mjs` — kept because it documents what was
restored and from where, and refuses to run twice.

---

## Outstanding, owner action

- ~~**The 14:26 order**~~ — DONE, repaired at 18:12 with credit note
  `CN-2026-0008` and the cancellation email sent. See the seventh-session section
- **Ask Wovenne is switched off** — one toggle in Admin → Settings. Until it is on,
  #99 and #100 (tools, brand knowledge, signed-in tier, order tracking) are dark;
  `/api/chat` returns 503 by design and `chat_usage` shows one window, last used
  2 August
- **Razorpay test purchase** — above. Still the largest gap, and confirmed by the
  database: `stock_movements` holds **zero** rows with reason `sale`, so no order
  has ever taken stock through any path
- **Admin save check, signed in** — HALF CLOSED, by the audit log rather than by a
  test. `product_versions` has 80 recorded writes and `category_versions` 48, so
  Products and Categories demonstrably save. `journal_versions` and
  `site_page_versions` have **zero** — Journal and Pages have never successfully
  written anything. One save in each of those two closes it
- **Product sizes** — set on 1 product of 4. The three without them are sold as
  "One Size" and their stock comes off the published version's own count, which
  works, but no Size filter appears for them on the storefront
- **Shipping config** — seeded Kerala free / ₹120 / free over ₹3,000; confirm
  these are the real numbers
- **Loyalty** — switch on when ready; rates are editable
- ~~**Partners' first login**~~ — DONE. All three admins (`admin@`, `care@`,
  `hello@`) now have a verified MFA factor; checked against `auth.mfa_factors`
- **T&C wording** — `/policies` holds placeholder content; edit it in the admin
- **Brand knowledge** — the three fields ship EMPTY on all four products. Until
  you write them, Ask Wovenne is no better informed about heritage or care than it
  was, and the product page shows no story section. This is the one item on this
  list where the value arrives with your text rather than with a merge
- **One live concierge run** — `npx tsx scripts/concierge-live.ts "…"` with a real
  `ANTHROPIC_API_KEY` in `.env.local`, to confirm the model actually calls the
  tools. Everything else about them is tested; that part cannot be
- **Shiprocket API** — not built; dispatch is typed in by hand today. See the
  section above for what finishing it needs
- **Customer addresses** — BUILT. `0035` stores one saved address per
  customer, editable under Settings and pre-filled at checkout. It is
  deliberately one address rather than a book, and it cannot redirect an order
  already placed.

---

## Status check — 10 August 2026

Everything below was read from git, the code, or the database rather than from
this log, because two entries in it had gone stale and one feature was recorded
more optimistically than it deserved.

### Corrections

**MFA is finished.** All three admin accounts have a verified factor. The
outstanding list said `hello@` and `care@` were not enrolled; it was wrong.

**Audit rows for products do not group by product.** `0014` says record_id is
replaced with the entity id "so every entry for one product groups together". It
is not happening: `Cotton` has 40 audit rows across **5 distinct record_ids**,
several of which are version ids, and `Mul Cotton` has no row whose record_id is a
product id at all. So tracing one product's history by id silently misses rows.

**The cause is not diagnosed.** It may be an older logger version behind some
rows, or a path where `product_id` was absent from the row. Recorded here as an
observation with its evidence rather than as a fix, because guessing at the reason
in a log entry is how the next person inherits a wrong explanation.

**Customer Style was schema only when this correction was written.** It is not
any more — the section below was rewritten on 10 Aug 2026, after #102–#105
merged and deployed. The paragraph above stands as what was true at the time.

### Customer Style — built and live, waiting on its first photograph

Shipped 10 Aug 2026 in four stacked PRs, merged in order and each deployed green:

| PR | Part | What it added |
|---|---|---|
| #102 | foundations | `style-photos` bucket + per-user folder policy, `photo_width`/`photo_height`, `rejection_emailed_at` (`0052`), the shared media layer (`lib/styleMedia.ts`, `lib/stylePhoto.ts`) |
| #103 | submission form | `StyleSubmissionForm` + `ShareYourStyle`, client-side downscale and HEIC→JPEG, `resubmit_style()` (`0053`) |
| #104 | moderation queue | `/admin/dashboard/style`, `admin_style_submissions()` (`0054`), rejection email + `POST /api/admin/style/reject` |
| #105 | public gallery | `/in/customer-style`, `StyleCard`/`StyleGallery`, per-product section on `ProductDetail`, footer link |

**Where the entry point is, because it is not where people look for it.** There
is no public "submit" URL, by design. "Share your style" appears on
`/in/account/orders` — signed in, on an order whose status is **`delivered`**, as
a button on each product line. The database refuses a submission from somebody
who has not received that piece (`has_purchased()`), so a button anywhere else
would be the form promising what the database then refuses. The only publicly
linked page is the gallery, from the footer's Explore column.

`select count(*) from style_submissions` → **0**. Nothing has been submitted yet
— but the reason has changed: there is now a way to submit and nobody has used it,
where before there was no way at all. The gallery is therefore showing its empty
state, which is a designed state rather than a broken grid.

**The queue needs checking on a rhythm, not when it occurs to somebody.** This is
the first public surface on the site whose content is written by people outside
the business, and approval is the only thing between a submitted photograph and
the storefront. Nothing notifies anybody that something is pending — there is no
alert, no digest, no badge. A submission sits in `/admin/dashboard/style` until a
human opens that page.

**The decision that was open here is closed.** `0047` had `reject_reason` as
*"Internal. The customer is not told why."* `0052` supersedes that comment in the
schema itself: the reason is now written in words the customer reads, and a null
reason means a silent rejection, which is what spam gets. The change of mind is
recorded where the column is defined rather than only here.

**Not yet done by a human:** no submission has been made, so the full path —
submit → pending → approve → gallery, and separately a turn-down email as a
customer receives it — has not been walked end to end on production.

### Verified data state

| | |
|---|---|
| Orders | 1 — the 14:26 one, cancelled and credited |
| Credit notes | 1 — `CN-2026-0008` |
| Stock movements with reason `sale` | **0** |
| Products | 4, all four costed (`products_without_cost: 0`) |
| Products written up (brand knowledge) | **0** of 4 |
| Products with sizes | 1 of 4 (2 size rows) |
| Style submissions | 0 |
| Reviews · Expenses | 0 · 0 |
| Customer accounts · admins | 4 · 3 (all three with MFA) |
| Publish queue | empty — no pending product, category or journal drafts |
| Ask Wovenne | **off** |

### Still inert, and known to be

**WhatsApp** — `parseInbound()` returns null and `sendReply()` is a no-op; four
TODOs. The shared core is ready and runs the same tool loop the widget does, so
this is a provider and a template approval away, not a rebuild.

**Shiprocket** — verified: the string "shiprocket" appears nowhere in `app/`,
`lib/` or `components/`. Dispatch is typed by hand.

**Guest order tracking** — a guest gets no order tool at all, by decision in #100.
There is no way to identify whose orders are whose without a session.

---

## Collection / Category Discovery — PR #128, merged 12 August 2026

`/in/shop` no longer sends the complete catalogue to a client component and asks
the phone to hide non-matches. Filter state belongs to the URL, the server reads
that state, and Postgres/PostgREST returns the matching catalogue rows. A filtered
view therefore survives refresh, browser history and sharing while ProductGrid
and ProductCard remain the rendering architecture.

The URL contract accepts category, fabric, colour, size and maximum price in a
fixed write order. Fabric, colour and size values are literal, case-insensitive
values with surrounding whitespace ignored; `%`, `_` and backslash are not
pattern language. This deterministic parameter writing is not a complete
faceted-navigation canonical/noindex policy — that remains separate SEO work.

**Preview and public reads stay separate.** Public queries use the anonymous
client and published rows only. An authorised Preview request is never cached;
it collapses each published/draft pair to the effective version before applying
category, fabric, colour, price, active-state or size filters. A superseding
draft that stops matching cannot leave its published version visible, and draft
gallery changes remain confined to Preview.

The public catalogue result, catalogue-wide fabric/colour facets, category tree
and displayed-product size support reads use 60-second query-level caching.
Preview bypasses all four caches. The listing order is deterministic before
pagination arrives: `created_at DESC, product_id ASC`.

Product cards now receive a dedicated `ProductListing` payload rather than the
richer product-detail shape. It retains the cover, full ordered card gallery,
price and discount window, category path and stock state, while omitting
description, video, fabric, colour and collection fields that the card does not
render. A read-only measurement against the four-product catalogue reduced the
unfiltered serialised listing from **3,906 bytes to 3,142 bytes** (19.6%).

**Verification:** 100/100 catalogue assertions passed: 26 URL-contract, 42 pure
4/40/400 fixture-scale, 17 effective-version/literal-value and 15 production-query
orchestration assertions. The whole repository TypeScript test-script suite,
standalone TypeScript, ESLint and the 88-page production build passed again on
merged `main`. The owner verified `/in/shop` on the Vercel Preview using an
iPhone: load, drawer open/close, category filtering, switching categories and
product card/image rendering. No migration or production test data was added.

**The scale fixtures are not PostgreSQL performance benchmarks.** They establish
pure filtering, URL, facet and result-payload properties at 4, 40 and 400
generated rows; they do not measure planner choices, indexes or database latency.

### Remaining limitations

- Real PostgreSQL scale testing against representative catalogue data remains.
- Size and attribute filters currently pass matching product-id sets into the
  final listing query; revisit if those sets become materially large.
- Pagination is not implemented, although ordering is now ready for it.
- Full faceted-navigation canonical/noindex policy remains future SEO work.
- Sub-category routes retain their existing client-side filtering; #128 changes
  `/in/shop` only.
