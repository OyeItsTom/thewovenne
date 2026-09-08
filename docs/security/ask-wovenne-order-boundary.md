# Ask Wovenne order authorization: validation and preservation

Inspection and validation: 8 September 2026. Work stays on
`feat/ask-wovenne-order-boundary-proof`; no deployment or push is included.

## Starting state and preservation scope

The feature branch, local main and cached origin/main all pointed to `347a414`
(PR #145). There were no staged/tracked changes or stashes. The two order-boundary
scripts and three learning documents were untracked. They are intentional work,
not build output. Preserve the learning documents as historical material with the
security correction at their start. `.agents/` contains unrelated development
skills/data/Python sources plus three generated `__pycache__/*.pyc` files; all of
it is deliberately excluded from these commits. No intentional files are deleted.

Foundation, offline evals, live-eval safety and grounding were already merged
through PRs #142–145. This stage adds application authorization regression evidence;
it does not complete the originally intended real-database boundary proof.

## Finding and architecture

The real route previously passed `email: verifiedEmail ?? body.email` into
`streamChat`. The following path is present when chat configuration, the server
feature switch and quota/budget gates allow a request:

1. `POST /api/chat` parses caller-controlled JSON, including an email and order ID.
2. `createRSCClient()` reads cookies; `auth.getUser()` asks the authentication
   service to validate the user. `verifiedEmail` is null for missing identity or
   a thrown session read. Previously a returned authentication error was ignored.
3. The nullish fallback promoted the request-body email into `opts.email`.
4. `chatToolsFor(opts.email)` offered `get_my_order` whenever that email was truthy.
5. The dispatcher called the real `runOrderTool(opts.email, call.input)`.
6. The service-role query bypassed RLS and filtered `orders.customer_email` by
   the supplied identity; the reference was then matched within those rows.
7. Private item/status/total/tracking data reached the model in tool results.
   The older `lookupOrder(orderId, email)` also preloaded order details into the
   system prompt if a caller supplied the matching full order ID and email.

Thus email equality gave isolation only relative to an argument the guest could
choose. No full order ID was needed for the privileged tool: it could list recent
orders. A valid Alice session took precedence over a supplied Bob email, but that
did not protect guests, failed sessions, or sessions with no email.

The intended architecture is established by the session-only comments beside
`MY_ORDER_TOOL`, `scripts/order-tool.test.ts`, and the server route's authentication
comments. The fallback comment described a possible future WhatsApp path. The
actual WhatsApp webhook calls `streamChat(parsed.messages)` without an identity.
There is no implemented trusted guest-order identity channel to preserve here.

## Security invariant and minimal correction

Privileged customer/order access derives identity only from authenticated
server-side context. Caller-controlled request fields and model tool arguments
may select among that customer's orders, never choose the customer.

- **Authentication:** use `auth.getUser()`, accept a user only without an auth
  error, and normalize the returned email. Missing/blank email remains null.
- **Authorization:** the route passes only that verified email to both order paths.
- **Tool eligibility:** guests get public tools only. Forced guest order-tool calls
  are refused by the existing dispatcher/public-tool implementation.
- **Customer isolation:** signed-in Alice cannot access Bob via request fields,
  tool fields, short reference, or full order ID.
- **Data filtering:** the existing service-role email filter is retained, as is
  the exact ID filter for legacy preload and the 20-row tool query limit.

The production correction is confined to `app/api/chat/route.ts`, with a trusted
identity contract comment in `lib/chat.ts`. Public guest chat and the identity-free
WhatsApp path remain available. No broad auth redesign or payment work is included.

## Test design and before/after evidence

`ai-chat-authorization.test.ts` executes the real POST handler, chat loop,
privileged dispatcher, both order executors and installed Supabase JS client.
It substitutes authentication service responses, public catalogue/settings,
quota/reservation services and the model. The route's identity resolution is not
reimplemented. A scripted model deliberately asks for the privileged tool even
when it was not offered. Synthetic Alice/Bob rows are served over loopback HTTP.
Assertions inspect tool eligibility, every order query, preloaded system context,
and tool-result context. Positive controls require real own-order retrieval,
including legacy preload. Guests must cause zero order queries and still receive
public chat output.

Before changing the production code, the initial 11-case suite exited 1:
**5 passed, 6 failed, zero external fetch attempts**. Selected synthetic diagnostics:

```text
Guest supplying Bob email: order_queries=1, Bob_private_data_in_model=true
Guest supplying Bob email and full order ID: order_queries=2, Bob_private_data_in_model=true
Rejected authentication plus body email: order_queries=1, Bob_private_data_in_model=true
Thrown authentication plus body email: order_queries=1, Bob_private_data_in_model=true
Session without email plus body email: order_queries=1, Bob_private_data_in_model=true
```

The sixth failure tested fail-closed behavior for an authentication response that
contains both a user and an error. This is a defensive failure-mode test, not a
claim that the real authentication provider normally returns that combination.

The final suite also covers blank session email, ordinary public guest chat and
normalized authenticated email. The retained test will fail if the body-email
fallback is reintroduced. Raw local diagnostics are in `/tmp/wovenne-auth-before.log`
and `/tmp/wovenne-auth-after.log`; the essential evidence is recorded here because
temporary logs are not durable repository artifacts.

The original executor test's source-pattern assertion explicitly accepted
`verifiedEmail ?? body.email`. It supplied trusted emails directly and therefore
could pass while the request boundary was vulnerable. That assertion now requires
session-only routing, but the behavioral route suite is the primary evidence.
The executor suite retains malformed references, identity smuggling, symmetric
customer isolation, query scoping, error handling and repeatability assertions.

## Verification

Commands used the already cached tsx 4.23.11 installation, without changing the
package manifest/lockfile or downloading a runner. Portable equivalents follow:

| Command | Result |
| --- | --- |
| `npx tsx scripts/ai-chat-authorization.test.ts` | 14 cases passed, zero external fetch attempts |
| `npx tsx scripts/ai-order-boundary.integration.test.ts` | 101 assertions passed |
| `npx tsx scripts/ai-eval.ts` | 38/38 cases, 88/88 checks, all 7 hard gates passed |
| `npx tsx scripts/ai-grounding.test.ts` | 127 assertions passed |
| `npx tsx scripts/ai-eval-live.test.ts` | 120 assertions passed |
| `npx tsx scripts/ai-daily-spend.test.ts` | 141 assertions passed (model/structural suite) |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | Passed |
| `npm run lint -- --file app/api/chat/route.ts --file lib/chat.ts --file scripts/ai-chat-authorization.test.ts --file scripts/ai-order-boundary.integration.test.ts --file scripts/localSupabaseHarness.ts` | Passed |

The existing `order-tool.test.ts` loads `.env.local`, queries the real database,
and prints customer information. It was deliberately not run. Its authorization
and own-order scenarios are covered with synthetic data here. Other older live
catalogue/loop tests that load production credentials were also not run. No live
model, production auth/data service, database migration or deployment was used.

## Limits and remaining work

The local harness is a partial PostgREST simulation, not PostgreSQL/PostgREST.
It now applies case-sensitive email equality, ID equality, selected columns and
single-row responses for the queries used here. It does not validate real SQL,
schema types, role grants, RLS, cookie/token verification or deployed routing.
Authentication outcomes are injected; real Supabase authentication is not tested.
Real-model response quality and production feature/configuration state are unverified.

The fetch guard permits literal loopback HTTP(S) only, refuses embedded URL
credentials and the unspecified address, and rejects redirects. Tests explicitly
exercise external-target and local-redirect rejection. This guard is not an OS
network sandbox and does not intercept arbitrary raw sockets, node:http clients
or subprocesses. The test's order server binds to 127.0.0.1 and uses only invented
rows and fake keys. No fixtures persist in a database. Scripted trace cost values
are simulated usage, not actual Anthropic charges.

A real isolated Supabase/PostgREST test remains required before claiming complete
backend security proof. The local fix is not deployed; production remediation and
feature-state verification are separate tasks. Preserve that distinction.

## Next task: read-only Razorpay review

The preserved branch `fix/payment-settlement-idempotency` points to `37fbad7`.
It is not an ancestor of the inspected main; `git cherry main
fix/payment-settlement-idempotency` reports it as a non-equivalent patch. It
contains webhook handling, shared settlement logic, two test scripts and migration
0058. Review it read-only with `git show`/`git diff` before designing overlapping
payment work. Do not switch branches, merge or implement payment changes as part
of this stage. No remote freshness or deployed payment state was verified.
