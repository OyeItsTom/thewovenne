# THE WOVENNE — project status log

Last updated: 3 August 2026

---

## Session summary

Everything below is built, merged to `main`, and deployed. Migrations `0024`–`0032`
were applied to Supabase during this session.

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

**Recommendation:** one test-mode purchase, watched from the admin. It would
close all nine at once.

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
| Carts | 0 |
| Loyalty ledger | 0 |
| Admins | 3, all with MFA enrolled |

Analytics, segmentation and marketing will all correctly report **empty**. That
is the honest state, not a fault — but it means a working feature and a broken
one currently look identical on screen.

---

## Outstanding, owner action

- **Razorpay test purchase** — above
- **`ANTHROPIC_API_KEY` in `.env.local`** — production has it; local dev doesn't
- **Product sizes** — none set, so no Size filter appears anywhere
- **Shipping config** — seeded Kerala free / ₹120 / free over ₹3,000; confirm
  these are the real numbers
- **Loyalty** — switch on when ready; rates are editable
- **Partners' first login** — `hello@` and `care@` still show `MFA: not enrolled`
