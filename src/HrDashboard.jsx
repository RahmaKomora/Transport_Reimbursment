import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import RegionAccordion from './RegionAccordion';
import SavingsAnalytics from './SavingsAnalytics';
import SheetSync from './SheetSync';

const TABS = [
  { key: 'live', label: 'Live Active Queue', blurb: 'Approved in the cycle that is still open. Visible now, payable once the cycle closes.' },
  { key: 'approved', label: 'Ready for Payment', blurb: 'Sealed batches from closed cycles, grouped by region for payment.' },
  { key: 'paid', label: 'Completed Payments', blurb: 'Already sent by M-Pesa.' },
  { key: 'savings', label: 'Savings Analytics', blurb: 'Budget left unspent this cycle.' },
];

export default function HrDashboard({ money }) {
  const [tab, setTab] = useState('live');
  // Bumped on a sheet sync so the visible tab refetches against the new configuration.
  const [syncNonce, setSyncNonce] = useState(0);
  const active = TABS.find((item) => item.key === tab);

  return <>
    <section className="page-heading"><div>
      <span className="kicker">HR</span>
      <h1>Reimbursements</h1>
      <p>{active.blurb}</p>
    </div></section>
    <SheetSync onSynced={() => setSyncNonce((value) => value + 1)} />
    <div className="hr-tabs" role="tablist">
      {TABS.map((item) => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'selected' : ''} onClick={() => setTab(item.key)}>{item.label}</button>)}
    </div>
    {tab === 'live' && <LiveQueue money={money} key={`live-${syncNonce}`} />}
    {tab === 'approved' && <ReadyForPayment money={money} key={`approved-${syncNonce}`} />}
    {tab === 'paid' && <CompletedPayments money={money} key={`paid-${syncNonce}`} />}
    {tab === 'savings' && <SavingsAnalytics money={money} key={`savings-${syncNonce}`} />}
  </>;
}

// Read-only by design: nothing here can be paid until the scheduler seals the cycle.
function LiveQueue({ money }) {
  const [state, setState] = useState({ loading: true, regions: [], count: 0, total: 0, cycle: null, error: '' });

  const load = useCallback(() => {
    api.liveClaims()
      .then((data) => setState({ loading: false, ...data, error: '' }))
      .catch((error) => setState({ loading: false, regions: [], count: 0, total: 0, cycle: null, error: error.message }));
  }, []);
  useEffect(load, [load]);

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading the open cycle...</p></section>;
  if (state.error) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  return <>
    {state.cycle && <section className="cycle-banner">
      <div>
        <span className="kicker">Open cycle</span>
        <strong>{state.cycle.label} · {state.cycle.range}</strong>
        <small>Seals {new Date(state.cycle.closesAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}, when HR is notified and these become payable.</small>
      </div>
      <div className="cycle-figures">
        <b>{money(state.total)}</b>
        <small>{state.count} approved claim{state.count === 1 ? '' : 's'}</small>
      </div>
    </section>}
    <section className="panel">
      <RegionAccordion
        regions={state.regions}
        money={money}
        emptyMessage="No claims have been approved in this cycle yet."
        renderClaim={(claim) => <ClaimRow key={claim.id} claim={claim} money={money} trailing={<span className="pill gray">Awaiting cycle close</span>} />}
      />
    </section>
  </>;
}

// Sealed batches. Grouped by cycle first, then region, so a batch reads as one payment run.
function ReadyForPayment({ money }) {
  const [state, setState] = useState({ loading: true, batches: [], count: 0, error: '' });
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.approvedClaims()
      .then((data) => setState({ loading: false, batches: data.batches, count: data.count, error: '' }))
      .catch((error) => setState({ loading: false, batches: [], count: 0, error: error.message }));
  }, []);
  useEffect(load, [load]);

  const pay = async (claim) => {
    setBusy(claim.id);
    try {
      await api.decide(claim.id, 'pay');
      load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setBusy('');
    }
  };

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading batches...</p></section>;

  return <>
    {state.error && <p className="queue-error">{state.error}</p>}
    {!state.batches.length && <section className="panel"><p className="queue-empty">No batch has been released yet. Claims approved in the open cycle appear here once that cycle closes.</p></section>}
    {state.batches.map((batch) => <section className="panel batch-panel" key={batch.cycleKey}>
      <div className="panel-heading">
        <div>
          <span className="kicker">Batch {batch.cycleKey}</span>
          <h2>{batch.label} · {batch.range}</h2>
        </div>
        <div className="batch-total"><b>{money(batch.total)}</b><small>{batch.count} claim{batch.count === 1 ? '' : 's'}</small></div>
      </div>
      <RegionAccordion
        regions={batch.regions}
        money={money}
        emptyMessage="This batch is empty."
        renderClaim={(claim) => <ClaimRow key={claim.id} claim={claim} money={money} trailing={
          <button type="button" className="button primary" disabled={busy === claim.id} onClick={() => pay(claim)}>{busy === claim.id ? 'Saving...' : 'Mark payment sent'}</button>
        } />}
      />
    </section>)}
  </>;
}

function CompletedPayments({ money }) {
  const [state, setState] = useState({ loading: true, regions: [], error: '' });

  useEffect(() => {
    api.paidClaims()
      .then((data) => setState({ loading: false, regions: data.regions, error: '' }))
      .catch((error) => setState({ loading: false, regions: [], error: error.message }));
  }, []);

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading payments...</p></section>;
  if (state.error) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  return <section className="panel">
    <RegionAccordion
      regions={state.regions}
      money={money}
      emptyMessage="No payments have been sent yet."
      renderClaim={(claim) => <ClaimRow key={claim.id} claim={claim} money={money} trailing={<span className="pill blue">Payment sent</span>} />}
    />
  </section>;
}

function ClaimRow({ claim, money, trailing }) {
  return <article className="review-row">
    <div className="review-main">
      <strong>{claim.staffName}</strong>
      <span>{claim.purpose}</span>
      <small>{claim.id} · {claim.zone} · {claim.tripDate} · {claim.approvalSource === 'system' ? 'auto-approved' : `approved by ${claim.approvalSource || 'manager'}`}</small>
    </div>
    <div className="review-figures">
      <strong>{money(claim.amount)}</strong>
      <small>{Number(claim.km).toFixed(1)} km at {money(claim.rate)} / km</small>
    </div>
    <div className="review-actions">{trailing}</div>
  </article>;
}
