# Mandate Rescue

An agent that saves Razorpay subscriptions before they halt.

When a recurring charge fails, the mandate enters a countdown of fixed attempts on a fixed clock. When they run out the subscription is `halted`, the missed cycles are never re-attempted, and recovering the customer needs fresh authorization. The schedule is identical whether the customer was short for a day or revoked the mandate.

Mandate Rescue spends the same attempt budget on evidence instead of on a calendar: it classifies why the charge failed, times the retry, and refuses to spend attempts that cannot succeed.

Razorpay AI Buildathon, Track 03.

> Status: in development. No results claimed yet.

## Run

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm test
```

Copy `.env.example` to `.env`. Test-mode keys only.

## Layout

```
apps/api        webhook receiver, dashboard API
apps/worker     ingest, scheduler, executor
apps/web        read-only dashboard
packages/core   policy engine, taxonomy, health scorer
packages/db     schema, migrations
```

`packages/core` has no network or database access, and takes `now` as an argument rather than reading the clock.
