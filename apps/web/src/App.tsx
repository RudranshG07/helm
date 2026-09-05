import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { NotConnected, signIn } from './session.ts';
import type { AtRiskRow, Control, DeclineRow, DecisionRow, DenialRow, Overview, UnmappedRow } from './api.ts';
import { Account, ChargeQueue, KillSwitch, MandateDetail, Outreach, Reports, Trace } from './views.tsx';
import { Announce, SkeletonReport } from './skeletons.tsx';
import { bucketLabel, compactRupees, expiry, humanAction, humanMethod, ist, rupees, sinceNow } from './format.ts';

interface Data {
  overview: Overview;
  atRisk: AtRiskRow[];
  distribution: DeclineRow[];
  unmapped: UnmappedRow[];
  decisions: DecisionRow[];
  denials: DenialRow[];
}

const TABS = [
  { route: '', label: 'Overview' },
  { route: 'queue', label: 'Charge queue' },
  { route: 'outreach', label: 'Outreach' },
  { route: 'account', label: 'Account' },
  { route: 'reports', label: 'Reports' },
] as const;

function Masthead({ mode, route, killed, business }: {
  mode: string | null; route: string; killed: boolean; business?: string | null;
}) {
  const live = mode === 'live';
  return (
    <header className="masthead">
      <a className="wordmark" href="#/">Helm</a>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a
            key={t.route}
            className={`tab${route === t.route ? ' is-current' : ''}`}
            href={`#/${t.route}`}
            aria-current={route === t.route ? 'page' : undefined}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <div className="meta">
        <nav className="site-links" aria-label="Product">
          <a className="site-link" href="/proof">Proof</a>
          <a className="site-link" href="/docs">Docs</a>
          <a className="site-link" href="/onboard">Connect</a>
          <a className="site-link" href="/authorize">Mandates</a>
          <a className="site-link" href="/">Home</a>
        </nav>
        {business && <span className="whose" title="The account this link belongs to">{business}</span>}
        {killed && <span className="mode is-live"><span className="dot" aria-hidden="true" />halted</span>}
        <span className={`mode${live ? ' is-live' : ''}`}>
          <span className="dot" aria-hidden="true" />
          {live ? 'live' : 'test mode'}
        </span>
      </div>
    </header>
  );
}

