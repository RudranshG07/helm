import { useCallback, useEffect, useRef, useState } from 'react';
import { ist, rupees } from './format.ts';
import { dashboardLink, sessionHeaders, setSession, storedSession } from './session.ts';
import { Announce, SkeletonReport } from './skeletons.tsx';

type Method = 'connect' | 'upload';

interface Status {
  onboarding_state: string;
  onboarding_error: string | null;
  subscriptions: number;
  attempts: number;
  failures: number;
  job: { state: string; error: string | null } | null;
}

async function send<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(parsed.error ?? `Request failed (${res.status})`);
  return parsed;
}

function PrivateLink() {
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  const token = storedSession();
  if (!token) return null;
  const link = dashboardLink(token);

  async function toClipboard() {
    try {
      await navigator.clipboard.writeText(link);
      setCopy('done');
      window.setTimeout(() => setCopy('idle'), 2000);
    } catch {
      setCopy('failed');
    }
  }

  return (
    <div className="private-link">
      <strong>Your private dashboard link</strong>
      <p>
        This link is the only way into your dashboard. Save it before you close this page. Anyone
        you send it to can read your mandates and your customers, so treat it like a password.
        Connecting again with the same key issues a new link and retires this one.
      </p>
      <div className="private-link-row">
        <code className="ref">{link}</code>
        <button type="button" className="cta ghost" onClick={() => void toClipboard()}>
          {copy === 'done' ? 'Copied' : 'Copy link'}
        </button>
      </div>
      {copy === 'failed' && (
        <span className="hint" role="alert">
          This browser would not let the page copy for you. Select the link above and copy it.
        </span>
      )}
    </div>
  );
}

