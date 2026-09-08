# Ask Wovenne — AI Engineering Study Guide

> **Security correction — 8 September 2026:** This document is preserved as historical learning material. Its original order-boundary assertions tested an executor supplied with trusted emails; they did not prove request authentication. A later route-level regression reproduced unauthorized order access through the `body.email` fallback. The feature-branch fix removes that fallback and fails closed on authentication errors. See [the security validation and preservation record](../security/ask-wovenne-order-boundary.md) for current evidence and limitations. Historical production settings, spend figures, and test counts below are not current verification; real Supabase/PostgREST proof remains outstanding.

*Companion notes to the audiobook. Written 30 August 2026, checked against the live repository and production database.*

---

## How to use this

Listen to a chapter, then read its row here. The audiobook teaches; this reminds. The self-test at the end is the part that actually moves knowledge into memory — do it from recall, not by re-reading.

---

## Verified baseline (checked, not assumed)

| Fact | Value |
|---|---|
| `main` / production | `347a414c…` |
| Ask Wovenne feature flag | **`false`** (off) |
| Anthropic calls to date | **0** |
| Anthropic spend to date | **$0.00** |
| Model configured | `claude-sonnet-5` |
| Tools | 5 — `search_products`, `get_product_details`, `check_availability`, `search_brand_knowledge`, `get_my_order` |
| Loop bound | 4 tool rounds + 1 forced tool-free round = 5 model calls max |
| Request ceiling | $0.06 · 60,000 tokens · 5 model calls |
| Daily ceiling | $5.00 (concierge only — see Ch. 37) |
| Eval ceiling | $2.00/run · 50 cases |
| Rate limit | 10/hr anonymous · 40/hr signed-in |
| Offline evaluator | 38/38 cases · 88/88 checks · 7/7 hard gates |
| Grounding suite | 127 assertions |
| Live-eval safety suite | 120 assertions |
| Order-boundary suite | 95 assertions |
| Products | 34 — **7 with descriptions** |

---

## Chapter summaries

**1 — What we're building.** Wovenne is a handloom shop; Ask Wovenne is its AI concierge. An LLM predicts text well enough to converse. An API is how our code talks to Claude. Normal software is deterministic; LLM software is not. *Key question: would you hand a new employee the till on day one?*

**2 — Tool calling.** The model never touches the database. It proposes a tool and arguments; our executor decides and returns a result. **The AI requests an action. The application decides whether and how that action happens.**

**3 — Is it an agent?** Ladder: chatbot → workflow → tool-using LLM → agent → multi-agent. Ask Wovenne is a *bounded tool-using LLM*. More autonomy ≠ better engineering.

**4 — Model vs application control.** Treat model output as untrusted input. Model controls **content**; code controls **authority**. Vocabulary: control plane, trust boundary, least privilege.

**5 — Phase 1 safety.** Feature flag, kill switch, rate limit, loop bounds, budgets, tracing. **Deployed ≠ enabled.**

**6 — Tokens and cost.** Tokens are text chunks; input and output are billed separately. Context is resent every call and grows each round. Measure, don't guess.

**7 — Request budget.** $0.06/message. **A safety ceiling, not an expected price.** Checked *before* each call. Unreadable usage charged a conservative estimate, never zero.

**8 — Daily budget.** Per-request caps don't bound the total. $5/day, in the database. Reserve-then-reconcile, like a hotel card hold. Orphans charged in full.

**9 — Concurrency.** Two requests at $4.94 of $5.00 both wanting $0.06. Naive check-then-act lets both through. Fix: one atomic guarded write. Proven with two real Postgres connections.

**10 — Observability.** Logs, metrics, traces. One structured trace per request, opened *before* anything can refuse. No PII — enforced by API surface, not redaction.

**11 — AI evaluation.** Unit tests compare outputs; evals measure properties. Vocabulary: eval, case, fixture, grader, score, hard gate, baseline, regression. **"It looked good when I tried it" is a demo, not evaluation.**

