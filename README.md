# Mandate Rescue

**An agent that saves subscriptions before they die.**

Razorpay AI Buildathon · Track 03 — AI Revenue Recovery

---

When a recurring charge fails, the mandate enters a countdown. A fixed number of attempts get spent on a fixed daily clock, and when they run out the subscription is `halted` — the mandate is dead, the missed cycles are never re-attempted, and winning that customer back requires fresh authorization.

The schedule is the same whether the customer was ₹200 short for a day or revoked the mandate outright.

**Mandate Rescue spends the same attempt budget on evidence instead of on a calendar.** It classifies why the charge failed, predicts when the customer's account is likely to have money, refuses to spend attempts that provably cannot succeed, and escalates to re-authorization while the mandate is still alive.

> ⚠️ **Status: in development.** No numbers are claimed yet. Every figure published here will carry its denominator and its provenance (real merchant / own live account / Razorpay test mode) in the same sentence.

---

## How it works

```
Razorpay (merchant account)
   │ webhooks                      ▲ API calls, server-side only
   ▼                               │
INGEST          raw event stored untouched, then normalized
   ▼
HEALTH SCORER   risk band per subscription, with score contributions
   ▼
AGENT (LLM)     proposes {action, reason, confidence}
   ▼
POLICY ENGINE   ALLOW / DENY / DEFER + rule_id   ← deterministic, pure, no network
   ▼
EXECUTOR        write-ahead intent, idempotency key, dry-run, kill switch
   ▼
AUDIT LOG       append-only, every decision, denials included
   ▼
DASHBOARD       read-only
```

**The agent proposes, the policy engine disposes.** The LLM never executes, never computes a rupee figure, and never overrides a bound. Its output is an untrusted suggestion that has to survive fourteen deterministic rules.

---

## What the rails actually allow

Four findings from the Razorpay and NPCI documentation shaped the design, and three of them are the opposite of the obvious assumption:

1. **The binding attempt budget is NPCI's, not Razorpay's.** A UPI Autopay mandate execution gets 1 original + at most 3 retries, then it is cancelled.
2. **A manual charge on an `issued` invoice does not consume Razorpay's subscription retry counter.** This is the lever the product stands on — a well-timed attempt is *additive* to the default schedule. It does not exempt us from the NPCI ceiling.
3. **Domestic card subscriptions cannot be manually charged at all.** Cards are observation-only; the actionable surface is UPI Autopay and e-mandate.
4. **Every recurring debit needs a pre-debit notification 24 hours ahead**, and the request is rejected between 23:50 and midnight IST for a next-day debit. So "retry now" is not an action that exists. Every retry is scheduled, and NPCI additionally pushes execution out of peak UPI hours (10:00–13:00 and 17:00–21:30 IST).

Points 3 and 4 became policy rules the first draft of the spec did not have: `R-METHOD`, `R-PDN`, and `R-WINDOW`.

---

## The bounds

Every proposal is checked against every rule. First DENY wins, and the verdict carries the `rule_id` that produced it. Denials are written to the audit log as loudly as approvals.

| `rule_id` | Refuses to… |
|---|---|
| `R-KILL` | act at all while the global kill switch is engaged |
| `R-CONSENT` | take any write action for a merchant with `write_enabled = false` |
| `R-HALT` | attempt against a halted, cancelled, completed or expired subscription |
| `R-EXPIRY` | attempt against a mandate that expires before the attempt would land |
| `R-HARD` | retry after a hard decline — but *does* allow re-auth outreach after a dead instrument |
| `R-METHOD` | retry a domestic card, or an amount above the ₹15,000 authentication threshold |
| `R-BUDGET` | exceed the NPCI attempt budget for the cycle |
| `R-IDEMPOTENT` | act twice on the same `(subscription, cycle, attempt)` |
| `R-CONTACT` | exceed the outreach cap for a customer in a cycle |
| `R-PDN` | schedule inside the 24-hour pre-debit notification floor *(defers)* |
| `R-WINDOW` | schedule into an NPCI peak window *(defers)* |
| `R-DEGRADED` | spend an attempt into a degraded issuer *(defers)* |
| `R-BLAST` | exceed the blast-radius cap on a live run |
| `R-MALFORMED` | act on an agent response that failed schema validation *(defers)* |

`DEFER` is not `DENY`: the intent is fine, the timing is not, and a defer spends no attempt.

---

## Against the track's evaluation criteria

| Criterion | Where it lives |
|---|---|
| "Every money action explainable, bounded and gated," with audit trails | `packages/core/src/policy.ts` — 14 rules, first-deny-wins, every verdict writes a `decision` row with its `rule_id` and a deterministic explanation |
| Honest metrics, including false-positive costs | Denominators on every figure; attempts spent reported beside recoveries; unmapped decline codes reported as a first-class metric |
| Measured outcomes with compliant escalation and stopping rules | `R-BUDGET`, `R-HARD`, `R-CONTACT`, the `REAUTH_OUTREACH` → `STOP` escalation, and a kill switch verified before the first live call |
| "Throughput plus measured accuracy plus an honest exception list" | Control/treatment results table generated from the database, plus a published list of adversarial scenarios the system does **not** handle |

---

## Safety

- Read-only → dry-run → live, in that order. `DRY_RUN` defaults to on and is enforced inside the Razorpay client wrapper, not at call sites.
- Written merchant consent before any write-mode call. `write_enabled` is set by a human, never by code.
- Intent row written **before** the API call; the Razorpay order `receipt` is a deterministic idempotency key, so a duplicate is rejected at the rails as well as locally.
- Money is paise as integers. No float goes near a rupee value.
- No card data. Tokens stay at Razorpay. A customer reference is stored, never names, emails, or phone numbers.
- Keys are server-side, encrypted at rest, never in the frontend and never in this repo.

---

## Running it

```bash
pnpm install
docker compose up -d          # Postgres on :5433
pnpm db:migrate
pnpm test                     # policy engine + taxonomy
pnpm typecheck
```

Copy `.env.example` to `.env`. **Use Razorpay test-mode keys.** Live keys are not needed and should not be present until a merchant has signed consent.

---

## Layout

```
apps/api        webhook receiver, dashboard API
apps/worker     scheduler loop, executor, degradation rollups
apps/web        read-only dashboard
packages/core   policy engine, taxonomy, health scorer, agent client   ← zero network deps
packages/db     schema, migrations
docs/spec.md    the full product spec
```

`packages/core` has no network or database access by design. `now` is passed in rather than read from the clock. That is what lets the entire decision layer be proven without mocks and replayed inside a backtest.

---

## What this does not handle

To be filled from the adversarial scenario suite, honestly, including the cases that beat it.
