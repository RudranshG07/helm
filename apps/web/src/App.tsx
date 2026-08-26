import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { AtRiskRow, DeclineRow, DecisionRow, DenialRow, Overview, UnmappedRow } from './api.ts';
import { ist, relativeDays, rupees } from './format.ts';

interface Data {
  overview: Overview;
  atRisk: AtRiskRow[];
  distribution: DeclineRow[];
  unmapped: UnmappedRow[];
  decisions: DecisionRow[];
  denials: DenialRow[];
}

function Tiles({ o }: { o: Overview }) {
  const failureRate = o.attempts_last_30d > 0
    ? Math.round((o.failed_last_30d / o.attempts_last_30d) * 100)
    : 0;

  return (
    <div className="tiles">
      <div className="tile danger">
        <div className="label">Revenue at risk</div>
        <div className="value">{rupees(o.amount_at_risk_paise)}</div>
        <div className="note">across {o.at_risk_count + o.critical_count} mandates</div>
      </div>
      <div className="tile danger">
        <div className="label">Critical</div>
        <div className="value">{o.critical_count}</div>
        <div className="note">final attempt, expiring, or hard decline</div>
      </div>
      <div className="tile warn">
        <div className="label">At risk</div>
        <div className="value">{o.at_risk_count}</div>
        <div className="note">failing, attempts remain</div>
      </div>
      <div className="tile">
        <div className="label">Halted</div>
        <div className="value">{o.halted_count}</div>
        <div className="note">mandate dead, needs re-auth</div>
      </div>
      <div className="tile">
        <div className="label">Failures, 30d</div>
        <div className="value">{o.failed_last_30d}</div>
        <div className="note">of {o.attempts_last_30d} attempts ({failureRate}%)</div>
      </div>
      <div className="tile">
        <div className="label">Unmapped codes</div>
        <div className="value">{o.unmapped_codes}</div>
        <div className="note">{o.unmapped_attempts} attempts not yet classified</div>
      </div>
    </div>
  );
}

