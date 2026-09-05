# Helm

**An agent that decides how to spend a failing mandate's last attempts.**

Live: **https://helm-xuxb.onrender.com**

[The proof](https://helm-xuxb.onrender.com/proof) — the claim, defended, re-runnable from the page
[The architecture](https://helm-xuxb.onrender.com/docs#architecture) — read out of the running source, so it cannot go stale

Razorpay AI Buildathon · Track 03, AI Revenue Recovery

---

## The constraint everything follows from

A recurring mandate that fails in India gets four crossings: the original charge and three retries. Miss all four and the bank tears the mandate down, and the customer has to authorise from scratch.

The default schedule spends all four the same way — same offsets, same times — whether the customer was short for a single morning or revoked the mandate entirely.

**Helm cannot add attempts. It decides how to spend the ones that exist, and refuses the ones that cannot work.**

---

## The bar, and where we meet it

> *"Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail."*

### Measured money, across a batch

Two arms over one population. Assignment is a stable hash, written to the database once, never changed. Control gets the fixed schedule. Treatment gets Helm.

| | Mandates | Recovery attempts | Recovered | **Per attempt** | Halted |
|---|---|---|---|---|---|
| control | 24 | 29 | ₹23,954 | **₹826** | 0 |
| treatment | 36 | 33 | ₹33,177 | **₹1,005** | 6 |

**+21.7% recovered per attempt.** Live at [`/proof`](https://helm-xuxb.onrender.com/proof), re-runnable from the page.

Recovered *per attempt* is the headline, not total recovered. Total rises with more attempts; the attempt budget is fixed by the payment network, so efficiency is the only axis that exists.

**The cost, stated next to the gain:** treatment halted 6 more mandates than control. The allocator maximises recovery per attempt, and declining marginal attempts is how it does that. Whether the trade is worth taking depends on what a halted mandate is worth to the merchant.

**The money is simulated.** Charges settle against a seeded gateway, labelled as such on the page. The rails are real: a live UPI Autopay mandate, a signed webhook, and genuine payment history backfilled from a Razorpay account.

### Compliant escalation

When no retry can succeed, Helm asks the customer to re-authorise:

- expiring links, one per decision, exactly once
- quiet hours — a send at 00:30 IST defers to 09:00 and writes nothing
- contact caps per customer per cycle
- one-click opt-out that revokes every outstanding link
- recipients stored masked; the raw address is never persisted
- English, Hinglish and Hindi
- **promise-to-pay**: the customer names a date, and that date overrides the model's guess

### Stopping rules

Sixteen deterministic rules. First refusal wins. Every verdict carries the rule that produced it.

`R-KILL` `R-CONSENT` `R-HALT` `R-PAID` `R-EXPIRY` `R-HARD` `R-CHRONIC` `R-METHOD` `R-BUDGET` `R-IDEMPOTENT` `R-CONTACT` `R-PDN` `R-WINDOW` `R-DEGRADED` `R-BLAST` `R-MALFORMED`

Refusals are logged as loudly as approvals. They are evidence, not errors.

### Audit trail

Every decision is traceable from the decline code to the outcome — and each retry carries a **counterfactual**: what the default schedule would have scored at its slot, versus what Helm chose, with the evidence count beside each probability.

---

## The AI, and where it is not allowed to go

The model proposes one action and a reason in plain English. **It never computes a rupee figure, never picks a final time, and never calls a payment API.** Sixteen deterministic rules run after it, and the first refusal wins.

That separation is not decoration. Here is a real call, on the deployed instance:

```
agent proposes : REAUTH_OUTREACH
reason         : "The transaction was declined by the customer,
                  requiring a new authorization to resume payments."

policy engine  : DENY · R-HARD
explanation    : Customer declined permanently; no further contact.
```

The model wanted to contact a customer who had **cancelled**. The engine refused. No attempt was spent, no message was sent.

Provider-agnostic: Anthropic, Gemini, Groq, Cerebras, OpenRouter, or a local model. A key in the wrong slot is detected by shape and skipped. A provider outage degrades to the deterministic allocator rather than stopping recovery.

---

## What decides, underneath

| | |
|---|---|
| **Decline taxonomy** | 7 reasons → soft, hard, or unmapped. An unrecognised code becomes `UNKNOWN` loudly and is never guessed into a bucket. |
| **Health scoring** | Consecutive failures, attempts remaining, days to expiry — every term shown, so the score can be argued with. |
| **Liquidity windows** | When *that customer's* account has historically been funded, with an honest fallback to a population default when history is thin. |
| **Success model** | Hierarchical Beta-Binomial with shrinkage from cell to bucket to global. Cached, and bounded to a 180-day window. |
| **Budget allocator** | Attempts as optimal stopping over remaining budget and days to halt. |
| **Contention** | The falsifiable claim that Indian `insufficient_funds` is partly payday queueing — with the amount-effect test that would disprove it. |
| **De-confliction** | Cross-merchant: when several merchants would debit the same account within half an hour, Helm spreads them. Only for merchants who consented to share signals. |
| **Off-policy evaluation** | IPS, SNIPS, doubly robust — and it refuses to answer when the logging policy was deterministic. |

---

## Exactly once

The most dangerous bug on a payment path is a second charge on a real person.

1. An intent row is written **before** the gateway is called, keyed on subscription, cycle and attempt number.
2. The order carries a deterministic receipt, so the rails refuse a duplicate even if we do not.
3. Only then is the charge submitted, and the result settled back onto the intent.
4. Anything left submitted-but-unsettled is reconciled against the gateway, never retried blind.

A test kills the process at each of those four seams and asserts no second charge exists.

---

## What we do not know

Reported here rather than left for a reviewer to find.

- **The taxonomy is unverified.** Seven decline reasons are mapped; **zero** are confirmed by a retry outcome. A wrong bucket spends a real attempt on a mandate that cannot be saved.
- **The timing model does not yet beat the base rate.** Every prediction is now stored as it was made and scored against the attempt it caused. Over 65 attempts it is calibrated in aggregate — it said 89.0%, 89.2% happened — but its skill is **-0.16**, so it is not yet telling a good slot from a bad one. None of those observations come from a real account.
- **A single batch is not a stable estimate.** The treatment arm updates its model as it runs, so a poor start makes it pessimistic about the rest of the population. Measured across seven times of day on identical inputs, it spends 31–36 attempts in business hours and 1 at 05:30 IST.
- **Sign-in has no second factor.** The Razorpay key id and secret are the credential, and the session is an httpOnly cookie scoped to that account. Anyone holding those keys already controls the Razorpay account, so this adds no new exposure — but it adds no second factor either.
- **Onboarding asks for API keys.** Razorpay partner OAuth is the correct answer and needs approval we could not obtain. A CSV import path exists for merchants who will not hand over keys.

The full catalogue — **276 scenarios, 269 handled, 6 detected, 1 unhandled** — is generated from the code at [`/docs`](https://helm-xuxb.onrender.com/docs), including the ones we still get wrong, in our own words.

---

## Running it

```bash
pnpm install
pnpm dev          # database, migrations, web build, worker, api on :3000
pnpm test         # 984 tests, against isolated databases
```

Deployed as a single service: the worker runs inside the web process, so it fits a free tier. Postgres is in Mumbai for data residency.

```
landing   /            proof   /proof     docs      /docs
connect   /onboard     dash    /dashboard mandates  /authorize
```

---

## Numbers

| | |
|---|---|
| Tests | 984 |
| Adversarial scenarios | 276 — 269 handled, 6 detected, 1 unhandled |
| Policy rules | 16 |
| Migrations | 18 |
| Source files | 125 |

Every figure on this page is measured or generated. Nothing is estimated.