function useHashRoute(): { route: string; param: string | null } {
  const read = () => {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const [head, ...rest] = raw.split('/');
    return { route: head ?? '', param: rest.length > 0 ? decodeURIComponent(rest.join('/')) : null };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const on = () => setState(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return state;
}

function Headline({ o }: { o: Overview }) {
  const inDanger = o.at_risk_count + o.critical_count;
  return (
    <div className="headline">
      <div>
        <p className="figure">{compactRupees(o.amount_at_risk_paise)}</p>
        <p className="caption">
          at risk across {inDanger} {inDanger === 1 ? 'mandate' : 'mandates'} still inside the
          window between a failed charge and a permanent halt.
        </p>
      </div>

      <div className="tiles">
        <div className="tile is-critical">
          <div className="label">Critical</div>
          <div className="value">{o.critical_count}</div>
          <div className="note">final attempt, expiring, or hard decline</div>
        </div>
        <div className="tile is-warn">
          <div className="label">At risk</div>
          <div className="value">{o.at_risk_count}</div>
          <div className="note">failing, attempts remain</div>
        </div>
        <div className="tile">
          <div className="label">Halted</div>
          <div className="value">{o.halted_count}</div>
          <div className="note">mandate gone, needs re-authorization</div>
        </div>
        <div className="tile">
          <div className="label">Unclassified</div>
          <div className="value">{o.unmapped_codes}</div>
          <div className="note">
            {o.unmapped_attempts} {o.unmapped_attempts === 1 ? 'attempt' : 'attempts'} on codes not
            in the taxonomy
          </div>
        </div>
      </div>
    </div>
  );
}

function Decisions({ rows, denials }: { rows: DecisionRow[]; denials: DenialRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="state">
        <strong>No decisions yet</strong>
        A decision is recorded the moment a mandate enters the window. Nothing is waiting.
      </div>
    );
  }

  return (
    <>
      {denials.length > 0 && (
        <div className="rules">
          {denials.map((d) => (
            <span className="rule-chip" key={`${d.rule_id}-${d.verdict}`}>
              <code>{d.rule_id}</code>
              <span className="n">{d.verdict.toLowerCase()} &times;{d.count}</span>
            </span>
          ))}
        </div>
      )}

      <ol className="decisions">
        {rows.map((d) => {
          const cls = d.verdict === 'ALLOW' ? 'is-allow' : d.verdict === 'DENY' ? 'is-deny' : 'is-defer';
          const moved = d.proposed_for && d.scheduled_for && d.proposed_for !== d.scheduled_for;
          return (
            <li className={`decision ${cls}`} key={d.id}>
              <div className="verdict">{d.verdict}</div>
              <div>
                <div className="top">
                  <span className="rule">{d.rule_id}</span>
                  <span className="what">{humanAction(d.proposed_action)}</span>
                  <time className="when" dateTime={d.created_at} title={ist(d.created_at)}>
                    {sinceNow(d.created_at)}
                  </time>
                  <a className="trace-link" href={`#/trace/${encodeURIComponent(String(d.id))}`}>
                    why?
                  </a>
                </div>
                <p className="explain">{d.explanation}</p>
                {d.rationale && <p className="said">{d.rationale}</p>}
                {(d.scheduled_for || d.outcome) && (
                  <div className="slot">
                    {d.scheduled_for && <span><b>Scheduled</b> {ist(d.scheduled_for)} IST</span>}
                    {moved && <span>moved from {ist(d.proposed_for!)}</span>}
                    {d.outcome && <span><b>Outcome</b> {d.outcome}</span>}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function AtRisk({ rows }: { rows: AtRiskRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="state">
        <strong>Nothing at risk</strong>
        Every mandate is clearing. This view fills the moment one fails.
      </div>
    );
  }

  return (
    <div className="paper table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Customer</th>
            <th scope="col">Method</th>
            <th scope="col" className="num">Amount</th>
            <th scope="col">Band</th>
            <th scope="col" className="num">Fails</th>
            <th scope="col">Attempts left</th>
            <th scope="col">Mandate</th>
            <th scope="col">Last decline</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const last = r.attempts_remaining <= 1;
            return (
              <tr key={r.subscription_id}>
                <td>
                  <a className="ref link" href={`#/mandate/${encodeURIComponent(r.subscription_id)}`}>
                    {r.customer_ref}
                  </a>
                </td>
                <td>{humanMethod(r.method)}</td>
                <td className="num amount">{rupees(r.amount_paise)}</td>
                <td><span className={`badge ${r.risk_band ?? 'UNKNOWN'}`}>{bucketLabel(r.risk_band)}</span></td>
                <td className="num">{r.consecutive_failures}</td>
                <td>
                  <span className={`attempts${last ? ' is-last' : ''}`}>{r.attempts_remaining}</span>
                  <span className={`meter${last ? ' is-last' : ''}`} aria-hidden="true">
                    {[0, 1, 2, 3].map((i) => (
                      <i key={i} className={i < r.attempts_remaining ? 'on' : ''} />
                    ))}
                  </span>
                </td>
                <td>{expiry(r.days_to_expiry)}</td>
                <td>
                  {r.last_bucket
                    ? <span className={`badge ${r.last_bucket}`}>{bucketLabel(r.last_bucket)}</span>
                    : '—'}
                  {r.last_error_reason && <> <span className="ref">{r.last_error_reason}</span></>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Declines({ rows }: { rows: DeclineRow[] }) {
  if (rows.length === 0) {
    return <div className="state"><strong>No failures recorded</strong>Nothing has declined yet.</div>;
  }
  return (
    <div className="paper table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            <th scope="col">Reason</th>
            <th scope="col">Source</th>
            <th scope="col">Method</th>
            <th scope="col" className="num">Attempts</th>
            <th scope="col" className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.error_reason}-${r.method}-${i}`}>
              <td><span className={`badge ${r.bucket ?? 'UNKNOWN'}`}>{bucketLabel(r.bucket)}</span></td>
              <td><span className="ref">{r.error_reason ?? 'null'}</span></td>
              <td>{r.error_source ?? '—'}</td>
              <td>{humanMethod(r.method)}</td>
              <td className="num">{r.attempts}</td>
              <td className="num amount">{rupees(r.amount_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Unmapped({ rows }: { rows: UnmappedRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="state">
        <strong>Every decline code is classified</strong>
        Nothing is being retried on a guess.
      </div>
    );
  }
  return (
    <div className="paper table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Reason</th>
            <th scope="col">Source</th>
            <th scope="col">Step</th>
            <th scope="col" className="num">Attempts</th>
            <th scope="col" className="num">Amount</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.error_reason}-${i}`}>
              <td><span className="ref">{r.error_reason ?? 'null'}</span></td>
              <td>{r.error_source ?? '—'}</td>
              <td>{r.error_step ?? '—'}</td>
              <td className="num">{r.attempts}</td>
              <td className="num amount">{rupees(r.amount_paise)}</td>
              <td>{ist(r.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Loading() {
  return (
    <div className="shell">
      <Masthead mode={null} route="" killed={false} />
      <Announce label="Loading the dashboard"><SkeletonReport /></Announce>
    </div>
  );
}

function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await signIn(email, password);
      onSignedIn();
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="masthead">
        <a className="wordmark" href="/">Helm</a>
        <div className="meta">
          <nav className="site-links" aria-label="Product">
            <a className="site-link" href="/proof">Proof</a>
            <a className="site-link" href="/docs">Docs</a>
            <a className="site-link" href="/">Home</a>
          </nav>
        </div>
      </header>

      <form className="onboard-form paper sign-in" onSubmit={(e) => void submit(e)}>
        <h1>Sign in</h1>
        <p className="field-note">
          Your dashboard shows your mandates and your customers, and nobody else can open it.
        </p>

        <label htmlFor="email">Email</label>
        <input
          id="email" name="email" type="email" autoComplete="email" required
          value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="you@yourbusiness.in"
        />

        <label htmlFor="pw">Password</label>
        <input
          id="pw" name="password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)}
        />

        {problem && <p className="form-error" role="alert">{problem}</p>}

        <button type="submit" className="cta" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="field-note">
          No account yet? <a className="link" href="/onboard">Connect your Razorpay account</a>.
          Forgotten your password? Connecting the same key again sets a new one.
        </p>
      </form>
    </div>
  );
}

export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [control, setControl] = useState<Control | null>(null);
  const [business, setBusiness] = useState<string | null>(null);
  const { route, param } = useHashRoute();

  const load = useCallback(async () => {
    try {
      const [overview, atRiskRes, declines, decisions, health, ctrl, mine] = await Promise.all([
        api.overview(), api.atRisk(), api.declines(), api.decisions(), api.health(), api.control(),
        api.merchants(),
      ]);
      setControl(ctrl);
      setBusiness(mine.merchants[0]?.name ?? null);
      setData({
        overview,
        atRisk: atRiskRes.subscriptions,
        distribution: declines.distribution,
        unmapped: declines.unmapped,
        decisions: decisions.decisions,
        denials: decisions.denials_by_rule,
      });
      setMode(health.mode);
      setSignedIn(true);
      setError(null);
    } catch (err) {
      if (err instanceof NotConnected) {
        setSignedIn(false);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (signedIn === false) return;
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load, signedIn]);

  if (signedIn === false) {
    return <SignInScreen onSignedIn={() => { setSignedIn(null); void load(); }} />;
  }

  if (error) {
    return (
      <div className="shell">
        <Masthead mode={mode} route={route} killed={false} business={business} />
        <div className="state is-error">
          <strong>Could not reach the API</strong>
          {error}
          <br />
          <button type="button" className="retry" onClick={() => void load()}>Try again</button>
        </div>
      </div>
    );
  }

  if (!data) return <Loading />;

  if (route === 'mandate' && param) {
    return (
      <div className="shell">
        <Masthead mode={mode} route="" killed={control?.kill_switch ?? false} business={business} />
        <a className="back" href="#/">&larr; All mandates</a>
        <MandateDetail id={param} />
      </div>
    );
  }

  if (route === 'trace' && param) {
    return (
      <div className="shell">
        <Masthead mode={mode} route={route} killed={control?.kill_switch ?? false} business={business} />
        <a className="back link" href="#/">← Overview</a>
        <Trace id={param} />
      </div>
    );
  }

  if (route === 'queue' || route === 'account' || route === 'reports' || route === 'outreach') {
    const title = TABS.find((t) => t.route === route)?.label ?? '';
    return (
      <div className="shell">
        <Masthead mode={mode} route={route} killed={control?.kill_switch ?? false} business={business} />
        <div className="section-head"><h2>{title}</h2></div>
        {route === 'queue' && <ChargeQueue />}
        {route === 'outreach' && <Outreach />}
        {route === 'account' && <Account />}
        {route === 'reports' && <Reports slug={param} />}
      </div>
    );
  }

  return (
    <div className="shell">
      <Masthead mode={mode} route={route} killed={control?.kill_switch ?? false} business={business} />
      {control && <KillSwitch control={control} onChange={() => void load()} />}
      <Headline o={data.overview} />

      <section aria-labelledby="h-decisions">
        <div className="section-head">
          <h2 id="h-decisions">Decisions</h2>
          <span className="count">{data.decisions.length} recorded</span>
        </div>
        <p className="hint">
          Every verdict, approvals and refusals alike, with the rule that produced it. An attempt
          not spent on a mandate that could not be saved is an attempt available to one that can.
        </p>
        <Decisions rows={data.decisions} denials={data.denials} />
      </section>

      <section aria-labelledby="h-atrisk">
        <div className="section-head">
          <h2 id="h-atrisk">Mandates at risk</h2>
          <span className="count">{data.atRisk.length} open</span>
        </div>
        <p className="hint">
          Attempts left counts every attempt in the cycle, ours and the gateway&rsquo;s, against the
          network budget of four. At one remaining, the next failure ends the mandate.
        </p>
        <AtRisk rows={data.atRisk} />
      </section>

      <section aria-labelledby="h-declines">
        <div className="section-head">
          <h2 id="h-declines">Why they failed</h2>
          <span className="count">{data.distribution.length} distinct</span>
        </div>
        <p className="hint">
          A hard decline cannot be recovered by retrying. The default schedule spends the same
          three attempts on a customer who was short for a day and one who revoked the mandate.
        </p>
        <Declines rows={data.distribution} />
      </section>

      <section aria-labelledby="h-unmapped">
        <div className="section-head">
          <h2 id="h-unmapped">Unclassified declines</h2>
          <span className="count">{data.unmapped.length} distinct</span>
        </div>
        <p className="hint">
          Codes not yet in the taxonomy. These get one conservative attempt rather than the full
          budget, and are listed here rather than silently bucketed.
        </p>
        <Unmapped rows={data.unmapped} />
      </section>

      <footer className="foot">
        <span>Refreshes every 15 seconds</span>
        <span>All times IST</span>
        <span>Amounts in paise, displayed as rupees</span>
      </footer>
    </div>
  );
}
