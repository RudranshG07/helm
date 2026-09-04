import { useCallback, useEffect, useState } from 'react';
import { rupees } from './format.ts';
import { sessionHeaders } from './session.ts';
import { Announce, SkeletonReport } from './skeletons.tsx';

type RailStatus = 'usable' | 'disabled' | 'not_provisioned' | 'failing';

interface Rail {
  rail: string;
  label: string;
  status: RailStatus;
  detail: string;
  observed_failures: number;
}

interface Account {
  probed: boolean;
  activated: boolean;
  rails: Rail[];
  usable: string[];
  verdict: 'live_ready' | 'blocked';
  summary: string;
}

interface Config {
  ready: boolean;
  problem: string | null;
  key_id: string | null;
  mandates: { label: string; amount_paise: number }[];
  authorized: number;
  account: Account;
}

interface Mandate {
  id: string;
  label: string;
  amount_paise: number;
  rzp_token_id: string;
  status: string;
}


type State = 'idle' | 'preparing' | 'open' | 'saving' | 'done' | 'error';
type PayMethod = 'emandate' | 'card';

const STATUS_BADGE: Record<RailStatus, string> = {
  usable: 'healthy',
  failing: 'critical',
  disabled: 'UNKNOWN',
  not_provisioned: 'at_risk',
};

const STATUS_WORD: Record<RailStatus, string> = {
  usable: 'ready',
  failing: 'failing',
  disabled: 'off',
  not_provisioned: 'not provisioned',
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: unknown) => void) => void };
  }
}

function useCheckoutScript(): boolean {
  const [loaded, setLoaded] = useState(Boolean(window.Razorpay));
  useEffect(() => {
    if (window.Razorpay) { setLoaded(true); return; }
    const tag = document.createElement('script');
    tag.src = 'https://checkout.razorpay.com/v1/checkout.js';
    tag.onload = () => setLoaded(true);
    document.head.appendChild(tag);
  }, []);
  return loaded;
}