function Progress({ merchantId }: { merchantId: string }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/onboard/${encodeURIComponent(merchantId)}/status`, {
          headers: sessionHeaders(),
        });
        const body = (await res.json()) as Status;
        if (!stop) setStatus(body);
        if (!stop && body.onboarding_state === 'backfilling') setTimeout(() => void poll(), 1500);
      } catch {
        if (!stop) setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => { stop = true; };
  }, [merchantId]);

  if (!status) {
    return (
      <div className="onboard-progress" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />Connecting…
      </div>
    );
  }

  if (status.onboarding_state === 'failed') {
    return (
      <div className="onboard-progress is-error">
        <strong>That did not work</strong>
        <p>{status.onboarding_error ?? status.job?.error ?? 'Unknown problem.'}</p>
        <a className="cta" href="/onboard">Try again</a>
      </div>
    );
  }

  if (status.onboarding_state === 'ready') {
    return <RecoveryReport merchantId={merchantId} status={status} />;
  }

  return (
    <div className="onboard-progress" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      Reading your payment history. This takes a moment.
      {status.attempts > 0 && (
        <span className="hint">
          {status.subscriptions} mandates and {status.attempts} payments read so far.
        </span>
      )}
    </div>
  );
}

export default function Onboard() {
  const [method, setMethod] = useState<Method>('connect');
  const [name, setName] = useState('');
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merchantId, setMerchantId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('merchant'),
  );
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function readFile(f: File) {
    if (f.size > 12_000_000) {
      setError('That file is larger than 12 MB. Split it and try again.');
      return;
    }
    setError(null);
    setFile({ name: f.name, text: await f.text() });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = method === 'connect'
        ? await send<{ merchant_id: string; session: string }>('/api/onboard/connect', {
            name, key_id: keyId, key_secret: keySecret,
          })
        : await send<{ merchant_id: string; session: string }>('/api/onboard/upload', {
            name, csv: file?.text ?? '',
          });
      setSession(result.session);
      setMerchantId(result.merchant_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (merchantId) {
    return (
      <div className="shell onboard">
        <header className="masthead">
        <a className="wordmark" href="/">Helm</a>
        <nav className="site-links" aria-label="Product">
          <a className="site-link" href="/proof">Proof</a>
          <a className="site-link" href="/docs">Docs</a>
          <a className="site-link" href="/authorize">Mandates</a>
          <a className="site-link" href="/dashboard">Dashboard</a>
        </nav>
      </header>
        <Progress merchantId={merchantId} />
      </div>
    );
  }

  return (
    <div className="shell onboard">
      <header className="masthead">
        <a className="wordmark" href="/">Helm</a>
        <nav className="site-links" aria-label="Product">
          <a className="site-link" href="/proof">Proof</a>
          <a className="site-link" href="/docs">Docs</a>
          <a className="site-link" href="/authorize">Mandates</a>
          <a className="site-link" href="/dashboard">Dashboard</a>
        </nav>
      </header>

      <h1 className="onboard-title">Find the revenue that is slipping away</h1>
      <p className="onboard-lede">
        Connect a Razorpay account in test mode, or drop in an export of failed payments. Helm reads
        your history, works out why each charge failed, and shows what could still be recovered.
        It never charges anyone until you say so.
      </p>

      <div className="switch" role="tablist" aria-label="How to connect">
        <button
          type="button" role="tab" aria-selected={method === 'connect'}
          className={`switch-opt${method === 'connect' ? ' is-on' : ''}`}
          onClick={() => setMethod('connect')}
        >
          Connect Razorpay
        </button>
        <button
          type="button" role="tab" aria-selected={method === 'upload'}
          className={`switch-opt${method === 'upload' ? ' is-on' : ''}`}
          onClick={() => setMethod('upload')}
        >
          Upload a file
        </button>
      </div>

      <form className="onboard-form paper" onSubmit={(e) => void submit(e)}>
        <label htmlFor="biz">Business name</label>
        <input
          id="biz" name="organization" autoComplete="organization" required
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Iron Works Gym"
        />

        {method === 'connect' ? (
          <>
            <label htmlFor="kid">Razorpay key ID</label>
            <input
              id="kid" required value={keyId} autoComplete="off" spellCheck={false}
              onChange={(e) => setKeyId(e.target.value)} placeholder="rzp_test_..."
            />
            <p className="field-note">
              Settings → API Keys in your Razorpay dashboard. Test mode only for now, and read
              access is enough.
            </p>

            <label htmlFor="ksec">Key secret</label>
            <input
              id="ksec" type="password" required value={keySecret} autoComplete="off"
              onChange={(e) => setKeySecret(e.target.value)} placeholder="••••••••••••"
            />
            <p className="field-note">
              Encrypted before it is stored, and only ever used from the server.
            </p>
          </>
        ) : (
          <>
            <label htmlFor="drop">Failed payments export</label>
            <div
              id="drop"
              className={`dropzone${dragging ? ' is-over' : ''}${file ? ' has-file' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files[0];
                if (f) void readFile(f);
              }}
            >
              {file
                ? <><strong>{file.name}</strong><span>ready to read</span></>
                : <><strong>Drop your CSV here</strong><span>or choose a file</span></>}
              <button type="button" className="cta ghost" onClick={() => inputRef.current?.click()}>
                Choose file
              </button>
              <input
                ref={inputRef} type="file" accept=".csv,text/csv" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }}
              />
            </div>
            <p className="field-note">
              Payments → Export in your Razorpay dashboard. Any date range. Nothing is sent anywhere
              except this server.
            </p>
          </>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}

        <button type="submit" className="cta" disabled={busy || (method === 'upload' && !file)}>
          {busy ? 'Working…' : method === 'connect' ? 'Connect and analyse' : 'Analyse this file'}
        </button>

        <p className="field-note reassure">
          Read only. Helm cannot charge anyone until a human turns write access on, and a kill
          switch stops everything in one click.
        </p>
      </form>
    </div>
  );
}

interface Consent {
  merchant_id: string;
  write_enabled: boolean;
  consent_signed_at: string | null;
  mode: string;
  dry_run_charges: number;
  dry_run_amount_paise: number;
  refusals: number;
}

const ACKNOWLEDGEMENT = 'I authorise Helm to charge my customers';

