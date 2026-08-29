import { useCallback, useEffect, useState } from 'react';
import { rupees } from './format.ts';

interface Config {
  ready: boolean;
  problem: string | null;
  key_id: string | null;
  mandates: { label: string; amount_paise: number }[];
  authorized: number;
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
  const checkoutReady = useCheckoutScript();

  const refresh = useCallback(async () => {
    const [c, m] = await Promise.all([
      fetch('/api/authorize/config').then((r) => r.json() as Promise<Config>),
      fetch('/api/authorize/mandates').then((r) => r.json() as Promise<{ mandates: Mandate[] }>),
    ]);
    setConfig(c);
    setMandates(m.mandates);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, amount_paise: amountPaise, method: payMethod }),
      }).then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? 'Could not prepare the mandate.');
        return b as { order_id: string; customer_id: string; key_id: string };
      });

      setState('open');

      const checkout = new window.Razorpay({
        key: prep.key_id,
        order_id: prep.order_id,
        customer_id: prep.customer_id,
        recurring: '1',
        name: 'Helm',
        description: `${label} — ₹${amountPaise / 100} monthly mandate`,
        prefill: payMethod === 'card'
          ? { method: 'card', email: 'mandate@example.com', contact: '9999999999' }
          : { method: 'emandate', bank: 'HDFC', email: 'mandate@example.com', contact: '9999999999' },
        method: payMethod === 'card'
          ? { card: true, netbanking: false, wallet: false, upi: false, emi: false, paylater: false }
          : { emandate: true, card: false, netbanking: false, wallet: false, upi: false, emi: false, paylater: false },
        theme: { color: '#1d5f7e' },
        handler: async (response: { razorpay_payment_id: string }) => {
          setState('saving');
          try {
            const saved = await fetch('/api/authorize/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                payment_id: response.razorpay_payment_id,
                label,
                amount_paise: amountPaise,
              }),
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

  if (!config) {
    return <div className="shell onboard"><div className="skeleton tall" /></div>;
  }

  return (
    <div className="shell onboard">
      <header className="masthead"><a className="wordmark" href="/">Helm</a></header>

      <h1 className="onboard-title">Authorise test mandates</h1>
      <p className="onboard-lede">
        A recurring charge needs a mandate the customer approved, and approval happens in a browser.
        Each one you authorise produces a real mandate token in test mode, which Helm can then
        charge against.
      </p>

      <div className="switch" role="tablist" aria-label="Authorisation method">
        <button
          type="button" role="tab" aria-selected={payMethod === 'emandate'}
          className={`switch-opt${payMethod === 'emandate' ? ' is-on' : ''}`}
          onClick={() => setPayMethod('emandate')}
        >
          e-mandate
        </button>
        <button
          type="button" role="tab" aria-selected={payMethod === 'card'}
          className={`switch-opt${payMethod === 'card' ? ' is-on' : ''}`}
          onClick={() => setPayMethod('card')}
        >
          Card
        </button>
      </div>

      <p className="onboard-lede" style={{ marginTop: -8 }}>
        {payMethod === 'emandate'
          ? 'Pick any bank, then choose Success on the simulated bank page.'
          : 'Test card 5104 0155 5555 5558, any future expiry, any CVV. If a card is refused as not eligible for recurring, switch to e-mandate.'}
      </p>

      {!config.ready && (
        <div className="form-error" role="alert">{config.problem}</div>
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

      <section>
        <div className="section-head">
          <h2>Authorised mandates</h2>
          <span className="count">{mandates.length}</span>
        </div>
        {mandates.length === 0
          ? <div className="state"><strong>None yet</strong>Authorise one above and it appears here.</div>
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
        {mandates.length > 0 && (
          <p className="field-note" style={{ marginTop: 16 }}>
            {mandates.length} real mandate{mandates.length === 1 ? '' : 's'} authorised.
            Helm can now create genuine recurring charges against {mandates.length === 1 ? 'it' : 'them'}.
          </p>
        )}
      </section>
    </div>
  );
}
