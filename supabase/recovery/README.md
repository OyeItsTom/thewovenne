# Migration recovery: 0074, 0075, 0076

Guarded rollbacks for the three email-release migrations, and when **not** to use them.

| File | Purpose |
|---|---|
| `0076_rollback.sql` | Undo 0076 (style-rejection notices). Back to the 0075 state. |
| `0075_rollback.sql` | Undo 0075 (dispatch). Back to the 0074 state. |
| `0074_rollback.sql` | Undo 0074 (confirmation deliveries). Back to the 0073 state. |
| `../../scripts/run-recovery-sql.mjs` | The only way to run them. |
| `../../scripts/migration-recovery.test.ts` | Rehearsal on PostgreSQL 17.6. |

**These are not migrations:**
- Never run them with `scripts/run-migration.mjs`, which would record them in `schema_migrations`.
- Never paste them into the SQL editor.

Each one:
- is one transaction, fail-closed and self-checking;
- refuses unless the database is in exactly the state it expects;
- deletes its own ledger row, so the ledger stays truthful and the migration can be re-applied with the runner.

## First choose: roll back code, or the schema?

**Default: roll back the code and keep the migration.** All three were designed so that the previous application keeps working on top of them:

| Migration | Old code + migration kept |
|---|---|
| 0074 | The pre-R1 app never touches 0074's objects. Confirmations go out the old way, protected by `orders.confirmation_sent_at` (0058). Delivery rows stay as evidence; nothing sends them while #220 is not deployed (no worker, no `CRON_SECRET` effect). **Safe.** |
| 0075 | The pre-E3 Orders screen cannot mark orders shipped (the guard refuses direct updates), so **dispatch is unavailable**. Everything else works. Keep the dispatch freeze until the fixed E3 is deployed, or roll the schema back if still allowed. |
| 0076 | The pre-#223 reject route cannot turn anything down **with a reason**: `moderate_style` refuses it (`EXPLAINED_REJECTION_MOVED`, FU-6) before that route sends any email, so no duplicate is possible. **But** that route takes the public gallery copy down *before* the refused call: on an **approved** submission the picture breaks while the row stays published (recover: "Take it off", then "Put it on the site"). So keep the style-moderation freeze while old code runs. Silent rejections, take-offs and approvals work. |

Roll back a **schema** only when the schema itself is harmful **and** the script's guards allow it. In practice that means inside the migration window, before the feature is used.

## Order (always)
**Down:** 0076 → 0075 → 0074. **Up:** 0074 → 0075 → 0076.
- Each script refuses to run out of order (P2).
- 0076 has no technical dependency on 0074 or 0075, but only this order is rehearsed. So 0075 refuses while 0076 is applied, and 0074 refuses while 0075 **or** 0076 is applied.

## When each rollback refuses (and changes nothing)
| Script | Refuses when | Why |
|---|---|---|
| all | **P1:** its migration is not (fully) applied. **Lock:** the tables are busy for more than 5 s (`lock_timeout`). | Wrong state; never wait behind live traffic |
| 0076 | **R1:** any rejection notice recorded after 0076, in any status. **R2:** a backfilled notice no longer matches its submission. **R3:** any submission moderated after 0076 (`rejection_round` is history). **P2:** none. | Notification history and accepted/uncertain evidence must not be lost |
| 0075 | **P2:** 0076 applied. **R1:** any `shipment_notification` delivery row, in any status (pending, sending, accepted, uncertain, retryable, failed, expired). **R2:** a delivery row of unknown kind. | Shipping-email rows are dispatch and customer-communication evidence, and 0074's kind check cannot hold them |
| 0074 | **P2:** 0075 or 0076 applied. **R1:** **any** `order_email_deliveries` row, in any status. **R2:** `order_email_recovery_settings` does not hold exactly one row. | Each row is a customer communication or its intent, with the idempotency key that prevents a duplicate. Removing rows needs its own reviewed archive plan, never this script |

