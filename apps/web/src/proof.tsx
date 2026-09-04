import { useCallback, useEffect, useState } from 'react';
import { useReveal } from './reveal.ts';
import { rupees } from './format.ts';
import type { Counterfactual, DecisionTrace } from './api.ts';
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

interface ProofData {
  generated_at: string;
  scale: Record<string, number>;
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

export default function Proof() {
  const [data, setData] = useState<ProofData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string | null>(null);
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

  async function runBatch() {
    setRunning(true);
    setStep('Clearing the last run and seeding 60 mandates');
    try {
      const started = Date.now();
      const ticker = window.setInterval(() => {
        const elapsed = Date.now() - started;
        if (elapsed > 6000) setStep('Executing charges, exactly once');
        else if (elapsed > 3000) setStep('Ranking candidate times and applying the rules');
        else setStep('Clearing the last run and seeding 60 mandates');
      }, 900);

      const r = await fetch('/api/authorize/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 60 }),
      });
      window.clearInterval(ticker);

      if (!r.ok) throw new Error(`the batch failed (${r.status})`);
      setStep('Rebuilding the numbers from the database');
      await load();
      setStep(null);
    } catch (e) {
      setStep(null);
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

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

      <div className="proof-actions">
        <button type="button" className="cta" onClick={() => void runBatch()} disabled={running}>
          {running && <span className="spinner" aria-hidden="true" />}
          {running ? 'Running…' : 'Run the whole thing again'}
        </button>
        <span className="field-note" role="status" aria-live="polite">
          {step ?? 'Clears the last run, then puts 60 mandates through the real decision engine and executor against a simulated gateway, anchored to 09:00 IST today so repeated runs are comparable.'}
        </span>
      </div>

      <Section
        n={1}
        eyebrow="The claim"
        title="Two arms, one population, recorded assignment"
        lede="Every mandate is assigned to control or treatment by a stable hash, written to the database once, and never changed. Control gets the fixed T+1/T+2/T+3 schedule. Treatment gets Helm."
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
          n={2}
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
          n={3}
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
        n={4}
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
        n={5}
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

        <div className="report-block paper" style={{ marginTop: 18 }}>
          <h3>The claim underneath it, and how it could be proved wrong</h3>
          <p style={{ margin: '0 0 14px', color: 'var(--ink-soft)', lineHeight: 1.55 }}>
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
          <p className="report-caveat" style={{ marginTop: 14 }}>{x.contention_explanation}</p>
        </div>
      </Section>

      <Section
        n={6}
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
