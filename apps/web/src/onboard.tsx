import { useEffect, useRef, useState } from 'react';

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

function Progress({ merchantId }: { merchantId: string }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/onboard/${encodeURIComponent(merchantId)}/status`);
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
    return <div className="onboard-progress"><span className="spinner" aria-hidden="true" />Connecting…</div>;
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
    return (
      <div className="onboard-progress is-done">
        <strong>Ready</strong>
        <p>
          {status.subscriptions} mandates and {status.attempts} payment attempts loaded,
          {' '}{status.failures} of them failures. Nothing has been charged and nothing will be
          until you grant write access.
        </p>
        <a className="cta" href="/dashboard">Open the dashboard</a>
      </div>
    );
  }

  return (
    <div className="onboard-progress">
      <span className="spinner" aria-hidden="true" />
      Reading your payment history. This takes a moment.
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
  const [merchantId, setMerchantId] = useState<string | null>(null);
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
        ? await send<{ merchant_id: string }>('/api/onboard/connect', {
            name, key_id: keyId, key_secret: keySecret,
          })
        : await send<{ merchant_id: string }>('/api/onboard/upload', {
            name, csv: file?.text ?? '',
          });
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
        <header className="masthead"><a className="wordmark" href="/">Helm</a></header>
        <Progress merchantId={merchantId} />
      </div>
    );
  }

  return (
    <div className="shell onboard">
      <header className="masthead"><a className="wordmark" href="/">Helm</a></header>

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
