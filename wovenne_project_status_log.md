# THE WOVENNE — project status log

Last updated: 4 August 2026 (fourth session)

---

## Session summary

Everything below is built, merged to `main`, and migrations `0024`–`0036` are
applied to Supabase and verified.

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

## Outstanding, owner action

- **Razorpay test purchase** — above
- **Product sizes** — none set, so no Size filter appears anywhere
- **Shipping config** — seeded Kerala free / ₹120 / free over ₹3,000; confirm
  these are the real numbers
- **Loyalty** — switch on when ready; rates are editable
- **Partners' first login** — `hello@` and `care@` still show `MFA: not enrolled`
- **T&C wording** — `/policies` holds placeholder content; edit it in the admin
- **Customer addresses** — BUILT. `0035` stores one saved address per
  customer, editable under Settings and pre-filled at checkout. It is
  deliberately one address rather than a book, and it cannot redirect an order
  already placed.