export default function Authorize() {
  const [config, setConfig] = useState<Config | null>(null);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [payMethod, setPayMethod] = useState<PayMethod>('emandate');
  const [locked, setLocked] = useState(false);
  const checkoutReady = useCheckoutScript();

  const refresh = useCallback(async () => {
    const [cRes, mRes] = await Promise.all([
      fetch('/api/authorize/config', { headers: sessionHeaders() }),
      fetch('/api/authorize/mandates', { headers: sessionHeaders() }),
    ]);
    if (cRes.status === 401 || mRes.status === 401) {
      setLocked(true);
      return;
    }
    setConfig((await cRes.json()) as Config);
    setMandates(((await mRes.json()) as { mandates: Mandate[] }).mandates);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function authorize(label: string, amountPaise: number) {
    if (!window.Razorpay) { setMessage('Checkout has not loaded yet.'); setState('error'); return; }
    setActive(label);
    setState('preparing');
    setMessage(null);

    try {
      const prep = await fetch('/api/authorize/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sessionHeaders() },
        body: JSON.stringify({ label, amount_paise: amountPaise, method: payMethod }),
      }).then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? 'Could not prepare the mandate.');
        return b as { order_id: string; customer_id: string; key_id: string; method: string; bank: string | null };
      });

      setState('open');

      const checkout = new window.Razorpay({
        key: prep.key_id,
        order_id: prep.order_id,
        customer_id: prep.customer_id,
        recurring: '1',
        method: prep.method,
        ...(prep.bank ? { bank: prep.bank } : {}),
        name: 'Helm',
        description: `${label} — ${rupees(amountPaise)} monthly mandate`,
        prefill: { email: 'mandate@helm.test', contact: '9876543210' },
        theme: { color: '#1d5f7e' },
        handler: async (response: { razorpay_payment_id: string }) => {
          setState('saving');
          try {
            const saved = await fetch('/api/authorize/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...sessionHeaders() },
              body: JSON.stringify({ payment_id: response.razorpay_payment_id, label, amount_paise: amountPaise }),
            }).then(async (r) => {
              const b = await r.json();
              if (!r.ok) throw new Error(b.error ?? 'Could not save the mandate.');
              return b as { token_id: string };
            });
            setMessage(`Mandate authorised — token ${saved.token_id}`);
            setState('done');
            await refresh();
          } catch (err) {
            setMessage((err as Error).message);
            setState('error');
          }
        },
        modal: { ondismiss: () => { setState('idle'); setActive(null); } },
      } as unknown as Record<string, unknown>);

      checkout.on('payment.failed', (r: unknown) => {
        const err = (r as { error?: { description?: string; reason?: string; step?: string } })?.error;
        const detail = [err?.description, err?.reason && `reason: ${err.reason}`, err?.step && `step: ${err.step}`]
          .filter(Boolean)
          .join(' · ');
        setMessage(detail || 'The authorisation failed.');
        setState('error');
      });

      checkout.open();
    } catch (err) {
      setMessage((err as Error).message);
      setState('error');
    }
  }

  if (locked) {
    return (
      <div className="shell onboard">
        <header className="masthead">
          <a className="wordmark" href="/">Helm</a>
          <nav className="site-links" aria-label="Product">
            <a className="site-link" href="/proof">Proof</a>
            <a className="site-link" href="/docs">Docs</a>
            <a className="site-link" href="/onboard">Connect</a>
          </nav>
        </header>
        <div className="state locked">
          <strong>This page authorises mandates on a real account</strong>
          <p>
            It can move money, so it is not open to visitors. Connect your Razorpay account and
            open this page from the dashboard link issued to you.
          </p>
          <a className="cta" href="/onboard">Connect your Razorpay account</a>
          <p className="hint">
            Only wanted to see the engine work? <a className="link" href="/proof">The measured
            run</a> is public.
          </p>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="shell onboard">
        <Announce label="Checking what your Razorpay account can do">
          <SkeletonReport />
        </Announce>
      </div>
    );
  }

  const account = config.account;
  const blocked = !account.probed || account.verdict === 'blocked';

  return (
    <div className="shell onboard">
      <header className="masthead">
        <a className="wordmark" href="/">Helm</a>
        <nav className="site-links" aria-label="Product">
          <a className="site-link" href="/proof">Proof</a>
          <a className="site-link" href="/docs">Docs</a>
          <a className="site-link" href="/onboard">Connect</a>
          <a className="site-link" href="/dashboard">Dashboard</a>
        </nav>
      </header>

      <h1 className="onboard-title">Authorise mandates</h1>
      <p className="onboard-lede">
        A recurring charge needs a mandate the customer approved, and approval happens in a browser.
        Helm checks which rails your Razorpay account can actually use before asking you to try one.
      </p>

      <section>
        <div className="section-head">
          <h2>Your Razorpay account</h2>
          <span className={`badge ${blocked ? 'critical' : 'healthy'}`}>
            {account.probed ? (blocked ? 'blocked' : 'ready') : 'unreachable'}
          </span>
        </div>
        <p className="onboard-lede pull-up">{account.summary}</p>

        {account.rails.length > 0 && (
          <ul className="rails">
            {account.rails.map((r) => (
              <li className="rail paper" key={r.rail}>
                <div className="rail-head">
                  <span className="rail-name">{r.label}</span>
                  <span className={`badge ${STATUS_BADGE[r.status]}`}>{STATUS_WORD[r.status]}</span>
                </div>
                <p className="rail-detail">{r.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {blocked && (
        <section className="blocked-panel paper">
          <h2>No live rail can take a mandate yet</h2>
          <p>
            {account.activated
              ? 'Every recurring rail on this account is either switched off or failing inside Razorpay.'
              : 'This account has not finished activation. Card, UPI Autopay, eMandate and NACH are RBI-regulated recurring products, and Razorpay gates all of them behind activation even in test mode.'}
            {' '}Complete activation in the Razorpay dashboard to authorise a live mandate here.
          </p>
          <p>
            You do not need it to see Helm work. The same engine, policy checks and exactly-once
            executor have already been measured over a batch of mandates, and every decision in
            that run is recorded.
          </p>
          <a className="cta" href="/proof">See the measured run</a>
        </section>
      )}

      {!blocked && (
        <section>
          <div className="section-head"><h2>Authorise a live mandate</h2></div>

          <div className="switch" role="tablist" aria-label="Authorisation method">
            {(['emandate', 'card'] as PayMethod[]).map((m) => (
              <button
                key={m} type="button" role="tab" aria-selected={payMethod === m}
                className={`switch-opt${payMethod === m ? ' is-on' : ''}`}
                onClick={() => setPayMethod(m)}
              >
                {m === 'emandate' ? 'e-mandate' : 'Card'}
              </button>
            ))}
          </div>

          <p className="onboard-lede pull-up-more">
            {payMethod === 'card'
              ? 'Use the recurring-eligible test card below. A generic test card is refused as not eligible.'
              : 'Pick any bank, then choose Success on the simulated bank page.'}
          </p>

          {payMethod === 'card' && (
            <div className="testcard paper">
              <div className="testcard-label">Recurring-eligible test card</div>
              <div className="testcard-grid">
                <div><span>Number</span><code>4718 6091 0820 4366</code></div>
                <div><span>Expiry</span><code>12 / 30</code></div>
                <div><span>CVV</span><code>123</code></div>
                <div><span>Name</span><code>Test User</code></div>
              </div>
              <p className="testcard-note">
                Domestic Visa credit, the card Razorpay documents for subscriptions and tokenisation.
                On the OTP screen choose Success.
              </p>
            </div>
          )}

          <div className="mandate-grid">
            {config.mandates.map((m) => {
              const busy = active === m.label && (state === 'preparing' || state === 'open' || state === 'saving');
              return (
                <div className="mandate-card paper" key={m.label}>
                  <div className="mandate-label">{m.label}</div>
                  <div className="mandate-amount">{rupees(m.amount_paise)}</div>
                  <div className="mandate-note">monthly · {payMethod === 'card' ? 'recurring card' : 'e-mandate'}</div>
                  <button
                    type="button" className="cta"
                    disabled={!config.ready || !checkoutReady || busy}
                    onClick={() => void authorize(m.label, m.amount_paise)}
                  >
                    {busy ? 'Opening…' : 'Authorise'}
                  </button>
                </div>
              );
            })}
          </div>

          {message && (
            <div className={state === 'error' ? 'form-error' : 'onboard-progress is-done'} role="status">
              {message}
            </div>
          )}
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Authorised mandates</h2>
          <span className="count">{mandates.length}</span>
        </div>
        {mandates.length === 0
          ? (
            <div className="state">
              <strong>None yet</strong>
              {blocked
                ? 'A live mandate needs an activated account. Run the batch above to see the engine work without one.'
                : 'Authorise one above and it appears here.'}
            </div>
          )
          : (
            <div className="paper table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Mandate</th>
                    <th scope="col" className="num">Amount</th>
                    <th scope="col">Token</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {mandates.map((m) => (
                    <tr key={m.id}>
                      <td>{m.label}</td>
                      <td className="num amount">{rupees(m.amount_paise)}</td>
                      <td><span className="ref">{m.rzp_token_id}</span></td>
                      <td><span className="badge healthy">{m.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  );
}
