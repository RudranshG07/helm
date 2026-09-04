import { useEffect, useState } from 'react';
import { useReveal } from './reveal.ts';
import { Announce, SkeletonDoc } from './skeletons.tsx';

interface RuleDoc { id: string; refusals: string[]; phase: string }
interface TaxonomyDoc { reason: string; bucket: string; confidence: string; verified: boolean }
interface ScenarioGroup { category: string; total: number; handled: number; detected: number; unhandled: number }

interface DocsData {
  generated_at: string;
  taxonomy_version: string;
  attempt_budget: number;
  peak_windows: string[];
  actions: string[];
  rules: RuleDoc[];
  taxonomy: TaxonomyDoc[];
  scenarios: { total: number; handled: number; detected: number; unhandled: number; groups: ScenarioGroup[] };
  open_gaps: { id: string; title: string; note: string | null }[];
}

const ACTION_MEANING: Record<string, string> = {
  RETRY_SCHEDULED: 'Charge again at a specific time, chosen against evidence rather than a fixed offset.',
  HOLD: 'Spend no attempt today. Used when the issuer is degraded or the evidence says waiting is worth more.',
  REAUTH_OUTREACH: 'No retry can succeed. Ask the customer to authorise a new mandate.',
  STOP: 'Give up on this cycle. The customer cancelled, or the budget is spent.',
};

const SECTIONS = [
  { id: 'constraint', label: 'The constraint' },
  { id: 'loop', label: 'The loop' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'taxonomy', label: 'Decline taxonomy' },
  { id: 'actions', label: 'Interventions' },
  { id: 'rules', label: 'Policy rules' },
  { id: 'timing', label: 'Timing' },
  { id: 'exactly-once', label: 'Exactly once' },
  { id: 'measurement', label: 'Measurement' },
  { id: 'api', label: 'API' },
  { id: 'start', label: 'Getting started' },
  { id: 'gaps', label: 'What we do not know' },
];

const ROUTES: [string, string, string, 'public' | 'merchant'][] = [
  ['GET', '/api/public', 'Totals across every connected business. No names, no customers, no per-account figures.', 'public'],
  ['GET', '/api/proof', 'Everything the proof page shows. Decision traces are drawn only from mandates Helm generated itself.', 'public'],
  ['GET', '/api/docs', 'This page, extracted from the source at request time.', 'public'],
  ['GET', '/api/overview', 'Revenue at risk, risk bands, unmapped decline counts.', 'merchant'],
  ['GET', '/api/at-risk', 'Mandates with a failure in the open cycle.', 'merchant'],
  ['GET', '/api/decisions', 'The decision log with denials grouped by rule.', 'merchant'],
  ['GET', '/api/decisions/:id/trace', 'One decision, from decline to outcome, with its counterfactual.', 'merchant'],
  ['GET', '/api/declines', 'Decline distribution and the codes still unmapped.', 'merchant'],
  ['GET', '/api/charge-queue', 'What would be charged next, and why.', 'merchant'],
  ['GET', '/api/outreach', 'Outreach funnel and every message with its status.', 'merchant'],
  ['GET', '/api/onboard/:id/report', 'A merchant\u2019s recovery report, in rupees.', 'merchant'],
  ['GET', '/api/authorize/account', 'What the connected Razorpay account can actually do.', 'merchant'],
  ['POST', '/api/onboard/connect', 'Store read-only keys, backfill payment history, and issue that merchant a dashboard token.', 'public'],
  ['POST', '/api/control', 'Engage or release the kill switch.', 'merchant'],
  ['POST', '/webhooks/razorpay', 'Signed Razorpay events.', 'public'],
  ['GET', '/r/:token', 'The customer re-authorisation page.', 'public'],
];


function Section({ id, title, lede, children }: {
  id: string; title: string; lede?: string; children: React.ReactNode;
}) {
  return (
    <section className="doc-section" id={id}>
      <h2>{title}</h2>
      {lede && <p className="doc-lede">{lede}</p>}
      {children}
    </section>
  );
}

