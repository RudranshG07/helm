# Architecture

How Helm is put together, and why each boundary is where it is.

---

## The shape

```
 Razorpay ──webhook──▶ INGEST ──▶ payment_attempt
    ▲                              │
    │                              ▼
    │                         CLASSIFY          decline reason → bucket
    │                              │            unrecognised → UNKNOWN, loudly
    │                              ▼
    │                          SCORE            health per mandate, every term shown
    │                              │
    │                              ▼
    │                          DECIDE            success model · liquidity · budget DP
    │                              │                        │
    │                              │                        ▼
    │                              │                   AGENT (LLM)
    │                              │            proposes one action and a reason
    │                              ▼                        │
    │                       POLICY ENGINE ◀─────────────────┘
    │                    16 rules · first refusal wins
    │                              │
    │                    ALLOW ────┴──── DENY ──▶ recorded, with the rule
    │                      │
    │                      ▼
    │                 DE-CONFLICT           spread debits colliding on one account
    │                      │
    │                      ▼
    └──────────────── EXECUTOR              intent first, charge second, reconcile third
                           │
                           ▼
                       AUDIT ──▶ dashboard · proof · per-decision trace
```

**The load-bearing rule: the agent proposes, the policy engine disposes.** The model never computes a rupee figure, never selects a final time, and never touches a payment API.

---

## Why these boundaries

### The policy engine is pure

`evaluate(proposal, context) → { verdict, rule_id, explanation }`. No I/O, no clock, no database. Every input arrives in the context object, which makes each of the sixteen rules testable in isolation and makes a verdict reproducible from its inputs alone.

It runs **twice**: once when an attempt is proposed, and again at execution, because the world moves in between — a mandate can be revoked, or the cycle paid, after a decision is made and before it fires. Timing rules run only in the proposal phase; re-applying a 24-hour notice floor at execution time would refuse every attempt that had correctly waited for it.

### The executor owns exactly-once, and nothing else

A crash between "call Razorpay" and "record the result" must never produce a second charge on a real person. So:

1. write the intent, keyed on `(subscription, cycle, attempt_number)`
2. derive a deterministic order receipt, so the rails reject a duplicate independently
3. call the gateway
4. settle the result back onto the intent
5. reconcile anything left submitted-but-unsettled against the gateway, never retry blind

Four crash seams, four tests that kill the process at each.

### The gateway is an interface

`Gateway` has two methods. Three implementations: the real Razorpay client, a stub for crash tests, and a seeded simulator for measurement. The batch and the live loop run the **same** executor — the only difference is which gateway is behind it, which is what makes a measured number mean anything.

### Learning is bounded and cached

The success model is rebuilt from a 180-day window and cached for five minutes, keyed by merchant scope. Before that it was rebuilt on every tick: 140ms and 5.7MB of churn per tick at 50k attempts, scaling linearly.

---

## The stages, in order

The worker runs one tick, and **money and safety come first** so an analytics failure can never starve reconciliation:

```
reconcile → dispatch → outreach → onboarding → ingest
   → decide → deconflict → promises → degradation → sweep
```

Each stage is isolated. A failure is recorded with its name and the rest still run; a partly failed tick logs `tick.degraded` rather than reporting success. A stage that did nothing logs nothing, so a quiet system stays quiet.

---

## Data model

| table | holds |
|---|---|
| `merchant` | keys encrypted at rest, `write_enabled`, consent timestamp |
| `subscription` | mandate, method, cycle bounds, `customer_key` for cross-merchant |
| `payment_attempt` | every attempt, with `initiated_by` separating ours from the gateway's |
| `mandate_health` | risk score and band, with every contributing term |
| `decision` | proposal, verdict, rule, rationale, and the context it was made in |
| `execution_intent` | the write-ahead row that makes exactly-once possible |
| `arm_assignment` | control or treatment, hash-derived, written once |
| `outreach` | link, channel, status, masked recipient, expiry |
| `promise_to_pay` | the date a customer named, and whether they kept it |
| `taxonomy_reclassification` | before and after, when the taxonomy learns |

`initiated_by` is what makes the headline number honest: a charge Helm made is recorded as ours, the default schedule's as its own. Without it, both arms would look identical in the data.

---

## Measurement

Arms are assigned by hashing `salt|subscription_id`, written once, and never changed — so a mandate cannot drift between arms as the population grows.

Each simulated outcome derives from `seed XOR hash(receipt)`, not a shared stream. This matters more than it sounds: with one stream, every draw the treatment arm consumed shifted the stream for control, and the two arms became statistically entangled. Now a mandate's outcome depends only on that mandate, so the arms are genuinely independent of processing order.

The **first failure of a cycle is excluded** from the per-attempt denominator, because both arms inherit it.

---

## Deployment

One process. The worker runs inside the web server, started after the port binds so a health check passes, and stopped on `SIGTERM`. That fits a free tier, where background workers are a paid feature.

```
Render (Singapore)  ──▶  Supabase Postgres (Mumbai)
   web + worker              payment data at rest in India
```

SSL is derived from the connection host; the pool is sized for a free-tier connection limit. Migrations run before the server serves. It starts in dry run, so a fresh deploy cannot move money until that is changed deliberately.

---

## Honesty, as a mechanism

Three things are structural rather than aspirational:

- **`UNKNOWN` is a real bucket.** An unmapped decline code is counted on the dashboard, and its money is excluded from anything called recoverable.
- **Every verified flag is `false`.** Seven decline reasons are mapped from documentation; none is confirmed by a retry outcome, and the code says so.
- **The adversarial catalogue is generated from source**, including 5 scenarios we detect but do not handle and 3 we still get wrong, each with a written explanation of what breaks.
