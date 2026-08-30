import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Control, Detail, Merchant, OutreachRow, QueueRow } from './api.ts';
import { Markdown } from './markdown.tsx';
import { bucketLabel, expiry, humanAction, humanMethod, ist, rupees, sinceNow } from './format.ts';

export function ChargeQueue() {
  const [data, setData] = useState<{ queue: QueueRow[]; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.chargeQueue().then(setData).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="state is-error"><strong>Could not load the queue</strong>{error}</div>;
  if (!data) return <div className="skeleton tall" />;
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

export function MandateDetail({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api.detail(id).then(setData).catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <div className="state is-error"><strong>Could not load this mandate</strong>{error}</div>;
  if (!data) return <div className="skeleton tall" />;

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
  const [list, setList] = useState<{ slug: string; file: string }[] | null>(null);
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
  if (!list) return <div className="skeleton tall" />;
  if (list.length === 0) {
    return <div className="state"><strong>No reports generated yet</strong>Run the analysis commands to produce them.</div>;
  }

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
            {r.slug.replace(/-/g, ' ')}
          </a>
        ))}
      </nav>
      {!slug && <div className="state">Pick a report.</div>}
      {slug && !markdown && <div className="skeleton tall" />}
      {markdown && <div className="paper report">{<Markdown source={markdown} />}</div>}
    </>
  );
}

export function Merchants() {
  const [rows, setRows] = useState<Merchant[] | null>(null);
  useEffect(() => { api.merchants().then((r) => setRows(r.merchants)).catch(() => setRows([])); }, []);
  if (!rows) return <div className="skeleton tall" />;
  if (rows.length === 0) return <div className="state"><strong>No merchants</strong>Import a CSV or connect an account.</div>;

  return (
    <div className="paper table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Merchant</th>
            <th scope="col">Mode</th>
            <th scope="col">Integration</th>
            <th scope="col" className="num">Mandates</th>
            <th scope="col">Write access</th>
            <th scope="col">Pooling</th>
            <th scope="col">Consent</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{m.name}<br /><span className="ref">{m.id}</span></td>
              <td><span className={`badge ${m.mode === 'live' ? 'critical' : 'healthy'}`}>{m.mode}</span></td>
              <td>{m.integration ?? <span className="ref">unknown</span>}</td>
              <td className="num">{m.subscriptions}</td>
              <td>{m.write_enabled ? <span className="badge critical">enabled</span> : <span className="badge healthy">read only</span>}</td>
              <td>{m.cross_merchant_signals ? 'opted in' : 'opted out'}</td>
              <td>{m.consent_signed_at ? ist(m.consent_signed_at) : <span className="ref">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
  if (!data) return <div className="skeleton tall" />;
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

      <div className="paper table-wrap" style={{ marginTop: 20 }}>
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