**12 — Scripted provider.** An actor following a script, not a trainee. Real loop, real tools, real budget; only the model substituted. 38/38 passing **proves plumbing, not model accuracy.**

**13 — Failure handling.** Fail open vs fail closed. Security and money fail closed. "Found nothing" ≠ "broke".

**14 — Live-eval safety.** Found a real bug: `spent < cap` admits a case that can exceed the cap. Fix: `spent + worst-case next ≤ cap` (pre-flight admission).

**15 — Floating point.** `0.54 + 0.06` = `0.6000000000000001`. Would wrongly *refuse* a legitimate case. Fix: integer micro-dollars. **Money is counted, not measured.**

**16 — Three guards.** `--live` + `AI_EVAL_LIVE=true` + explicit `--max-spend-usd` (no default). Defence in depth. At 2.5A, even all three cannot spend — no provider exists. Verified with all network primitives trapped: **0 attempts**.

**17 — Hallucination and grounding.** A hallucination sounds exactly like a fact. Supported / contradicted / invented. Wrong price is bad; invented certification is a false commercial claim; invented care instructions can ruin a garment.

**18 — Structured attribution.** Ten claim families. Four verdicts. **Three states of knowledge** — known / known-absent / not-checked. Only known-absent makes invention critical.

**19 — Hard gates.** Four correct facts cannot pay for one fabrication. Zero critical failures, no averaging. Averages hide zero-tolerance failures.

**20 — False positives and negation.** "We cannot confirm GOTS certification" must not read as a claim. Epistemic restraint must be **free**. Blind spots documented in the code.

**21 — AuthN vs AuthZ.** Who are you / what may you access. Hotel key card: proves identity, opens only your room.

**22 — Order boundary.** Session email is trusted and passed as a *separate argument* from model input. Tool not offered without a session. Schema has no identity field.

**23 — Service role and RLS.** Service role **bypasses RLS**. So the boundary is **one application-level filter** — `.eq("customer_email", trustedEmail)`. That line is a security control, not a query convenience.

**24 — Alice and Bob.** Both happy paths, both attack directions, 14 reference manipulations, 7 identity-smuggling attempts. 95 assertions. The refusal echoes the caller's own input — that's reflection, not disclosure, and proven not to be an existence oracle.

**25 — Test fidelity.** Real executor, real client, real HTTP — **simulated PostgREST and Postgres**. Application boundary strongly demonstrated; full integration **not proven**. **A passing test only proves what it actually exercised.**

**26 — Why not just install things.** No container runtime, no Homebrew, no Postgres on this machine. conda's `postgrest` turned out to be a Python *client*, not the server — matching a name is not identifying a thing. The lighter path would mean hand-building the auth model we're supposed to be verifying.

**27 — Two layers.** Fast test catches regressions in *our* code, constantly. High-fidelity test answers a question asked once. Keep both. Layer 2 must fail loudly, never skip quietly.

**28 — Prompt injection.** Direct (user types it) and indirect (hidden in tool results). **You don't solve it with prompt wording — you make a fully persuaded model harmless.**

**29 — Canary cases.** 10 cases, 6 critical. Written and proven offline before costing anything.

**30 — Testing the test.** Mutation testing across all 9 claim families, plus the grader logic itself. The harness once reported "32/32 passed" while 6 cases never ran — every number true, the report still a lie.

**31 — Reporting.** Model quality separate from operational quality. p50 / p95 explained; percentiles need sample sizes. Offline and live scores never merged.

**32 — Real Claude.** Provider abstraction is the socket. SDK retries default to 2 — distorts cost, latency and failure measurement. Eval client must use `maxRetries: 0`; production keeps retries.

**33 — First paid canary.** 10 cases, $0.60 cap = the maximum, not a forecast. Blast radius, progressive rollout. No automatic retries.

**34 — Stochastic behaviour.** One sample is an anecdote. Sample size, variance, reliability.

**35 — Why not RAG.** 34 products fit in context. **Don't add architecture because it's fashionable — add it when evaluation shows need.**

**36 — Content.** 7 of 34 products have descriptions. No model can retrieve what was never written. Writing 27 descriptions would improve this system more than any model change.

