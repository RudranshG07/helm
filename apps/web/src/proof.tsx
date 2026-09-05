import { useCallback, useEffect, useState } from 'react';
import { useReveal } from './reveal.ts';
import { rupees } from './format.ts';
import { api } from './api.ts';
import type { Counterfactual, DecisionTrace, PublicTotals } from './api.ts';
import { Announce, SkeletonReport } from './skeletons.tsx';

interface ArmRow {
  arm: string;
  mandates: number;
  attempts_by_us: number;
  attempts_by_default: number;
  amount_at_risk_paise: number;
  amount_recovered_paise: number;
  mandates_halted: number;
}

interface RealAccount {
  connected: boolean;
  merchants: number;
  mandates: number;
  attempts: number;
  failures: number;
  recovered_paise: number;
  lost_paise: number;
  decline_codes: { reason: string | null; bucket: string; source: string; n: number }[];
  live_mandates: number;
  events_via_webhook: number;
  attempts_via_backfill: number;
}

interface CrossMerchant {
  merchants_sharing_signals: number;
  customers_seen_by_more_than_one: number;
  debits_spread: number;
  collisions_pending: number;
  contention_verdict: string;
  contention_explanation: string;
  contention_threshold_paise: number;
  contested_label: string;
  uncontested_label: string;
}

interface CalibrationBand {
  band: string;
  predicted_mean: number;
  observed_rate: number;
  n: number;
}

interface CalibrationData {
  scored: number;
  brier: number | null;
  baseline_brier: number | null;
  skill: number | null;
  observed_rate: number | null;
  predicted_mean: number | null;
  bands: CalibrationBand[];
  real_account_scored: number;
  verdict: string;
}

interface ProofData {
  generated_at: string;
  scale: Record<string, number>;
  real: RealAccount;
  arms: ArmRow[];
  edge_per_attempt_pct: number | null;
  allowed_trace: DecisionTrace | null;
  refused_trace: DecisionTrace | null;
  outreach: {
    funnel: Record<string, number>;
    languages: Record<string, number>;
    promises_open: number;
    promises_kept: number;
    promises_broken: number;
  };
  cross_merchant: CrossMerchant;
  calibration: CalibrationData;
  honesty: {
    taxonomy_version: string;
    unmapped_attempts: number;
    unmapped_share: number;
    scenarios: number;
    handled: number;
    detected: number;
    unhandled: number;
    open_gaps: { id: string; title: string; note: string | null }[];
    money_is_simulated: boolean;
  };
}

const perAttempt = (a: ArmRow) => {
  const n = a.attempts_by_us + a.attempts_by_default;
  return n > 0 ? a.amount_recovered_paise / n : 0;
};