function GrantAccess({ merchantId }: { merchantId: string }) {
  const [state, setState] = useState<Consent | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/onboard/${encodeURIComponent(merchantId)}/consent`, {
      headers: sessionHeaders(),
    });
    if (r.ok) setState(await r.json() as Consent);
  }, [merchantId]);

  useEffect(() => { void load(); }, [load]);

  async function submit(granted: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/onboard/${encodeURIComponent(merchantId)}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sessionHeaders() },
        body: JSON.stringify({ granted, acknowledged: granted ? typed.trim() : undefined }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? 'That did not work.');
      setTyped('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  if (state.write_enabled) {
    return (
      <section className="consent paper is-live">
        <span className="eyebrow">Write access</span>
        <h3>Helm can charge your customers</h3>
        <p>
          Granted {state.consent_signed_at ? ist(state.consent_signed_at) : 'just now'}. Every charge
          stays inside the same sixteen rules, and the kill switch on the dashboard stops everything
          instantly.
        </p>
        <button type="button" className="cta ghost" onClick={() => void submit(false)} disabled={busy}>
          {busy ? 'Revoking…' : 'Revoke write access'}
        </button>
      </section>
    );
  }

  return (
    <section className="consent paper">
      <span className="eyebrow">Write access</span>
      <h3>Helm has not charged anyone, and will not until you say so.</h3>
      <p>
        It has been running in dry run against your account, recording the action it would take
        without taking it. Review that before deciding.
      </p>

      <dl className="report-rows">
        <div>
          <dt>Charges it would have made</dt>
          <dd>{state.dry_run_charges}</dd>
        </div>
        <div>
          <dt>Money that would have moved</dt>
          <dd>{rupees(state.dry_run_amount_paise)}</dd>
        </div>
        <div>
          <dt>Actions the rules refused</dt>
          <dd>{state.refusals}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{state.mode}</dd>
        </div>
      </dl>

      <label className="consent-label" htmlFor="ack">
        To grant write access, type <code>{ACKNOWLEDGEMENT}</code>
      </label>
      <input
        id="ack"
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={ACKNOWLEDGEMENT}
        autoComplete="off"
      />

      {error && <div className="form-error" role="alert">{error}</div>}

      <button
        type="button"
        className="cta"
        onClick={() => void submit(true)}
        disabled={busy || typed.trim() !== ACKNOWLEDGEMENT}
      >
        {busy ? 'Granting…' : 'Grant write access'}
      </button>
      <p className="field-note">
        You can revoke this at any time, and the kill switch halts every charge instantly.
      </p>
    </section>
  );
}

interface Report {
  has_history: boolean;
  window_days: number;
  headline: string;
  caveat: string | null;
  money: {
    at_risk_paise: number;
    recovered_paise: number;
    lost_paise: number;
    addressable_paise: number;
    unclassified_paise: number;
    hard_paise: number;
    recovery_rate: number;
  };
  attempts: {
    spent_by_default: number;
    wasted_on_hard_declines: number;
    in_peak_windows: number;
    we_would_reschedule: number;
    we_would_not_spend: number;
  };
  urgent: {
    subscription_id: string;
    customer_ref: string;
    amount_paise: number;
    bucket: string;
    attempts_used: number;
    days_to_halt: number;
  }[];
}

function RecoveryReport({ merchantId, status }: { merchantId: string; status: Status }) {
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stop = false;
    fetch(`/api/onboard/${merchantId}/report`, { headers: sessionHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error('report unavailable');
        return r.json() as Promise<Report>;
      })
      .then((r) => { if (!stop) setReport(r); })
      .catch(() => { if (!stop) setFailed(true); });
    return () => { stop = true; };
  }, [merchantId]);

  if (failed) {
    return (
      <div className="onboard-progress is-done">
        <strong>Connected</strong>
        <p>
          {status.subscriptions} mandates and {status.attempts} attempts loaded. Nothing has been
          charged and nothing will be until you grant write access.
        </p>
        <a className="cta" href="/dashboard">Open the dashboard</a>
        <PrivateLink />
      </div>
    );
  }

  if (!report) {
    return (
      <Announce label="Working out what these failures cost you">
        <SkeletonReport />
      </Announce>
    );
  }

  if (!report.has_history) {
    return (
      <>
        <div className="onboard-progress is-done">
          <strong>Connected, nothing failing</strong>
          <p>
            No failed mandates in the last {report.window_days} days, so there is nothing to
            recover yet. Helm will keep watching and tell you the moment one starts to slip.
          </p>
          <a className="cta" href="/dashboard">Open the dashboard</a>
          <PrivateLink />
        </div>

        <GrantAccess merchantId={merchantId} />
      </>
    );
  }

  const m = report.money;

  return (
    <section className="report-card">
      <span className="eyebrow">Last {report.window_days} days, from your own Razorpay history</span>
      <h2 className="report-headline">{report.headline}</h2>

      <div className="tiles">
        <div className="tile paper">
          <span className="eyebrow">Failed</span>
          <strong className="num">{rupees(m.at_risk_paise)}</strong>
          <span className="hint">{Math.round(m.recovery_rate * 100)}% of it eventually recovered</span>
        </div>
        <div className="tile paper">
          <span className="eyebrow">Never recovered</span>
          <strong className="num">{rupees(m.lost_paise)}</strong>
          <span className="hint">gone, after the default retries ran out</span>
        </div>
        <div className="tile paper">
          <span className="eyebrow">Responds to timing</span>
          <strong className="num">{rupees(m.addressable_paise)}</strong>
          <span className="hint">soft declines Helm would retry differently</span>
        </div>
      </div>

      <div className="report-split">
        <div className="report-block paper">
          <h3>Where the lost money went</h3>
          <dl className="report-rows">
            <div><dt>Soft declines, worth another attempt</dt><dd>{rupees(m.addressable_paise)}</dd></div>
            <div><dt>Hard declines, no retry can fix</dt><dd>{rupees(m.hard_paise)}</dd></div>
            <div><dt>Decline codes Helm has not mapped</dt><dd>{rupees(m.unclassified_paise)}</dd></div>
          </dl>
        </div>
        <div className="report-block paper">
          <h3>What the default schedule did</h3>
          <dl className="report-rows">
            <div><dt>Attempts spent</dt><dd>{report.attempts.spent_by_default}</dd></div>
            <div><dt>Spent on declines that could never succeed</dt><dd>{report.attempts.wasted_on_hard_declines}</dd></div>
            <div><dt>Fired into a contested bank window</dt><dd>{report.attempts.in_peak_windows}</dd></div>
            <div><dt>Helm would have re-timed</dt><dd>{report.attempts.we_would_reschedule}</dd></div>
          </dl>
        </div>
      </div>

      {report.urgent.length > 0 && (
        <div className="report-urgent">
          <div className="section-head">
            <h3>Dying now</h3>
            <span className="count">{report.urgent.length}</span>
          </div>
          <div className="paper table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col">Why it failed</th>
                  <th scope="col" className="num">Attempts used</th>
                  <th scope="col" className="num">Days left</th>
                </tr>
              </thead>
              <tbody>
                {report.urgent.map((u) => (
                  <tr key={u.subscription_id}>
                    <td>{u.customer_ref}</td>
                    <td className="num amount">{rupees(u.amount_paise)}</td>
                    <td><span className={`badge ${u.bucket}`}>{u.bucket.replace(/_/g, ' ').toLowerCase()}</span></td>
                    <td className="num">{u.attempts_used}</td>
                    <td className="num">{u.days_to_halt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {report.caveat && (
        <p className="report-caveat" role="note">{report.caveat}</p>
      )}

      <GrantAccess merchantId={merchantId} />

      <PrivateLink />

      <div className="report-actions">
        <a className="cta" href="/dashboard">Open the dashboard</a>
        <p className="field-note">
          Helm has read-only access. Nothing has been charged and nothing will be until you
          grant write access.
        </p>
      </div>
    </section>
  );
}