**37 — Admin insights.** A second Anthropic surface, outside the concierge budgets. $5/day is the *concierge* ceiling, not project-wide. **More than one AI feature means you need an inventory.**

**38 — Activation gates.** Engineering, model quality, grounding, content, operations — then the flag. Flag last, always.

**39 — Competencies.** Twenty, each tied to a concrete artefact.

**40 — Interview practice.** Honest answers. Never claim real-model accuracy.

---

## Terminology

**LLM** · large language model — predicts text, well enough to converse.
**API** · how one program asks another to do something.
**Token** · a chunk of text; billing unit. ~100 tokens ≈ 75 words.
**Context** · everything sent to the model on one call; resent every time.
**System prompt** · standing instructions sent with every call.
**Deterministic** · same input, same output, always.
**Stochastic** · involves randomness. LLMs are stochastic.
**Tool calling** · model proposes an action; application executes it.
**Executor** · the code that runs a tool the model asked for.
**Agent** · model plans multiple steps toward a goal with autonomy.
**Trust boundary** · where data stops being trusted and gets checked.
**Control plane** · the part deciding permissions, limits, configuration.
**Least privilege** · minimum access necessary.
**Feature flag** · runtime switch, no redeploy.
**Kill switch** · a flag used to stop something fast.
**Rate limit** · cap on requests per identity per period.
**Fail open / fail closed** · on breakage, allow / refuse.
**Race condition** · outcome depends on which concurrent operation wins.
**Check-then-act** · reading a value then acting on it; unsafe under concurrency.
**Atomic** · indivisible; happens completely or not at all.
**Observability** · ability to understand a system from its outputs.
**Trace** · record of one operation end to end.
**Latency** · time taken. p50 = median; p95 = slowest 5% boundary.
**PII** · personally identifiable information.
**Hallucination** · confident statement unsupported by evidence.
**Grounding** · is this claim supported by available evidence?
**Eval** · measurement of AI behaviour against defined situations.
**Fixture** · fake data set up for a test.
**Grader** · code that decides whether a response was acceptable.
**Hard gate** · pass/fail check with no averaging.
**Baseline** · recorded current performance.
**Regression** · something that used to work stopped working.
**Mutation testing** · deliberately break something to prove the test notices.
**Provider** · whatever answers a model call; swappable.
**Prompt injection** · text that tries to become instructions. Direct or indirect.
**Authentication** · who are you.
**Authorization** · what may you access.
**RLS** · row level security — the database filters rows per user.
**Service role** · admin database credential; **bypasses RLS**.
**PostgREST** · turns database tables into an HTTP API.
**Canary** · small deliberately-limited first run.
**Blast radius** · how much damage a mistake could cause.
**RAG** · retrieval-augmented generation — search documents, add to prompt.
**Embedding** · text as numbers, so similar meanings sit close together.

---

## Key Wovenne examples (memorise these — they're your interview material)

| Concept | The concrete example |
|---|---|
| Tool calling | 5 tools; model proposes, executor decides |
| Bounded loop | 4 rounds + 1 forced tool-free = 5 calls max |
| Trust boundary | `runOrderTool(trustedEmail, modelInput)` — two separate arguments |
| Request budget | $0.06, checked before each call |
| Daily budget | $5/day, reserve-then-reconcile |
| Race condition | $4.94 committed, two × $0.06, exactly one wins |
| Float bug | `0.54 + 0.06 > 0.6` would refuse a legitimate case |
| Fail closed | Rate limiter reversed from open to closed |
| Miss vs failure | "No running shoes" ≠ "search crashed" |
| Hallucination | ₹3,200 supported · ₹4,000 contradicted · GOTS invented |
| Three knowledge states | known / known-absent / not-checked |
| Hard gate | 4 correct facts + 1 invented certification = FAIL |
| Negation | "We cannot confirm GOTS certification" → no claim |
| Authorization | Alice cannot reach Bob's orders, 95 assertions |
| RLS reality | Service role bypasses RLS; one `.eq()` is the control |
| Test fidelity | Simulated PostgREST — boundary shown, integration unproven |
| Truncation bug | "32/32 passed" while 6 cases never ran |
| Three guards | flag + env var + explicit cap, no default |
| Why not RAG | 34 products fit in context |
| Content gap | 7 of 34 have descriptions |