function AtRiskTable({ rows }: { rows: AtRiskRow[] }) {
  if (rows.length === 0) {
    return <div className="empty">No mandates currently at risk.</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>Method</th>
          <th className="num">Amount</th>
          <th>Band</th>
          <th className="num">Score</th>
          <th className="num">Fails</th>
          <th className="num">Attempts left</th>
          <th>Expiry</th>
          <th>Last decline</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.subscription_id}>
            <td><code>{r.customer_ref}</code></td>
            <td>{r.method.replace('_', ' ')}</td>
            <td className="num">{rupees(r.amount_paise)}</td>
            <td><span className={`badge ${r.risk_band}`}>{r.risk_band.replace('_', ' ')}</span></td>
            <td className="num">{r.risk_score.toFixed(2)}</td>
            <td className="num">{r.consecutive_failures}</td>
            <td className={`num attempts-left${r.attempts_remaining <= 1 ? ' low' : ''}`}>
              {r.attempts_remaining}
            </td>
            <td>{relativeDays(r.days_to_expiry)}</td>
            <td>
              {r.last_bucket ? <span className={`badge ${r.last_bucket}`}>{r.last_bucket}</span> : '—'}
              {r.last_error_reason ? <> <code>{r.last_error_reason}</code></> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DeclineTable({ rows }: { rows: DeclineRow[] }) {
  if (rows.length === 0) return <div className="empty">No failures recorded yet.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Bucket</th>
          <th>Reason</th>
          <th>Source</th>
          <th>Method</th>
          <th className="num">Attempts</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.error_reason}-${r.method}-${i}`}>
            <td><span className={`badge ${r.bucket}`}>{r.bucket}</span></td>
            <td><code>{r.error_reason ?? 'null'}</code></td>
            <td>{r.error_source ?? '—'}</td>
            <td>{r.method.replace('_', ' ')}</td>
            <td className="num">{r.attempts}</td>
            <td className="num">{rupees(r.amount_paise)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UnmappedTable({ rows }: { rows: UnmappedRow[] }) {
  if (rows.length === 0) {
    return <div className="empty">Every observed decline code is classified.</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Reason</th>
          <th>Source</th>
          <th>Step</th>
          <th className="num">Attempts</th>
          <th className="num">Amount</th>
          <th>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.error_reason}-${i}`}>
            <td><code>{r.error_reason ?? 'null'}</code></td>
            <td>{r.error_source ?? '—'}</td>
            <td>{r.error_step ?? '—'}</td>
            <td className="num">{r.attempts}</td>
            <td className="num">{rupees(r.amount_paise)}</td>
            <td>{ist(r.last_seen)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Decisions({ rows, denials }: { rows: DecisionRow[]; denials: DenialRow[] }) {
  if (rows.length === 0) {
    return <div className="empty">No decisions recorded yet.</div>;
  }
  return (
    <>
      {denials.length > 0 && (
        <div className="rule-counts">
          {denials.map((d) => (
            <span className="rule-count" key={`${d.rule_id}-${d.verdict}`}>
              <span className="id">{d.rule_id}</span>
              <span className="n">{d.verdict.toLowerCase()} &times;{d.count}</span>
            </span>
          ))}
        </div>
      )}
      <div className="decision-list">
        {rows.map((d) => (
          <article className={`decision ${d.verdict}`} key={d.id}>
            <div className="verdict">{d.verdict}</div>
            <div>
              <div className="head">
                <span className="rule">{d.rule_id}</span>
                <span className="action">{d.proposed_action.replace(/_/g, ' ').toLowerCase()}</span>
                <span className="action">&middot; {d.subscription_id}</span>
                <span className="when">{ist(d.created_at)}</span>
              </div>
              <div className="explanation">{d.explanation}</div>
              {d.rationale && <div className="rationale">&ldquo;{d.rationale}&rdquo;</div>}
              {d.scheduled_for && (
                <div className="scheduled">
                  scheduled {ist(d.scheduled_for)}
                  {d.proposed_for && d.proposed_for !== d.scheduled_for
                    ? ` \u00b7 moved from ${ist(d.proposed_for)}`
                    : ''}
                </div>
              )}
              {d.outcome && <div className="scheduled">outcome: {d.outcome}</div>}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [overview, atRiskRes, declines, decisions] = await Promise.all([
          api.overview(),
          api.atRisk(),
          api.declines(),
          api.decisions(),
        ]);
        if (!cancelled) {
          setData({
            overview,
            atRisk: atRiskRes.subscriptions,
            distribution: declines.distribution,
            unmapped: declines.unmapped,
            decisions: decisions.decisions,
            denials: decisions.denials_by_rule,
          });
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error) return <div className="shell"><div className="error">{error}</div></div>;
  if (!data) return <div className="shell"><div className="empty">Loading…</div></div>;

  return (
    <div className="shell">
      <header>
        <h1>Mandate Rescue</h1>
        <span className="sub">read-only</span>
      </header>
      <p className="tagline">
        Mandates in the window between a failed charge and a halted subscription.
      </p>

      <Tiles o={data.overview} />

      <section>
        <h2>Decisions</h2>
        <p className="hint">
          Every verdict, approvals and refusals alike, with the rule that produced it. A refusal
          is an attempt not spent on a mandate that could not have been saved.
        </p>
        <Decisions rows={data.decisions} denials={data.denials} />
      </section>

      <section>
        <h2>Mandates at risk</h2>
        <p className="hint">
          Ordered by band, then by amount. Attempts left counts every attempt in the cycle,
          Razorpay's and ours, against the network budget.
        </p>
        <AtRiskTable rows={data.atRisk} />
      </section>

      <section>
        <h2>Why they failed</h2>
        <p className="hint">
          Hard declines cannot be recovered by retrying. Every attempt spent on one is an
          attempt unavailable to a mandate that could have been saved.
        </p>
        <DeclineTable rows={data.distribution} />
      </section>

      <section>
        <h2>Unmapped decline codes</h2>
        <p className="hint">
          Codes not yet in the taxonomy. These get one conservative attempt rather than the full
          budget, and are listed here rather than silently bucketed.
        </p>
        <UnmappedTable rows={data.unmapped} />
      </section>
    </div>
  );
}
