import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Control, Detail, DecisionTrace, Merchant, OutreachRow, QueueRow } from './api.ts';
import { signOut } from './session.ts';
import { Markdown } from './markdown.tsx';
import { Announce, SkeletonTable } from './skeletons.tsx';
import { bucketLabel, expiry, humanAction, humanMethod, ist, rupees, sinceNow } from './format.ts';

export function ChargeQueue() {
  const [data, setData] = useState<{ queue: QueueRow[]; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.chargeQueue().then(setData).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="state is-error"><strong>Could not load the queue</strong>{error}</div>;
  if (!data) return <Announce label="Loading"><SkeletonTable /></Announce>;
  if (data.queue.length === 0) {
    return <div className="state"><strong>Nothing to charge</strong>No at-risk mandate has an outstanding invoice.</div>;
  }

  return (
    <>
      <p className="hint">{data.note}</p>
      <div className="paper table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Method</th>
              <th scope="col" className="num">Amount</th>
              <th scope="col">Band</th>
              <th scope="col" className="num">Attempts left</th>
              <th scope="col">Last decline</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {data.queue.map((r) => (
              <tr key={r.subscription_id}>
                <td><a className="ref link" href={`#/mandate/${encodeURIComponent(r.subscription_id)}`}>{r.customer_ref}</a></td>
                <td>{humanMethod(r.method)}</td>
                <td className="num amount">{rupees(r.amount_paise)}</td>
                <td><span className={`badge ${r.risk_band}`}>{bucketLabel(r.risk_band)}</span></td>
                <td className="num">{r.attempts_remaining}</td>
                <td>
                  <span className={`badge ${r.last_bucket ?? 'UNKNOWN'}`}>{bucketLabel(r.last_bucket)}</span>
                  {r.last_error_reason && <> <span className="ref">{r.last_error_reason}</span></>}
                </td>
                <td>
                  {r.chargeable
                    ? <span className="badge healthy">charge in dashboard</span>
                    : <span className="blocked" title={r.blocked_reason ?? ''}>cannot be charged</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface ActionResult {
  action: string;
  verdict: string;
  rule_id: string;
  explanation: string | null;
  scheduled_for: string | null;
}

const ACTIONS: { action: string; label: string; hint: string }[] = [
  { action: 'RETRY_SCHEDULED', label: 'Charge this now', hint: 'Ask for an attempt against the remaining budget.' },
  { action: 'REAUTH_OUTREACH', label: 'Ask for a new mandate', hint: 'Send the customer a re-authorisation link.' },
  { action: 'STOP', label: 'Leave this alone', hint: 'Stop working this mandate for the rest of the cycle.' },
];

function MandateActions({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(action: string) {
    setBusy(action);
    setError(null);
    setResult(null);
    try {
      setResult(await api.act(id, action, note.trim() || undefined));
      setNote('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mandate-actions">
      <h3 className="sub">What you can do</h3>
      <p className="hint">
        Your request goes through the same sixteen rules the agent does. If a rule refuses it, the
        refusal is recorded against your name rather than quietly dropped.
      </p>

      <label htmlFor="note">Why (optional)</label>
      <input
        id="note" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Customer rang and said their salary lands Friday"
      />

      <div className="action-row">
        {ACTIONS.map((a) => (
          <button
            key={a.action} type="button" className="cta ghost"
            title={a.hint} disabled={busy !== null}
            onClick={() => void run(a.action)}
          >
            {busy === a.action ? 'Asking…' : a.label}
          </button>
        ))}
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      {result && (
        <div className={`verdict-card ${result.verdict === 'ALLOW' ? 'is-allow' : 'is-deny'}`} role="status">
          <span className={`badge ${result.verdict === 'ALLOW' ? 'healthy' : 'critical'}`}>
            {result.verdict}
          </span>
          <span className="ref">{result.rule_id}</span>
          <p>{result.explanation ?? (result.verdict === 'ALLOW' ? 'Queued.' : 'Refused.')}</p>
          {result.scheduled_for && (
            <p className="hint">Scheduled for {ist(result.scheduled_for)}.</p>
          )}
        </div>
      )}
    </section>
  );
}

export function MandateDetail({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.detail(id).then(setData).catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    setData(null);
    reload();
  }, [id, reload]);

  if (error) return <div className="state is-error"><strong>Could not load this mandate</strong>{error}</div>;
  if (!data) return <Announce label="Loading"><SkeletonTable /></Announce>;

  const s = data.subscription as Record<string, string | number | null>;
  const latest = data.health[0];

  return (
    <>
      <div className="detail-head">
        <div>
          <div className="eyebrow">Mandate</div>
          <h2 className="detail-title">{String(s['customer_ref'])}</h2>
          <div className="detail-meta">
            <span>{humanMethod(String(s['method']))}</span>
            <span>{rupees(Number(s['amount_paise']))}</span>
            <span>{String(s['status'])}</span>
            <span className="ref">{String(s['rzp_subscription_id'])}</span>
          </div>
        </div>
        {latest && (
          <div className="detail-score">
            <div className={`badge ${latest.risk_band}`}>{bucketLabel(latest.risk_band)}</div>
            <div className="score">{latest.risk_score.toFixed(2)}</div>
            <div className="note">{latest.attempts_remaining} attempts left · {expiry(latest.days_to_expiry)}</div>
          </div>
        )}
      </div>

      <MandateActions id={id} onDone={reload} />

      {latest && Object.keys(latest.contributions).length > 0 && (
        <section>
          <h3 className="sub">What drives the score</h3>
          <div className="contribs">
            {Object.entries(latest.contributions)
              .filter(([, v]) => v > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <div className="contrib" key={k}>
                  <span className="k">{k.replace(/_/g, ' ')}</span>
                  <span className="bar"><i style={{ width: `${Math.min(100, v * 100)}%` }} /></span>
                  <span className="v">{v.toFixed(2)}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="sub">Decisions <span className="count">{data.decisions.length}</span></h3>
        {data.decisions.length === 0
          ? <div className="state">No decision recorded for this mandate yet.</div>
          : (
            <ol className="decisions">
              {data.decisions.map((d) => {
                const cls = d.verdict === 'ALLOW' ? 'is-allow' : d.verdict === 'DENY' ? 'is-deny' : 'is-defer';
                return (
                  <li className={`decision ${cls}`} key={d.id}>
                    <div className="verdict">{d.verdict}</div>
                    <div>
                      <div className="top">
                        <span className="rule">{d.rule_id}</span>
                        <span className="what">{humanAction(d.proposed_action)}</span>
                        <span className="what">via {d.proposed_by}</span>
                        <time className="when" dateTime={d.created_at}>{sinceNow(d.created_at)}</time>
                      </div>
                      <p className="explain">{d.explanation}</p>
                      {d.rationale && <p className="said">{d.rationale}</p>}
                      <div className="slot">
                        {d.scheduled_for && <span><b>Scheduled</b> {ist(d.scheduled_for)} IST</span>}
                        {d.outcome && <span><b>Outcome</b> {d.outcome}</span>}
                        {d.explored && <span className="badge UNKNOWN">exploration</span>}
                        {d.logging_propensity != null && <span>p={d.logging_propensity}</span>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
      </section>

      <section>
        <h3 className="sub">Attempts <span className="count">{data.attempts.length}</span></h3>
        {data.attempts.length === 0
          ? <div className="state">No attempt recorded.</div>
          : (
            <div className="paper table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">Amount</th>
                    <th scope="col">Bucket</th>
                    <th scope="col">Reason</th>
                    <th scope="col">By</th>
                    <th scope="col">Counts</th>
                  </tr>
                </thead>
                <tbody>
                  {data.attempts.map((a, i) => (
                    <tr key={a.rzp_payment_id ?? i}>
                      <td>{ist(a.attempted_at)}</td>
                      <td><span className={`badge ${a.status === 'captured' ? 'healthy' : a.status === 'failed' ? 'critical' : 'UNKNOWN'}`}>{a.status}</span></td>
                      <td className="num amount">{rupees(a.amount_paise)}</td>
                      <td><span className={`badge ${a.bucket ?? 'UNKNOWN'}`}>{bucketLabel(a.bucket)}</span></td>
                      <td><span className="ref">{a.error_reason ?? '—'}</span></td>
                      <td>{a.initiated_by === 'mandate_rescue' ? 'Helm' : 'gateway'}<br /><span className="ref">{a.source}</span></td>
                      <td>{a.counts_against_budget ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      {data.intents.length > 0 && (
        <section>
          <h3 className="sub">Execution intents <span className="count">{data.intents.length}</span></h3>
          <div className="paper table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">Attempt</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col">Scheduled</th>
                  <th scope="col">Dry run</th>
                </tr>
              </thead>
              <tbody>
                {data.intents.map((it) => (
                  <tr key={it.idempotency_key}>
                    <td><span className="ref">{it.idempotency_key}</span></td>
                    <td>
                      <span className={`badge ${it.state === 'SETTLED_SUCCESS' ? 'healthy' : it.state === 'SETTLED_FAILED' ? 'critical' : 'UNKNOWN'}`}>
                        {it.state.toLowerCase().replace(/_/g, ' ')}
                      </span>
                      {it.amount_mismatch && <span className="badge critical">amount mismatch</span>}
                    </td>
                    <td className="num">{it.attempt_number}</td>
                    <td className="num amount">{rupees(it.amount_paise)}</td>
                    <td>{ist(it.scheduled_for)}</td>
                    <td>{it.dry_run ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export function Reports({ slug }: { slug: string | null }) {
  const [list, setList] = useState<{ slug: string; title: string; description: string }[] | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.reports().then((r) => setList(r.reports)).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!slug) { setMarkdown(null); return; }
    setMarkdown(null);
    api.report(slug).then((r) => setMarkdown(r.markdown)).catch((e: Error) => setError(e.message));
  }, [slug]);

  if (error) return <div className="state is-error"><strong>Could not load reports</strong>{error}</div>;
  if (!list) return <Announce label="Loading"><SkeletonTable /></Announce>;
  if (list.length === 0) {
    return <div className="state"><strong>No reports available</strong>None are registered on this instance.</div>;
  }

  const current = list.find((r) => r.slug === slug);

  return (
    <>
      <nav className="report-tabs" aria-label="Reports">
        {list.map((r) => (
          <a
            key={r.slug}
            className={`report-tab${slug === r.slug ? ' is-current' : ''}`}
            href={`#/reports/${r.slug}`}
            aria-current={slug === r.slug ? 'page' : undefined}
          >
            {r.title}
          </a>
        ))}
      </nav>
      {current && <p className="hint">{current.description} Built live when you opened it.</p>}
      {!slug && (
        <div className="state">
          <strong>Pick a report</strong>
          Each one is generated from this instance when you open it, not read from a file.
        </div>
      )}
      {slug && !markdown && (
        <Announce label={`Building the ${current?.title ?? slug} report`}>
          <SkeletonTable rows={8} />
        </Announce>
      )}
      {markdown && <div className="paper report">{<Markdown source={markdown} />}</div>}
    </>
  );
}

export function Account() {
  const [rows, setRows] = useState<Merchant[] | null>(null);
  useEffect(() => { api.merchants().then((r) => setRows(r.merchants)).catch(() => setRows([])); }, []);

  if (!rows) return <Announce label="Loading"><SkeletonTable /></Announce>;

  const m = rows[0];
  if (!m) {
    return (
      <div className="state">
        <strong>No account yet</strong>
        Connect a Razorpay account or import a CSV to begin.
      </div>
    );
  }

  return (
    <>
      <div className="tiles">
        <div className="tile paper">
          <span className="eyebrow">Business</span>
          <strong className="name">{m.name}</strong>
          <span className="hint">{m.id}</span>
        </div>
        <div className="tile paper">
          <span className="eyebrow">Mandates watched</span>
          <strong className="num">{m.subscriptions}</strong>
          <span className="hint">
            {m.integration === 'subscriptions' ? 'Razorpay Subscriptions'
              : m.integration === 'recurring_tokens' ? 'saved mandates charged directly'
              : 'imported from a file'}
          </span>
        </div>
        <div className="tile paper">
          <span className="eyebrow">Write access</span>
          <strong className="name">
            <span className={`badge ${m.write_enabled ? 'at_risk' : 'healthy'}`}>
              {m.write_enabled ? 'charging enabled' : 'read only'}
            </span>
          </strong>
          <span className="hint">
            {m.consent_signed_at
              ? `You granted this on ${ist(m.consent_signed_at)}. Revoke it on the connect page.`
              : 'Nothing will be charged until you grant access on the connect page.'}
          </span>
        </div>
        <div className="tile paper">
          <span className="eyebrow">Mode</span>
          <strong className="name">
            <span className={`badge ${m.mode === 'live' ? 'critical' : 'healthy'}`}>{m.mode}</span>
          </strong>
          <span className="hint">
            {m.cross_merchant_signals
              ? 'Sharing timing signals with other businesses, so a customer is not debited twice in one morning.'
              : 'Not sharing timing signals with other businesses.'}
          </span>
        </div>
      </div>

      <SignOut />
    </>
  );
}

function SignOut() {
  return (
    <div className="paper sign-out">
      <div>
        <strong>This browser is signed in to that account</strong>
        <p className="hint">
          Signing out forgets the link on this device only. It keeps working everywhere else, so
          use it before handing this machine to someone else.
        </p>
      </div>
      <button
        type="button"
        className="cta ghost"
        onClick={() => { void signOut().then(() => window.location.reload()); }}
      >
        Sign out
      </button>
    </div>
  );
}

export function KillSwitch({ control, onChange }: { control: Control; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function engage() {
    setBusy(true);
    setError(null);
    try {
      await api.setKillSwitch(true, undefined, 'engaged from dashboard');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    const token = window.prompt('Release token');
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.setKillSwitch(false, token);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`killswitch${control.kill_switch ? ' is-engaged' : ''}`}>
      <div>
        <div className="label">Kill switch</div>
        <div className="value">{control.kill_switch ? 'ENGAGED' : 'clear'}</div>
        <div className="note">
          {control.kill_switch
            ? (control.kill_switch_reason ?? 'all execution halted')
            : `dry run ${control.dry_run ? 'on' : 'OFF'} · ${control.mode} mode`}
        </div>
        {error && <div className="note err">{error}</div>}
      </div>
      {control.kill_switch
        ? <button type="button" className="retry" onClick={() => void release()} disabled={busy}>Release</button>
        : <button type="button" className="danger" onClick={() => void engage()} disabled={busy}>Halt everything</button>}
    </div>
  );
}

const OUTREACH_BADGE: Record<string, string> = {
  sent: 'healthy',
  viewed: 'SOFT_LIQUIDITY',
  converted: 'healthy',
  queued: 'at_risk',
  failed: 'critical',
  expired: 'UNKNOWN',
  revoked: 'UNKNOWN',
};

const FUNNEL_ORDER = ['queued', 'sent', 'viewed', 'converted', 'expired', 'revoked', 'failed'];

export function Outreach() {
  const [data, setData] = useState<{ outreach: OutreachRow[]; funnel: Record<string, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.outreach().then(setData).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="state is-error"><strong>Could not load outreach</strong>{error}</div>;
  if (!data) return <Announce label="Loading"><SkeletonTable /></Announce>;
  if (data.outreach.length === 0) {
    return (
      <div className="state">
        <strong>Nobody has been contacted</strong>
        Outreach happens when a mandate fails for a reason no retry can fix.
      </div>
    );
  }

  const funnel = FUNNEL_ORDER.filter((k) => data.funnel[k]);

  return (
    <>
      <p className="hint">
        When a decline cannot be fixed by retrying, Helm asks the customer to re-authorise.
        Every message is capped, quiet-hours aware, and revocable by the customer.
      </p>

      <div className="tiles">
        {funnel.map((k) => (
          <div className="tile paper" key={k}>
            <span className="eyebrow">{k}</span>
            <strong className="num">{data.funnel[k]}</strong>
          </div>
        ))}
      </div>

      <div className="paper table-wrap spaced-lg">
        <table>
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col" className="num">Amount</th>
              <th scope="col">Channel</th>
              <th scope="col">Sent to</th>
              <th scope="col">Status</th>
              <th scope="col">Created</th>
              <th scope="col">Expires</th>
            </tr>
          </thead>
          <tbody>
            {data.outreach.map((o) => (
              <tr key={o.id}>
                <td><a className="ref link" href={`#/mandate/${encodeURIComponent(o.subscription_id)}`}>{o.customer_ref}</a></td>
                <td className="num amount">{rupees(o.amount_paise)}</td>
                <td>{o.channel === 'none' ? <span className="ref">no contact</span> : o.channel}</td>
                <td><span className="ref">{o.recipient_masked ?? '—'}</span></td>
                <td>
                  <span className={`badge ${OUTREACH_BADGE[o.status] ?? 'UNKNOWN'}`}>{o.status}</span>
                  {o.error && <> <span className="ref">{o.error}</span></>}
                </td>
                <td>{ist(o.created_at)}</td>
                <td>{ist(o.expires_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Trace({ id }: { id: string }) {
  const [trace, setTrace] = useState<DecisionTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTrace(null);
    setError(null);
    api.trace(id).then(setTrace).catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="state is-error">
        <strong>Could not trace that decision</strong>{error}
        <a className="link" href="#/">Back to the overview</a>
      </div>
    );
  }
  if (!trace) return <Announce label="Tracing the decision"><SkeletonTable rows={7} /></Announce>;

  const c = trace.counterfactual;

  return (
    <>
      <div className="detail-head">
        <div>
          <span className="eyebrow">Decision {trace.decision_id}</span>
          <h2 className="detail-title">{trace.customer_ref}</h2>
          <div className="detail-meta">
            <span className="num amount">{rupees(trace.amount_paise)}</span>
            {trace.arm && <span className="badge healthy">{trace.arm}</span>}
            {trace.outcome && <span className="badge SOFT_LIQUIDITY">{trace.outcome}</span>}
            <a className="ref link" href={`#/mandate/${encodeURIComponent(trace.subscription_id)}`}>
              {trace.subscription_id}
            </a>
          </div>
        </div>
      </div>

      <p className="trace-headline">{trace.headline}</p>

      {c && (
        <div className="counterfactual paper">
          <div className="eyebrow">What the default schedule would have done</div>
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
      )}

      <ol className="trace">
        {trace.steps.map((s, i) => (
          <li className="trace-step" key={s.stage}>
            <span className="trace-index" aria-hidden="true">{i + 1}</span>
            <div className="trace-body paper">
              <span className="eyebrow">{s.stage}</span>
              <h3>{s.headline}</h3>
              <p>{s.detail}</p>
              {Object.entries(s.facts).filter(([, v]) => v !== null && v !== '').length > 0 && (
                <dl className="trace-facts">
                  {Object.entries(s.facts)
                    .filter(([, v]) => v !== null && v !== '')
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt>{k.replace(/_/g, ' ')}</dt>
                        <dd>{String(v)}</dd>
                      </div>
                    ))}
                </dl>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