---

## Interview points

- Lead with **the controls**, not the integration. Connecting Claude was a third of the work.
- Say **"deployed but not enabled"** — it shows you understand production risk.
- Never claim model accuracy. Say: *"deterministic evaluation passes completely; live model quality isn't measured yet."*
- Be precise about ceilings: **$0.06 is a limit, not a price.**
- Volunteer a limitation before you're asked. The simulated-PostgREST admission is a *strength* in an interview.
- Explain a bug you found in your **own** code (the `spent < cap` overshoot). Self-caught bugs demonstrate rigour.
- The float/money answer is a strong general-engineering signal, not just AI.
- "We chose not to add RAG, and here's the evidence threshold that would change that" beats any list of technologies.

---

## Things Tom should understand before moving on

1. **The difference between deployed and enabled**, and why the flag is the last step — not the first.
2. **Why the model is untrusted input.** If this isn't instinctive yet, re-listen to Chapter 4. Everything else follows from it.
3. **Check-then-act and why atomicity matters.** You will meet this outside AI, constantly.
4. **That $0.06 and $5.00 are ceilings, not forecasts.** Never quote them as costs.
5. **The three states of knowledge.** This is the most transferable evaluation-design idea in the project.
6. **That a passing test only proves what it exercised.** Specifically: the order boundary is demonstrated at the application layer and *not* proven end-to-end through a real database.
7. **That the order boundary rests on one line of code**, because service role bypasses RLS. If anyone edits `runOrderTool`, that filter is the thing to protect.
8. **That $5/day is the concierge ceiling, not project-wide** — admin insights spends outside it.
9. **That the binding constraint on going live is content**, not engineering. 7 of 34.
10. **That a real API key already sits in production.** The system is one boolean from live. Safety comes from the checklist, not from difficulty.

---

## 20 self-test questions

1. What's the difference between deterministic software and LLM-powered software?
2. Why shouldn't the model have direct database access? State the one-line principle.
3. Where does Ask Wovenne sit on the autonomy ladder, and why not higher?
4. Name three things the model may control and three it must never control.
5. What's the difference between *deployed* and *enabled*, and why does it matter?
6. Why does a 5-round conversation cost more than 5× a 1-round conversation?
7. Is $0.06 the expected cost of a message? Explain.
8. Why isn't a per-request budget sufficient on its own?
9. Explain the $4.94 race condition and how it's fixed.
10. Why is `spent < cap` insufficient before starting an eval case?
11. Why is money stored as integer micro-dollars?
12. Name the three live-eval guards. Why is there no default spend cap?
13. What are the three states of knowledge in grounding, and why does the third exist?
14. Four claims correct, one certification invented. Pass or fail? Why?
15. Why must "We cannot confirm GOTS certification" not be treated as a claim?
16. What's the difference between authentication and authorization?
17. Does row level security protect the order tool? Explain precisely.
18. What did the 95-assertion order test prove — and what did it *not* prove?
19. Why isn't Wovenne using RAG?
20. Why is the feature flag the last activation step rather than the first?

---

## Answers

**1.** Deterministic software gives the same output for the same input, every time — testable by comparing to an expected value. An LLM may give different, equally valid answers, and may state something false with complete fluency. So it needs *evaluation* against properties rather than tests against fixed strings.

**2.** Because anything that can trick the model could then reach the data, and models can be tricked. **The AI requests an action; the application decides whether and how that action happens.**

**3.** A *bounded tool-using LLM* — it chooses tools within a loop our code controls (4 rounds + 1 tool-free = 5 calls max). Higher autonomy wasn't needed: the task is answering questions about 34 products. Autonomous systems are harder to bound, budget, test and explain, and more autonomy isn't automatically better engineering.

