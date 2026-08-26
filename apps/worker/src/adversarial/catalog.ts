export type Outcome = 'HANDLED' | 'DETECTED' | 'UNHANDLED';

export interface Scenario {
  id: string;
  category: string;
  title: string;
  expectation: string;
  outcome: Outcome;
  note?: string;
}

export const SCENARIOS: Scenario[] = [
  { id: 'A1', category: 'Exactly-once', title: 'Crash after gateway call, before database write', expectation: 'Restart reconciles to the real outcome. Exactly one order.', outcome: 'HANDLED' },
  { id: 'A2', category: 'Exactly-once', title: 'Crash after intent row, before gateway call', expectation: 'Reconciler finds no order and marks it abandoned.', outcome: 'HANDLED' },
  { id: 'A3', category: 'Exactly-once', title: 'Crash between submit and settle', expectation: 'Reconciler settles to the real payment status.', outcome: 'HANDLED' },
  { id: 'A4', category: 'Exactly-once', title: 'Two workers claim the same attempt simultaneously', expectation: 'One wins the unique index, the other gets a clean duplicate result.', outcome: 'HANDLED' },
  { id: 'A5', category: 'Exactly-once', title: 'Duplicate webhook delivery, same event id', expectation: 'Second delivery is a no-op via the event dedup index.', outcome: 'HANDLED' },
  { id: 'A6', category: 'Exactly-once', title: 'Gateway rejects a receipt that already exists', expectation: 'Reconcile against the existing order. Never modify the receipt.', outcome: 'HANDLED' },
  { id: 'A7', category: 'Exactly-once', title: 'A dry run followed by a live run for the same attempt', expectation: 'The key is already consumed, so the live run cannot double it.', outcome: 'HANDLED' },
  { id: 'A8', category: 'Exactly-once', title: 'Gateway returns an error after the charge actually succeeded', expectation: 'Reconciler finds the order by receipt and records the truth.', outcome: 'HANDLED' },
  { id: 'A9', category: 'Exactly-once', title: 'Network timeout with an unknown outcome', expectation: 'Never assumed failed. Held until reconciled.', outcome: 'HANDLED' },
  { id: 'A10', category: 'Exactly-once', title: 'Different attempt number for the same cycle', expectation: 'A distinct key, so it is a distinct legitimate charge.', outcome: 'HANDLED' },

  { id: 'B1', category: 'Lifecycle races', title: 'Merchant write access revoked while a job is in flight', expectation: 'Checked immediately before the call, not only at proposal time.', outcome: 'HANDLED' },
  { id: 'B2', category: 'Lifecycle races', title: 'Kill switch tripped mid-run', expectation: 'Read fresh per attempt. No intent row written.', outcome: 'HANDLED' },
  { id: 'B3', category: 'Lifecycle races', title: 'Mandate expires between scheduling and execution', expectation: 'R-EXPIRY denies at proposal time.', outcome: 'DETECTED', note: 'The policy engine denies at decision time, but the dispatcher does not re-run policy immediately before the call. A mandate that expires in the gap is caught only by the gateway.' },
  { id: 'B4', category: 'Lifecycle races', title: 'Subscription halts while a retry is scheduled', expectation: 'R-HALT denies.', outcome: 'DETECTED', note: 'Same gap as B3: policy is evaluated once, at decision time.' },
  { id: 'B5', category: 'Lifecycle races', title: 'Customer pays manually while a retry is scheduled', expectation: 'Detect the invoice is settled and cancel the job.', outcome: 'UNHANDLED', note: 'No invoice-state check before dispatch. The attempt would be spent, and reconciliation would record it as a duplicate charge on an already-paid cycle.' },
  { id: 'B6', category: 'Lifecycle races', title: 'Mandate revoked by the customer between proposal and execution', expectation: 'Fresh state read before executing.', outcome: 'DETECTED', note: 'The gateway would reject it, so no money moves, but an attempt is spent.' },
  { id: 'B7', category: 'Lifecycle races', title: 'Subscription amount changes between attempts', expectation: 'The idempotency key must not authorise a different amount.', outcome: 'UNHANDLED', note: 'The key is derived from subscription, cycle and attempt number only. A changed amount reuses the same key and would be silently blocked as a duplicate rather than flagged.' },
  { id: 'B8', category: 'Lifecycle races', title: 'Subscription cancelled mid-cycle', expectation: 'R-HALT denies at proposal time.', outcome: 'HANDLED' },

  { id: 'C1', category: 'Classification', title: 'A decline code never seen before', expectation: 'UNKNOWN, one conservative attempt, surfaced on the dashboard.', outcome: 'HANDLED' },
  { id: 'C2', category: 'Classification', title: 'Reason and source disagree', expectation: 'UNKNOWN rather than a coin flip. The source lean is recorded, not acted on.', outcome: 'HANDLED' },
  { id: 'C3', category: 'Classification', title: 'error_source is business, meaning our own request was malformed', expectation: 'Logged as our bug. Not counted as a customer decline.', outcome: 'DETECTED', note: 'It is detected and logged, but it still lands in payment_attempt as UNKNOWN and counts against the cycle budget.' },
  { id: 'C4', category: 'Classification', title: 'Failed payment with every error field null', expectation: 'UNKNOWN. Must not throw.', outcome: 'HANDLED' },
  { id: 'C5', category: 'Classification', title: 'A hard decline followed by a success', expectation: 'State recovers, no stuck hard flag.', outcome: 'HANDLED' },
  { id: 'C6', category: 'Classification', title: 'The same reason string meaning different things per method', expectation: 'Bucketing keys on method and reason together.', outcome: 'HANDLED' },
  { id: 'C7', category: 'Classification', title: 'Amount above the additional-authentication threshold', expectation: 'No silent retry is possible. R-METHOD denies.', outcome: 'HANDLED' },
  { id: 'C8', category: 'Classification', title: 'Chronic soft declines across many cycles', expectation: 'At some point a repeated soft decline is effectively hard.', outcome: 'UNHANDLED', note: 'Soft-decline history feeds the risk score but never changes the bucket. A customer who is permanently short is retried every cycle.' },

  { id: 'D1', category: 'Time and calendar', title: 'Retry proposed inside the 24 hour notification floor', expectation: 'R-PDN defers and returns an adjusted time.', outcome: 'HANDLED' },
  { id: 'D2', category: 'Time and calendar', title: 'Retry enqueued in the last ten minutes of the day for a next-day debit', expectation: 'Pushed to the day after.', outcome: 'HANDLED' },
  { id: 'D3', category: 'Time and calendar', title: 'Preferred time falls inside a peak execution window', expectation: 'R-WINDOW snaps forward to the next permitted window.', outcome: 'HANDLED' },
  { id: 'D4', category: 'Time and calendar', title: 'A customer whose payday is the 31st, in February', expectation: 'Clamped to the last day of the month.', outcome: 'HANDLED' },
  { id: 'D5', category: 'Time and calendar', title: 'Successes on the 1st and the 31st', expectation: 'Circular statistics. Must not average to the middle of the month.', outcome: 'HANDLED' },
  { id: 'D6', category: 'Time and calendar', title: 'Stored UTC, reasoned in IST, across midnight', expectation: 'Day of month reads IST, not UTC.', outcome: 'HANDLED' },
  { id: 'D7', category: 'Time and calendar', title: 'Boundary exactly at 24 hours, and one second under', expectation: 'Both sides tested, the legal side defined.', outcome: 'HANDLED' },
  { id: 'D8', category: 'Time and calendar', title: 'A scheduled job whose time passed while the worker was down', expectation: 'Re-validate every rule before executing a stale job.', outcome: 'UNHANDLED', note: 'The dispatcher executes any ALLOW whose scheduled time has passed, without re-running the policy engine. A job stale by days would still fire.' },
  { id: 'D9', category: 'Time and calendar', title: 'Retry scheduled onto a bank holiday for e-mandate', expectation: 'Shifted per the bank calendar.', outcome: 'UNHANDLED', note: 'No bank holiday calendar exists. The debit would silently shift at the bank, and our recorded schedule would be wrong.' },

  { id: 'E1', category: 'Budget', title: 'Our attempt and an automatic retry in the same cycle', expectation: 'Both count against the network budget.', outcome: 'HANDLED' },
  { id: 'E2', category: 'Budget', title: 'Exactly at the budget limit', expectation: 'Tested at n-1, n and n+1.', outcome: 'HANDLED' },
  { id: 'E3', category: 'Budget', title: 'An attempt still unresolved after 36 hours', expectation: 'Budget held, not released. Settlement is slow.', outcome: 'HANDLED' },
  { id: 'E4', category: 'Budget', title: 'An attempt that crashed before submitting', expectation: 'Budget not spent, but only the reconciler can establish that.', outcome: 'HANDLED' },
  { id: 'E5', category: 'Budget', title: 'Budget counted across a cycle boundary', expectation: 'The cycle identifier resets it correctly.', outcome: 'HANDLED' },
  { id: 'E6', category: 'Budget', title: 'Backfilled historical attempts', expectation: 'Not double-counted against a live budget.', outcome: 'DETECTED', note: 'Backfilled rows carry source=backfill but the budget query counts all attempts in the cycle regardless of source.' },
  { id: 'E7', category: 'Budget', title: 'e-mandate previous attempt still unconfirmed', expectation: 'Do not schedule a second attempt while one is in flight.', outcome: 'HANDLED' },

  { id: 'F1', category: 'Policy and agent', title: 'Agent returns malformed JSON', expectation: 'DEFER. Never a default action.', outcome: 'HANDLED' },
  { id: 'F2', category: 'Policy and agent', title: 'Agent proposes an action outside the enum', expectation: 'Rejected at validation, recorded as R-MALFORMED.', outcome: 'HANDLED' },
  { id: 'F3', category: 'Policy and agent', title: 'Agent proposes a retry on a hard decline', expectation: 'R-HARD denies cleanly and the denial is logged.', outcome: 'HANDLED' },
  { id: 'F4', category: 'Policy and agent', title: 'A proposal that trips several rules at once', expectation: 'First deny wins, and the reported rule is the most useful one.', outcome: 'HANDLED' },
  { id: 'F5', category: 'Policy and agent', title: 'Agent proposes a time in the past', expectation: 'R-PDN adjusts rather than erroring.', outcome: 'HANDLED' },
  { id: 'F6', category: 'Policy and agent', title: 'Agent API times out', expectation: 'DEFER after retry. Never a fallback action.', outcome: 'HANDLED' },
  { id: 'F7', category: 'Policy and agent', title: 'Model refuses the request', expectation: 'Treated as an invalid response and deferred.', outcome: 'HANDLED' },
  { id: 'F8', category: 'Policy and agent', title: 'Blast radius cap reached exactly at this attempt', expectation: 'R-BLAST denies.', outcome: 'DETECTED', note: 'The rule exists and is tested, but the dispatcher passes a hardcoded zero for attempts used, so the cap is never actually reached in the live path.' },
  { id: 'F9', category: 'Policy and agent', title: 'Issuer degraded at execution time', expectation: 'R-DEGRADED defers rather than spending an attempt.', outcome: 'UNHANDLED', note: 'No degradation detector is wired. The flag is hardcoded false everywhere, so R-DEGRADED can never fire.' },
  { id: 'F10', category: 'Policy and agent', title: 'Dry run bypassed at one call site', expectation: 'Enforced inside the executor so no call site can bypass it.', outcome: 'HANDLED' },
];

export function scorecard(scenarios: Scenario[] = SCENARIOS) {
  const counts = { HANDLED: 0, DETECTED: 0, UNHANDLED: 0 };
  for (const s of scenarios) counts[s.outcome] += 1;
  return { total: scenarios.length, ...counts };
}