**What is kept:**
- **0075 rollback:** every order, including the `status`, `shipped_at`, `courier_name` and `awb_number` written by `dispatch_order`. These are 0024 columns the pre-E3 app reads and writes, so an in-person dispatch (no email row) stays fully represented.
- **0074 rollback:** every order, including `confirmation_sent_at` (the pre-R1 duplicate-send guard). The recovery cutoff `orphan_recovery_since` is printed as a NOTICE for the record. A re-apply sets a new cutoff, which only narrows automatic recovery and never emails older orders.
- **0076 rollback:** see the header of `0076_rollback.sql`. It restores 0052's customer UPDATE on `rejection_emailed_at`, the exact pre-0076 posture the old reject route needs. That is a known, documented trade-off.

## Procedure (each step needs the owner's approval)
**Preconditions:**
1. **Code rolled back:** Vercel Instant Rollback to the deployment noted in preflight, the one **without** the PR that needs the migration (#223 for 0076, #221 for 0075, #220 for 0074). It shows READY.
2. **Freeze in force:** the matching freeze (style moderation for 0076; dispatch for 0075).
3. **Backup:** a fresh backup and a verify-restore PASS, stored with its hash.
4. **Posture:** `npx tsx scripts/security-posture.ts --production` MATCHES the manifest of the state being left. If there is drift, stop and investigate.

**Run** (repo root; `SUPABASE_DB_URL` in `.env.local` names the target):
```
node scripts/run-recovery-sql.mjs supabase/recovery/0076_rollback.sql \
  --expect-host <exact database host> --i-have-a-verified-backup
```
The runner:
- refuses a host other than `--expect-host`, and refuses without the backup flag;
- never prints the connection string;
- rolls back on any error.

**Results:**
- **Success:** `ROLLED BACK 00xx`, with counts.
- **`REFUSED …`:** nothing changed. Fix forward. **Never edit a guard to force a rollback.**

**After:**
- **Ledger:** latest = the previous migration.
- **Posture:** `--production` MATCHES the previous state's manifest:
  - 0075 state: `git show f73c1d6:supabase/security-posture.json`;
  - 0074 state: `git show 04c230c:…`;
  - 0073 state: `git show 76aa2d8:…`.
- **Smoke test:** the previous app's behaviour works (turn down one test submission; mark a test order shipped directly; etc.).
- **Record:** time, operator, backup hash and output, in the release report.

## Fix-forward (whenever a rollback refuses, or after the window)
| Problem | Fix forward |
|---|---|
| A defect in a PR's **code** | Instant Rollback, keep the migration (table above), and deploy a hotfix PR. |
| A defect in a migration's **function** | A new forward migration (`create or replace` of that function only), harness-tested with the feature's own suite first. Records are kept. |
| A grant or guard blocks something | A forward migration granting the narrowest need to **service_role or a SECURITY DEFINER function**. Never widen anon or authenticated access to compensate. |
| Records must really go (rows in `order_email_deliveries` or `style_rejection_notices`) | Owner's written approval, then: (1) export the rows into the encrypted backup set and verify them; (2) a separately reviewed archive-and-delete script; (3) only then the rollback. Never automatic. |
| An uncertain, expired or interrupted email | Not a rollback case. Check Resend by provider id and time, and contact the customer manually if needed. Never resent automatically within the design's limits. |

## Evidence and limits
- **Rehearsal:** `scripts/migration-recovery.test.ts` (PG 17.6, embedded). It:
  - rolls back each migration safely to the clean previous state: catalog snapshot (columns, constraints, indexes, function definitions and ACLs, triggers, policies, RLS, table and column ACLs, comments) **and** `security-posture.ts` posture;
  - runs the full down chain to the 0073 manifest committed at `76aa2d8`;
  - re-applies the chain to a clean 0076 and to this checkout's manifest;
  - covers refusals in realistic states (pending, sending/leased, uncertain, retryable, accepted, failed/no-recipient and expired deliveries; dispatched shipping rows; notices in every status; concurrent dispatch, settlement and moderation; tampered settings; out-of-order and not-applied), each proving **nothing changed**.
- **It does not validate Production's actual state.** The preflight posture MATCH and the backup are what tie a real database to the rehearsed one.
- **Physical leftovers after a rollback:** dropped-column slots and new object OIDs on re-apply. Harmless.
- **On a checkout without 0074–0076,** the test reports SKIPPED (exit 2), never passed.