**4.** May control: which tool to request, search terms, the product slug, the quoted order reference, the wording of the answer. Must never control: the customer's identity, whether the feature is on, how much may be spent, how many loop rounds run, whether a privileged tool is offered.

**5.** Deployed = the code is on production servers. Enabled = customers can reach it. Ask Wovenne is deployed and off. That gap is where all safety work happens — you build and test guardrails against real infrastructure before anyone can be harmed.

**6.** The model has no memory between calls, so the entire context is resent every round — system prompt, catalogue, tool definitions, conversation, and all previous tool results. The bundle grows each round, and you pay for the whole bundle each time.

**7.** No. It's a **safety ceiling**: no message may cost more than that. A typical message costs a small fraction. Confusing a limit with an estimate leads to bad decisions.

**8.** Because many individually-compliant requests still add up. 10,000 messages at $0.06 is $600 with no rule broken. **A limit on each thing is not a limit on all the things.**

**9.** At $4.94 of a $5.00 cap, two requests each want $0.06. Both read $4.94, both conclude there's room, both write — total $5.06. The read and the write are separate, and something changes in between (check-then-act). Fixed by making it one atomic guarded database write: add the amount *only if* the result stays within the cap. Proven with two real Postgres connections — exactly one succeeded.

**10.** It asks "have we already overspent?" rather than "could this next case overspend?". At $0.47 of a $0.50 cap it passes, but the case may cost $0.06 → $0.53. Correct rule: `spent + worst-case next cost ≤ cap`, checked before starting.

**11.** Floating point can't represent most decimal fractions exactly. `0.54 + 0.06` evaluates to `0.6000000000000001`, so a naive comparison would **refuse** a case that a $0.60 cap plainly permits — wrong at exactly the boundary where it's asked the hardest question. Integers make it exact. Money is counted, not measured.

**12.** `--live` (intent at invocation), `AI_EVAL_LIVE=true` (environment authorisation, that exact string), and `--max-spend-usd <n>` (explicit cap). No default because a default is a decision nobody made — the whole point is that a human chose a number and typed it.

**13.** Known fact / known to be absent / not checked by the evaluator. The third exists so gaps in our own test coverage don't get reported as the assistant lying. Only *known-absent* makes an invented claim critical. Without that distinction the grader would cry wolf and get switched off.

**14.** **Fail.** Correct claims aren't currency — you can't buy your way out of a fabrication with true statements. The four correct facts came straight from the database; the invented certification is a false commercial claim. Grounding is a hard gate at zero critical failures, not an average.

**15.** Because it's the assistant being honest about not knowing — exactly the behaviour we want. Flagging it would penalise honesty and train the opposite. Negation and hedging are detected per sentence before any extractor runs. Epistemic restraint must be free.

**16.** Authentication = *who are you* (session cookie verified by Supabase). Authorization = *what may you access* (this customer's orders and no one else's). Hotel: checking in proves identity; the key card opens only your room.

**17.** **No.** The order tool uses the service-role client, which bypasses RLS entirely — the code says so explicitly. The boundary is **one application-level filter**, `.eq("customer_email", trustedEmail)`. That line is the security control, and the test asserts there is exactly one of them.

**18.** **Proved:** our code scopes every query by the trusted email (27/27 captured requests carried it), and the model-supplied reference never reaches the database at all — it narrows in memory afterwards. Cross-customer attacks fail in both directions; identity smuggling fails. **Not proved:** that real PostgREST and real PostgreSQL apply that filter correctly — the database was simulated. A passing test only proves what it exercised.

**19.** 34 products fit entirely in the context window, so there's nothing to retrieve. Embeddings and a vector database would add a service, failure modes, cost and a sync pipeline to solve a problem we don't have. Add it when evaluation evidence shows retrieval failures — not because it's fashionable.

**20.** Because the flag is the only thing between an unproven system and real customers. Everything else — code, budgets, evaluation, observability — can be built, deployed and tested while it's off. Once it's on, every remaining mistake reaches someone who came to buy a saree.