function Section({ n, eyebrow, title, lede, children }: {
  n: number; eyebrow: string; title: string; lede: string; children: React.ReactNode;
}) {
  return (
    <section className="proof-section">
      <div className="proof-head">
        <span className="proof-num" aria-hidden="true">{String(n).padStart(2, '0')}</span>
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p className="proof-lede">{lede}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function CounterfactualCard({ c }: { c: Counterfactual }) {
  return (
    <div className="counterfactual paper">
      <div className="eyebrow">This attempt, against the default schedule</div>
      <div className="cf-grid">
        <div className="cf-arm">
          <span className="cf-label">Razorpay default</span>
          <strong className="num">{(c.default_p * 100).toFixed(1)}%</strong>
          <span className="hint">{c.default_at}</span>
          <span className="hint">{c.default_in_peak ? 'inside a contested window' : 'outside peak'} · evidence {c.default_evidence}</span>
        </div>
        <div className="cf-arrow" aria-hidden="true">→</div>
        <div className="cf-arm is-ours">
          <span className="cf-label">Helm chose</span>
          <strong className="num">{(c.chosen_p * 100).toFixed(1)}%</strong>
          <span className="hint">{c.chosen_at}</span>
          <span className="hint">{c.chosen_in_peak ? 'inside a contested window' : 'outside peak'} · evidence {c.chosen_evidence}</span>
        </div>
      </div>
      <p className="cf-verdict">{c.verdict}</p>
    </div>
  );
}

function TraceStrip({ trace }: { trace: DecisionTrace }) {
  return (
    <ol className="strip">
      {trace.steps.map((s) => (
        <li className="strip-step paper" key={s.stage}>
          <span className="eyebrow">{s.stage}</span>
          <strong>{s.headline}</strong>
          <p>{s.detail}</p>
        </li>
      ))}
    </ol>
  );
}

function PublicLedger() {
  const [totals, setTotals] = useState<PublicTotals | null>(null);

  useEffect(() => {
    api.publicTotals().then(setTotals).catch(() => setTotals(null));
  }, []);

  if (!totals) return null;

  return (
    <div className="tiles public-ledger">
      <div className="tile paper">
        <span className="eyebrow">Recovered for merchants, all time</span>
        <strong className="num">{rupees(totals.recovered_paise)}</strong>
        <span className="hint">
          {totals.recovered_count === 0
            ? 'No real customer has been charged yet. Write access is off until a merchant turns it on.'
            : `${totals.recovered_count} payments, from ${totals.attempts_made} attempts Helm chose to make`}
        </span>
      </div>
      <div className="tile paper">
        <span className="eyebrow">Businesses connected</span>
        <strong className="num">{totals.merchants_connected}</strong>
        <span className="hint">{totals.mandates_watched} mandates watched</span>
      </div>
      <div className="tile paper">
        <span className="eyebrow">Decisions recorded</span>
        <strong className="num">{totals.decisions_made}</strong>
        <span className="hint">{totals.decisions_denied} of them refusals</span>
      </div>
    </div>
  );
}

export default function Proof() {
  const [data, setData] = useState<ProofData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shell = useReveal<HTMLDivElement>('.proof-section', [data]);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/proof');
      if (!r.ok) throw new Error(`proof unavailable (${r.status})`);
      setData(await r.json() as ProofData);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <div className="shell onboard">
        <div className="state is-error"><strong>Could not build the proof</strong>{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="shell proof">
        <Announce label="Building the proof from live data">
          <SkeletonReport />
        </Announce>
      </div>
    );
  }

  const control = data.arms.find((a) => a.arm === 'control');
  const treatment = data.arms.find((a) => a.arm === 'treatment');
  const h = data.honesty;
  const o = data.outreach;
  const x = data.cross_merchant;
  const real = data.real;
  const cal = data.calibration;

  return (
    <div className="shell proof" ref={shell}>
      <header className="masthead">
        <a className="wordmark" href="/">Helm</a>
        <nav className="site-links" aria-label="Product">
          <a className="site-link" href="/onboard">Connect</a>
          <a className="site-link" href="/authorize">Mandates</a>
          <a className="site-link" href="/dashboard">Dashboard</a>
        </nav>
      </header>

      <h1 className="proof-title">
        Same attempt budget.<br />More money recovered.
      </h1>
      <p className="proof-intro">
        India gives a failed mandate one original attempt and three retries, then cancels it
        permanently. Helm cannot add attempts. It decides how to spend the ones that exist —
        and every decision below is recorded, replayable, and argued against the default schedule.
      </p>

      <PublicLedger />

      {real.connected && (
        <Section
          n={1}
          eyebrow="On a real Razorpay account"
          title="This is what Helm has actually seen."
          lede="A live Razorpay account, connected with read-only keys. These payments really failed, the decline codes are the ones Razorpay returned, and the classification is what Helm made of them."
        >
          <div className="tiles">
            <div className="tile paper">
              <span className="eyebrow">Real failed payments</span>
              <strong className="num">{real.failures}</strong>
              <span className="hint">{rupees(real.lost_paise)} that did not arrive</span>
            </div>
            <div className="tile paper">
              <span className="eyebrow">Live mandates</span>
              <strong className="num">{real.live_mandates}</strong>
              <span className="hint">authorised on UPI Autopay, chargeable</span>
            </div>
            <div className="tile paper">
              <span className="eyebrow">How it arrived</span>
              <strong className="num">{real.attempts_via_backfill + real.events_via_webhook}</strong>
              <span className="hint">
                {real.attempts_via_backfill} backfilled · {real.events_via_webhook} by signed webhook
              </span>
            </div>
          </div>

          {real.decline_codes.length > 0 && (
            <div className="paper table-wrap spaced">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Razorpay said</th>
                    <th scope="col">Helm classified it</th>
                    <th scope="col">Arrived by</th>
                    <th scope="col" className="num">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {real.decline_codes.map((c) => (
                    <tr key={`${c.reason}-${c.bucket}-${c.source}`}>
                      <td><code>{c.reason ?? 'no reason given'}</code></td>
                      <td><span className={`badge ${c.bucket}`}>{c.bucket.replace(/_/g, ' ').toLowerCase()}</span></td>
                      <td><span className="ref">{c.source}</span></td>
                      <td className="num">{c.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="proof-callout">
            <strong>{real.failures} failures is not enough to measure a policy against.</strong>{' '}
            It is enough to prove the integration is real: genuine credentials, genuine decline codes,
            a signed webhook, and a mandate that can actually be charged. The batch below exists
            because a policy needs volume to be measured, and this account does not have it yet.
          </p>
        </Section>
      )}

      <Section
        n={real.connected ? 2 : 1}
        eyebrow="Measured at volume, against a simulated gateway"
        title="Two arms, one population, recorded assignment"
        lede="The account above has four failures, which cannot separate two policies. So the same engine and the same executor run against a seeded gateway, where outcomes are drawn from a stated model rather than from a bank. Every rupee below is simulated. The decisions behind them are not."
      >
        {control && treatment ? (
          <>
            <div className="paper table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Arm</th>
                    <th scope="col" className="num">Mandates</th>
                    <th scope="col" className="num">Recovery attempts</th>
                    <th scope="col" className="num">At risk</th>
                    <th scope="col" className="num">Recovered</th>
                    <th scope="col" className="num">Per attempt</th>
                    <th scope="col" className="num">Halted</th>
                  </tr>
                </thead>
                <tbody>
                  {[control, treatment].map((a) => (
                    <tr key={a.arm} className={a.arm === 'treatment' ? 'is-ours' : undefined}>
                      <td><span className={`badge ${a.arm === 'treatment' ? 'healthy' : 'UNKNOWN'}`}>{a.arm}</span></td>
                      <td className="num">{a.mandates}</td>
                      <td className="num">{a.attempts_by_us + a.attempts_by_default}</td>
                      <td className="num amount">{rupees(a.amount_at_risk_paise)}</td>
                      <td className="num amount">{rupees(a.amount_recovered_paise)}</td>
                      <td className="num amount"><strong>{rupees(perAttempt(a))}</strong></td>
                      <td className="num">{a.mandates_halted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.edge_per_attempt_pct !== null && (
              <p className="proof-callout">
                <strong>{data.edge_per_attempt_pct > 0 ? '+' : ''}{data.edge_per_attempt_pct.toFixed(1)}% recovered per attempt.</strong>{' '}
                Treatment halted {treatment.mandates_halted - control.mandates_halted} more mandates than
                control. That is the price of maximising efficiency, and it is stated here rather than hidden.
              </p>
            )}
          </>
        ) : (
          <div className="state"><strong>No arms recorded yet</strong>Run the batch above.</div>
        )}
      </Section>

      {data.allowed_trace && (
        <Section
          n={real.connected ? 3 : 2}
          eyebrow="One decision, defended"
          title="Why this charge was timed the way it was"
          lede="Aggregates are easy to fake. This is a single decision, from the decline code through the model and the allocator to the rule that let it run."
        >
          {data.allowed_trace.counterfactual && (
            <CounterfactualCard c={data.allowed_trace.counterfactual} />
          )}
          <TraceStrip trace={data.allowed_trace} />
          <a className="link" href={`/dashboard#/trace/${data.allowed_trace.decision_id}`}>
            Open the full trace for decision {data.allowed_trace.decision_id} →
          </a>
        </Section>
      )}

      {data.refused_trace && (
        <Section
          n={real.connected ? 4 : 3}
          eyebrow="One decision, refused"
          title="The agent proposes. The policy engine disposes."
          lede="The model is never allowed to move money. Sixteen deterministic rules run after it, first refusal wins, and a refusal is logged as loudly as an approval."
        >
          <div className="refusal paper">
            <div className="refusal-side">
              <span className="eyebrow">The agent wanted</span>
              <strong>{data.refused_trace.steps.find((s) => s.stage === 'The agent')?.headline}</strong>
              <p>{data.refused_trace.steps.find((s) => s.stage === 'The agent')?.detail}</p>
            </div>
            <div className="refusal-side is-deny">
              <span className="eyebrow">The engine said</span>
              <strong>{data.refused_trace.steps.find((s) => s.stage === 'The policy engine')?.headline}</strong>
              <p>{data.refused_trace.steps.find((s) => s.stage === 'The policy engine')?.detail}</p>
            </div>
          </div>
          <p className="proof-callout">
            No attempt was spent and no money moved.{' '}
            <a className="link" href={`/dashboard#/trace/${data.refused_trace.decision_id}`}>
              See the whole chain →
            </a>
          </p>
        </Section>
      )}

      <Section
        n={real.connected ? 5 : 4}
        eyebrow="When no retry can work"
        title="Escalate to the customer, within the rules"
        lede="A dead card cannot be retried into life. Helm asks the customer to re-authorise, and lets them name a date instead of failing again."
      >
        <div className="tiles">
          <div className="tile paper">
            <span className="eyebrow">Outreach</span>
            <strong className="num">{Object.values(o.funnel).reduce((a, b) => a + b, 0)}</strong>
            <span className="hint">{Object.entries(o.funnel).map(([k, v]) => `${v} ${k}`).join(' · ')}</span>
          </div>
          <div className="tile paper">
            <span className="eyebrow">Promises to pay</span>
            <strong className="num">{o.promises_open + o.promises_kept + o.promises_broken}</strong>
            <span className="hint">{o.promises_kept} kept · {o.promises_broken} broken · {o.promises_open} open</span>
          </div>
          <div className="tile paper">
            <span className="eyebrow">Languages</span>
            <strong className="num">{Object.keys(o.languages).length}</strong>
            <span className="hint">English, Hinglish and Hindi templates</span>
          </div>
        </div>
        <p className="proof-callout">
          Quiet hours are enforced, contact is capped per cycle, every link expires, recipients are
          stored masked, and one click stops contact permanently. A customer who names a date moves
          the retry to that date instead of burning an attempt early.
        </p>
      </Section>

      <Section
        n={real.connected ? 6 : 5}
        eyebrow="Only possible across merchants"
        title="Two merchants should not fight over the same account on the same morning."
        lede="One merchant cannot see this. Helm sees every consenting merchant's schedule at once, so when several would debit the same customer within half an hour it spreads them instead of letting them knock each other out."
      >
        <div className="tiles">
          <div className="tile paper">
            <span className="eyebrow">Merchants sharing signals</span>
            <strong className="num">{x.merchants_sharing_signals}</strong>
            <span className="hint">{x.customers_seen_by_more_than_one} customers seen by more than one</span>
          </div>
          <div className="tile paper">
            <span className="eyebrow">Debits spread apart</span>
            <strong className="num">{x.debits_spread}</strong>
            <span className="hint">each carries the reason on its own decision</span>
          </div>
          <div className="tile paper">
            <span className="eyebrow">Collisions still pending</span>
            <strong className="num">{x.collisions_pending}</strong>
            <span className="hint">checked live against everything scheduled</span>
          </div>
        </div>

        <div className="report-block paper spaced">
          <h3>The claim underneath it, and how it could be proved wrong</h3>
          <p className="block-lede">
            If a failed debit is purely about an empty account, small and large amounts should fail
            at the same rate whenever the account is short. If it is partly a queue, large debits
            should fail disproportionately in the contested window and not outside it. Helm runs
            that comparison on its own data and reports the answer even when the answer is no.
          </p>
          <dl className="report-rows">
            <div><dt>Contested window</dt><dd>{x.contested_label}</dd></div>
            <div><dt>Compared against</dt><dd>{x.uncontested_label}</dd></div>
            <div><dt>Large-debit threshold</dt><dd>{rupees(x.contention_threshold_paise)}</dd></div>
            <div><dt>Verdict</dt><dd>{x.contention_verdict.replace(/_/g, ' ')}</dd></div>
          </dl>
          <p className="report-caveat spaced-sm">{x.contention_explanation}</p>
        </div>
      </Section>

      <Section
        n={real.connected ? 7 : 6}
        eyebrow="Was the model right?"
        title="Every prediction, scored against what happened."
        lede="The model states a probability before it acts, and that number is stored rather than recomputed later. Each one is then scored against the attempt it actually caused. A model nobody checks can claim anything."
      >
        <div className="tiles">
          <div className="tile paper">
            <span className="eyebrow">Predictions scored</span>
            <strong className="num">{cal.scored}</strong>
            <span className="hint">
              {cal.real_account_scored} on a real account
            </span>
          </div>
          <div className="tile paper">
            <span className="eyebrow">It said</span>
            <strong className="num">
              {cal.predicted_mean === null ? '—' : `${(cal.predicted_mean * 100).toFixed(1)}%`}
            </strong>
            <span className="hint">
              it happened {cal.observed_rate === null ? '—' : `${(cal.observed_rate * 100).toFixed(1)}%`} of the time
            </span>
          </div>
          <div className="tile paper">
            <span className="eyebrow">Skill over the base rate</span>
            <strong className="num">
              {cal.skill === null ? '—' : cal.skill.toFixed(2)}
            </strong>
            <span className="hint">
              Brier {cal.brier === null ? '—' : cal.brier.toFixed(3)} against {cal.baseline_brier === null ? '—' : cal.baseline_brier.toFixed(3)}
            </span>
          </div>
        </div>

        {cal.bands.length > 0 && (
          <div className="paper table-wrap spaced">
            <table>
              <thead>
                <tr>
                  <th scope="col">When it said</th>
                  <th scope="col" className="num">It meant</th>
                  <th scope="col" className="num">It happened</th>
                  <th scope="col" className="num">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {cal.bands.map((b) => (
                  <tr key={b.band}>
                    <td>{b.band}</td>
                    <td className="num">{(b.predicted_mean * 100).toFixed(1)}%</td>
                    <td className="num">{(b.observed_rate * 100).toFixed(1)}%</td>
                    <td className="num">{b.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="proof-callout">{cal.verdict}</p>
      </Section>

      <Section
        n={real.connected ? 8 : 7}
        eyebrow="What we do not know"
        title="The honesty metrics"
        lede="Anything that would flatter the numbers is reported here instead."
      >
        <div className="tiles">
          <div className="tile paper">
            <span className="eyebrow">Unclassified declines</span>
            <strong className="num">{(h.unmapped_share * 100).toFixed(1)}%</strong>
            <span className="hint">{h.unmapped_attempts} attempts Helm refused to guess at</span>
          </div>
          <div className="tile paper">
            <span className="eyebrow">Adversarial scenarios</span>
            <strong className="num">{h.handled}/{h.scenarios}</strong>
            <span className="hint">{h.detected} detected but unhandled · {h.unhandled} we still get wrong</span>
          </div>
          <div className="tile paper">
            <span className="eyebrow">Money</span>
            <strong className="num">simulated</strong>
            <span className="hint">no charge has reached a real customer</span>
          </div>
        </div>

        {h.open_gaps.length > 0 && (
          <div className="gaps paper">
            <h3>Still wrong, in our own words</h3>
            {h.open_gaps.map((g) => (
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

        <p className="proof-callout">
          Taxonomy <code>{h.taxonomy_version}</code>. Not one decline mapping has been confirmed by a
          real retry outcome yet, so every entry is marked unverified and the money behind unmapped
          codes is excluded from anything we call recoverable.
        </p>
      </Section>

      <footer className="proof-foot">
        <span>Generated live at {new Date(data.generated_at).toLocaleString('en-IN')}</span>
        <span>
          {data.scale.mandates} mandates · {data.scale.decisions} decisions · {data.scale.executions} executions
          {' '}in this instance
        </span>
      </footer>
    </div>
  );
}