export default function Docs() {
  const [data, setData] = useState<DocsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shell = useReveal<HTMLDivElement>('.doc-section', [data]);

  useEffect(() => {
    fetch('/api/docs')
      .then(async (r) => {
        if (!r.ok) throw new Error(`documentation unavailable (${r.status})`);
        return r.json() as Promise<DocsData>;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="shell onboard">
        <div className="state is-error"><strong>Could not load the documentation</strong>{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="shell docs">
        <Announce label="Reading the documentation from source">
          <SkeletonDoc />
        </Announce>
      </div>
    );
  }

  return (
    <div className="shell docs" ref={shell}>
      <header className="masthead">
        <a className="wordmark" href="/">Helm</a>
        <nav className="site-links" aria-label="Product">
          <a className="site-link" href="/proof">Proof</a>
          <a className="site-link" href="/onboard">Connect</a>
          <a className="site-link" href="/authorize">Mandates</a>
          <a className="site-link" href="/dashboard">Dashboard</a>
        </nav>
      </header>

      <div className="doc-layout">
        <nav className="doc-toc" aria-label="Documentation sections">
          <span className="eyebrow">Contents</span>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}><a href={`#${s.id}`}>{s.label}</a></li>
            ))}
          </ol>
        </nav>

        <div className="doc-body">
          <h1 className="proof-title">How Helm works</h1>
          <p className="proof-intro">
            Every rule, bucket and intervention on this page is read out of the running source at
            request time. If the code changes, this page changes with it.
          </p>

          <Section
            id="constraint"
            title="The constraint everything follows from"
            lede="A failed recurring mandate in India gets a fixed, small number of attempts. After that the bank cancels it and the customer has to authorise again from scratch."
          >
            <div className="doc-stats">
              <div>
                <strong>{data.attempt_budget}</strong>
                <span>attempts per cycle, one original and the rest retries</span>
              </div>
              <div>
                <strong>{data.taxonomy.length}</strong>
                <span>decline reasons mapped, in taxonomy {data.taxonomy_version}</span>
              </div>
              <div>
                <strong>{data.rules.length}</strong>
                <span>deterministic rules that can refuse an action</span>
              </div>
            </div>
            <p>
              Helm cannot add attempts. Everything below exists to decide how to spend the ones
              that already exist, and to refuse the ones that cannot work.
            </p>
          </Section>

          <Section
            id="loop"
            title="The loop"
            lede="Six stages. The first four decide, the fifth acts, the sixth makes it arguable afterwards."
          >
            <ol className="doc-steps">
              <li><strong>Ingest.</strong> Razorpay webhooks and a historical backfill land in one attempt table, normalised.</li>
              <li><strong>Classify.</strong> The decline reason becomes a bucket. An unrecognised code becomes UNKNOWN, loudly, and is never guessed.</li>
              <li><strong>Score.</strong> Each mandate gets a health score from consecutive failures, attempts remaining and days to expiry, with every term shown.</li>
              <li><strong>Decide.</strong> A success model and a budget allocator rank candidate times. A language model proposes one action and a reason in plain English.</li>
              <li><strong>Bound.</strong> The policy engine checks the proposal against every rule below. The first refusal wins, and refusals are logged as loudly as approvals.</li>
              <li><strong>Execute.</strong> An intent row is written before the gateway is called, so a crash can never produce a second charge.</li>
            </ol>
          </Section>

          <Section
            id="architecture"
            title="Architecture, and why the boundaries are where they are"
            lede="Three seams carry the weight: the model may not move money, the executor may not charge twice, and analytics may not starve safety."
          >
            <pre className="doc-diagram" aria-label="System diagram">{` Razorpay ──webhook──▶ INGEST ──▶ payment_attempt
    ▲                              │
    │                              ▼
    │                         CLASSIFY      reason → bucket, unknown stays UNKNOWN
    │                              ▼
    │                          SCORE        health per mandate, every term shown
    │                              ▼
    │                          DECIDE       success model · liquidity · budget DP
    │                              │                    │
    │                              │                    ▼
    │                              │               AGENT (LLM)
    │                              │        proposes one action and a reason
    │                              ▼                    │
    │                       POLICY ENGINE ◀─────────────┘
    │                  16 rules · first refusal wins
    │                              │
    │                    ALLOW ────┴──── DENY ──▶ recorded, with the rule
    │                      ▼
    │                 DE-CONFLICT           spread debits hitting one account
    │                      ▼
    └──────────────── EXECUTOR              intent → charge → reconcile
                           ▼
                       AUDIT ──▶ dashboard · proof · per-decision trace`}</pre>

            <ul className="doc-list">
              <li>
                <code>pure policy</code>
                <span>
                  The engine takes a proposal and a context and returns a verdict. No clock, no
                  database, no network. Every rule is testable alone, and a verdict is reproducible
                  from its inputs.
                </span>
              </li>
              <li>
                <code>two phases</code>
                <span>
                  Rules run when an attempt is proposed and again at execution, because a mandate can
                  be revoked in between. Timing rules run only in the first phase; re-applying a
                  notice floor later would refuse every attempt that correctly waited for it.
                </span>
              </li>
              <li>
                <code>gateway is an interface</code>
                <span>
                  Three implementations: real Razorpay, a stub for crash tests, and a seeded
                  simulator for measurement. The batch and the live loop run the same executor, which
                  is what makes a measured number mean anything.
                </span>
              </li>
              <li>
                <code>bounded learning</code>
                <span>
                  The success model reads a 180-day window and is cached per merchant scope. Rebuilt
                  every tick it cost 140ms and 5.7MB of churn at 50,000 attempts, scaling linearly.
                </span>
              </li>
              <li>
                <code>attribution</code>
                <span>
                  Every attempt records who made it. Without that, both arms look identical in the
                  data and the headline number means nothing.
                </span>
              </li>
              <li>
                <code>independent arms</code>
                <span>
                  Each simulated outcome derives from the seed combined with its own receipt. With a
                  shared random stream the control arm's results depended on what the treatment arm
                  decided, which quietly invalidated the comparison.
                </span>
              </li>
              <li>
                <code>one process</code>
                <span>
                  The worker runs inside the web server, started after the port binds and stopped on
                  shutdown, so the whole system fits a free tier. Postgres is in Mumbai for residency.
                </span>
              </li>
            </ul>
          </Section>

          <Section
            id="taxonomy"
            title="Decline taxonomy"
            lede="A bucket decides whether a retry can help at all. Getting this wrong spends a real attempt on a mandate that cannot be saved, so an unmapped code is never quietly assigned."
          >
            <div className="paper table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Razorpay reason</th>
                    <th scope="col">Bucket</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Verified by outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {data.taxonomy.map((t) => (
                    <tr key={t.reason}>
                      <td><code>{t.reason}</code></td>
                      <td><span className={`badge ${t.bucket}`}>{t.bucket.replace(/_/g, ' ').toLowerCase()}</span></td>
                      <td>{t.confidence}</td>
                      <td>{t.verified ? 'yes' : <span className="ref">not yet</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="doc-note">
              Anything not in this table classifies as UNKNOWN, takes the conservative path, and is
              counted on the honesty metric rather than folded into a recoverable figure.
            </p>
          </Section>

          <Section
            id="actions"
            title="Interventions"
            lede="The complete set. The model may propose one of these and nothing else."
          >
            <ul className="doc-list">
              {data.actions.map((a) => (
                <li key={a}>
                  <code>{a}</code>
                  <span>{ACTION_MEANING[a] ?? 'No description recorded.'}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section
            id="rules"
            title="Policy rules"
            lede="Deterministic, ordered, first refusal wins. Every verdict carries the rule that produced it. The refusal text below is the text the engine actually emits."
          >
            <div className="paper table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Rule</th>
                    <th scope="col">Refuses when</th>
                    <th scope="col">Re-checked at execution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rules.map((r) => (
                    <tr key={r.id}>
                      <td><code>{r.id}</code></td>
                      <td>
                        {r.refusals.length > 0
                          ? r.refusals.map((t) => <div key={t}>{t}</div>)
                          : <span className="ref">context dependent</span>}
                      </td>
                      <td>{r.phase === 'both' ? 'yes' : <span className="ref">proposal only</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="doc-note">
              Timing rules run when the attempt is proposed, not again at execution, because by then
              the scheduled moment has arrived and re-applying the floor would refuse every attempt.
            </p>
          </Section>

          <Section
            id="timing"
            title="Timing"
            lede="When a retry lands matters as much as whether it happens."
          >
            <div className="doc-stats">
              <div>
                <strong>{data.peak_windows.length}</strong>
                <span>contested windows avoided: {data.peak_windows.join(' and ')}</span>
              </div>
              <div>
                <strong>24h</strong>
                <span>minimum notice before a debit, with a same-day cutoff</span>
              </div>
            </div>
            <p>
              A customer short of funds on the first of the month is not short on the third. Helm
              infers when that account has historically been funded and schedules into it, falling
              back to a population default when the history is too thin to trust, and saying so.
            </p>
          </Section>

          <Section
            id="exactly-once"
            title="Exactly once"
            lede="The most dangerous bug on a payment path is a second charge on a real person."
          >
            <ol className="doc-steps">
              <li>An intent row is written first, keyed on subscription, cycle and attempt number.</li>
              <li>The gateway order carries a deterministic receipt, so the rails refuse a duplicate even if we do not.</li>
              <li>Only then is the charge submitted, and the result settled back onto the intent.</li>
              <li>Anything left submitted but unsettled is reconciled against the gateway rather than retried blind.</li>
            </ol>
            <p className="doc-note">
              A crash at any of those four seams is covered by a test that kills the process at that
              exact point and asserts no second charge exists.
            </p>
          </Section>

          <Section
            id="measurement"
            title="Measurement"
            lede="The headline is rupees recovered per attempt, not rupees recovered. Total recovery rises with more attempts; efficiency does not, and the attempt budget is fixed by the network."
          >
            <ul className="doc-list">
              <li><code>control</code><span>The fixed default schedule, untouched.</span></li>
              <li><code>treatment</code><span>Helm decides. Assignment is a stable hash, written once and never changed.</span></li>
            </ul>
            <p>
              Attempts Helm makes are recorded as ours; the default schedule's are recorded as
              its own, so the two arms can never be confused. The failure that opened a cycle is
              excluded from the denominator, because both arms inherit it.
            </p>
            <p className="doc-note">
              Every published number carries its denominator, and the cost of the objective is
              reported next to the gain.
            </p>
          </Section>

          <Section
            id="api"
            title="API"
            lede="Everything the interface shows is available directly. Public routes carry aggregates and synthetic mandates only; the rest need the session token issued when you connect your Razorpay account, and answer for that account alone."
          >
            <div className="paper table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Method</th>
                    <th scope="col">Path</th>
                    <th scope="col">Who can read it</th>
                    <th scope="col">Returns</th>
                  </tr>
                </thead>
                <tbody>
                  {ROUTES.map(([method, path, note, access]) => (
                    <tr key={path}>
                      <td><span className="badge SOFT_LIQUIDITY">{method}</span></td>
                      <td><code>{path}</code></td>
                      <td>
                        <span className={`badge ${access === 'public' ? 'healthy' : 'HARD_INSTRUMENT'}`}>
                          {access === 'public' ? 'public' : 'your account'}
                        </span>
                      </td>
                      <td>{note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            id="start"
            title="Getting started"
            lede="Read-only first. Nothing is charged until you explicitly grant write access."
          >
            <ol className="doc-steps">
              <li><strong>Connect.</strong> Paste read-only Razorpay keys, or upload a failed-payments export. Keys are encrypted at rest and never reach the browser.</li>
              <li><strong>Read the recovery report.</strong> What failed, what never recovered, and how much of it responds to timing, computed from your own history.</li>
              <li><strong>Watch the dry run.</strong> Helm records the action it would take without taking it.</li>
              <li><strong>Grant write access</strong> when the log convinces you, under a blast-radius cap and a kill switch that halts everything instantly.</li>
            </ol>
            <div className="ground-actions">
              <a className="cta" href="/onboard">Connect an account</a>
              <a className="cta" href="/proof">See the proof first</a>
            </div>
          </Section>

          <Section
            id="gaps"
            title="What we do not know"
            lede="Generated from the same adversarial catalogue the test suite runs against."
          >
            <div className="doc-stats">
              <div><strong>{data.scenarios.handled}</strong><span>scenarios handled, with a test</span></div>
              <div><strong>{data.scenarios.detected}</strong><span>detected but not handled</span></div>
              <div><strong>{data.scenarios.unhandled}</strong><span>we still get wrong</span></div>
            </div>

            {data.open_gaps.length > 0 && (
              <div className="gaps paper">
                <h3>Open, in our own words</h3>
                {data.open_gaps.map((g) => (
                  <div className="gap" key={g.id}>
                    <span className="ref">{g.id}</span>
                    <div>
                      <strong>{g.title}</strong>
                      {g.note && <p>{g.note}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="paper table-wrap" style={{ marginTop: 18 }}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    <th scope="col" className="num">Scenarios</th>
                    <th scope="col" className="num">Handled</th>
                    <th scope="col" className="num">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {data.scenarios.groups.map((g) => (
                    <tr key={g.category}>
                      <td>{g.category}</td>
                      <td className="num">{g.total}</td>
                      <td className="num">{g.handled}</td>
                      <td className="num">{g.detected + g.unhandled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <footer className="proof-foot">
            <span>Read from source at {new Date(data.generated_at).toLocaleString('en-IN')}</span>
            <span>Taxonomy {data.taxonomy_version}</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
