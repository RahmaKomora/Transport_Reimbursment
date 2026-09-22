import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';


const ALL = 'All';
const PERIODS = [
  { key: 'all', label: 'All time' },
  { key: 'cycle', label: 'This cycle' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: 'custom', label: 'Custom range' },
];

const PENDING = 'Pending Manager Review';
const REJECTED = 'Rejected';
const APPROVED_SET = ['Approved', 'Batched for HR', 'Payment Sent'];

// A manager needs to know one of three things about a claim: it waits on them, it is
// settled, or it was refused. The five stored statuses collapse to those three. A claim
// approved by the system carries the same Approved badge as one a manager signed off,
// because for this view the distinction makes no difference.
const DISPLAY = {
  [PENDING]: { label: 'Pending', tone: 'yellow' },
  Approved: { label: 'Approved', tone: 'green' },
  'Batched for HR': { label: 'Approved', tone: 'green' },
  'Payment Sent': { label: 'Approved', tone: 'green' },
  [REJECTED]: { label: 'Rejected', tone: 'red' },
};

const shortDate = (value) => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const firstNameOf = (user) => (user?.name || '').trim().split(' ')[0] || 'there';
const isOverBudget = (claim) => claim.ceiling > 0 && claim.amount > claim.ceiling;

function regionPhrase(scope) {
  if (scope.global) return 'all regions';
  const list = scope.regions || [];
  if (!list.length) return 'no region assigned yet';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * Loads this approver's claims and keeps them current.
 *
 * Polled while the tab is visible so a claim submitted moments ago turns up in the
 * pending list without the manager reloading. Polling stops when the tab is hidden,
 * because refreshing a page nobody is looking at only costs sheet reads.
 */
function useManagerClaims() {
  const [state, setState] = useState({ loading: true, claims: [], counts: null, scope: null, regionsInView: [], error: '' });

  const load = useCallback((quiet = false) => {
    if (!quiet) setState((current) => ({ ...current, loading: current.counts === null }));
    return api.managerClaims()
      .then((data) => setState({ loading: false, ...data, error: '' }))
      .catch((error) => setState((current) => ({ ...current, loading: false, error: error.message })));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  return [state, load];
}

/* ------------------------------------------------------------------ Dashboard ----- */

export function ManagerHome({ money, user, onOpenClaims }) {
  const [state] = useManagerClaims();

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading your dashboard...</p></section>;
  if (state.error && !state.counts) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  const { counts, scope, claims } = state;
  const recent = claims.slice(0, 5);

  return <>
    <section className="page-heading"><div>
      <span className="kicker">Overview</span>
      <h1>Hello {firstNameOf(user)}</h1>
      <p>Claims from {regionPhrase(scope)}.</p>
    </div></section>

    <section className="stats manager-stats">
      <Card label="Pending" value={counts.pending} detail="Waiting on you" tone="yellow" onClick={() => onOpenClaims('Pending')} />
      <Card label="Approved" value={counts.approved} detail="Signed off" tone="green" onClick={() => onOpenClaims('Approved')} />
      <Card label="Rejected" value={counts.rejected} detail="Sent back" tone="red" onClick={() => onOpenClaims('Rejected')} />
    </section>

    <section className="panel activity-table">
      <div className="panel-heading">
        <div><span className="kicker">Recent activity</span><h2>Latest submissions</h2></div>
        {claims.length > 0 && <button className="text-button" onClick={() => onOpenClaims(ALL)}>View all {'→'}</button>}
      </div>
      {!recent.length ? <p className="queue-empty">Nobody in {regionPhrase(scope)} has submitted a claim yet.</p> : <>
        <div className="activity-head"><span>Trip details</span><span>Distance</span><span>Amount</span><span>Status</span></div>
        {recent.map((claim) => {
          const shown = DISPLAY[claim.status] || { label: claim.status, tone: 'gray' };
          return <div className="dashboard-trip-row" key={claim.id}>
            <div><strong>{claim.staffName || claim.submittedBy}</strong><span>{claim.purpose}</span><small>{claim.region} {'·'} {claim.vehicle} {'·'} {shortDate(claim.submittedAt)}</small></div>
            <span>{Number(claim.km || 0).toFixed(1)} km</span>
            <span>{money(claim.amount)}</span>
            <div className="status-columns"><small><b className={`pill ${shown.tone}`}>{shown.label}</b></small></div>
            <b className="row-arrow">{'›'}</b>
          </div>;
        })}
      </>}
    </section>
  </>;
}

/* -------------------------------------------------------------- Team's claims ----- */

export function TeamClaims({ money, user, initialStatus = ALL }) {
  const [state, load] = useManagerClaims();
  const [region, setRegion] = useState(ALL);
  const [status, setStatus] = useState(initialStatus);
  const [period, setPeriod] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);

  const scope = state.scope;
  // Offering "All regions" to someone who can only ever see one would be a lie: the
  // server has already narrowed their view. Only show the control when it can widen
  // anything, which means only when they cover more than one region.
  const myRegions = useMemo(() => (scope ? [...new Set([...(scope.regions || []), ...state.regionsInView])].sort() : []), [scope, state.regionsInView]);
  const showRegionFilter = myRegions.length > 1;

  const visible = useMemo(() => {
    const cutoff = period === '30' ? Date.now() - 30 * 864e5 : period === '90' ? Date.now() - 90 * 864e5 : null;
    // A date input gives a plain yyyy-mm-dd. The "to" bound covers the whole of that day,
    // so picking the same date for both returns that day's claims rather than nothing.
    const fromTime = period === 'custom' && from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTime = period === 'custom' && to ? new Date(`${to}T23:59:59.999`).getTime() : null;

    return state.claims.filter((claim) => {
      if (showRegionFilter && region !== ALL && claim.region !== region) return false;
      if (status === 'Pending' && claim.status !== PENDING) return false;
      if (status === 'Approved' && !APPROVED_SET.includes(claim.status)) return false;
      if (status === 'Rejected' && claim.status !== REJECTED) return false;

      const submitted = new Date(claim.submittedAt).getTime();
      if (cutoff && submitted < cutoff) return false;
      if (fromTime && submitted < fromTime) return false;
      if (toTime && submitted > toTime) return false;
      if (period === 'cycle' && scope?.currentCycle && claim.cycleKey !== scope.currentCycle) return false;
      return true;
    });
  }, [state.claims, scope, region, status, period, from, to, showRegionFilter]);

  const decide = async (claim, action) => {
    setBusy(claim.id);
    setActionError('');
    try {
      await api.decide(claim.id, action);
      setOpen(null);
      // Reload rather than patch locally: approving moves the claim out of Pending and
      // into Approved, and the counts have to move with it.
      await load(true);
    } catch (error) {
      setActionError(error.message);
    } finally {
      setBusy('');
    }
  };

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading claims...</p></section>;
  if (state.error && !state.counts) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  const counts = state.counts;

  return <>
    <section className="page-heading"><div>
      <span className="kicker">Submissions</span>
      <h1>My team{'’'}s claims</h1>
      <p>Claims from {regionPhrase(scope)}.</p>
    </div></section>

    <div className="status-tabs" role="tablist">
      {[
        { key: ALL, label: 'All', count: counts.total },
        { key: 'Pending', label: 'Pending', count: counts.pending, tone: 'yellow' },
        { key: 'Approved', label: 'Approved', count: counts.approved, tone: 'green' },
        { key: 'Rejected', label: 'Rejected', count: counts.rejected, tone: 'red' },
      ].map((tab) => <button
        key={tab.key}
        type="button"
        role="tab"
        aria-selected={status === tab.key}
        className={`status-tab ${status === tab.key ? 'selected' : ''} ${tab.tone || ''}`}
        onClick={() => setStatus(tab.key)}
      >{tab.label}<b>{tab.count}</b></button>)}
    </div>

    <section className="panel">
      <div className="panel-heading">
        <div>
          <span className="kicker">{showRegionFilter ? 'Your regions' : regionPhrase(scope)}</span>
          <h2>{visible.length} claim{visible.length === 1 ? '' : 's'}</h2>
        </div>
        <div className="filter-bar">
          {showRegionFilter && <label>Region
            <select value={region} onChange={(event) => setRegion(event.target.value)}>
              <option value={ALL}>All my regions</option>
              {myRegions.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>}
          <label>Period
            <select value={period} onChange={(event) => setPeriod(event.target.value)}>
              {PERIODS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          {period === 'custom' && <>
            <label>From<input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>To<input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
          </>}
          {(region !== ALL || status !== ALL || period !== 'all') && <button type="button" className="text-button clear-filters" onClick={() => { setRegion(ALL); setStatus(ALL); setPeriod('all'); setFrom(''); setTo(''); }}>Clear</button>}
        </div>
      </div>

      {(actionError || state.error) && <p className="queue-error">{actionError || state.error}</p>}

      {!visible.length ? <p className="queue-empty">{state.claims.length ? 'No claims match these filters.' : `Nobody in ${regionPhrase(scope)} has submitted a claim yet.`}</p> : <div className="claims-table-wrap">
        <table className="claims-table">
          <thead><tr>
            <th>Staff name</th>{showRegionFilter && <th>Region</th>}<th>Trip date</th><th className="right">Amount</th>
            <th>Reason</th><th>Transport</th><th>Submitted</th><th>Status</th><th aria-label="Actions" />
          </tr></thead>
          <tbody>
            {visible.map((claim) => {
              const shown = DISPLAY[claim.status] || { label: claim.status, tone: 'gray' };
              return <tr key={claim.id}>
                <td><strong>{claim.staffName || claim.submittedBy}</strong>{claim.zone && <small>{claim.zone}</small>}</td>
                {showRegionFilter && <td>{claim.region || '—'}</td>}
                <td>{claim.tripDate || '—'}</td>
                <td className="right"><strong className={isOverBudget(claim) ? 'over-budget' : ''}>{money(claim.amount)}</strong>{isOverBudget(claim) && <small className="over-budget">over limit</small>}</td>
                <td className="reason" title={claim.purpose}>{claim.purpose || '—'}</td>
                <td>{claim.vehicle || '—'}</td>
                <td>{shortDate(claim.submittedAt)}</td>
                <td><b className={`pill ${shown.tone}`}>{shown.label}</b></td>
                <td className="right"><button type="button" className="text-button" onClick={() => setOpen(claim)}>View {'→'}</button></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
    </section>

    {open && <ClaimDetail claim={open} money={money} user={user} busy={busy === open.id} onClose={() => setOpen(null)} onDecide={decide} />}
  </>;
}

function ProofOfPayment({ claimId, hasProof }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!hasProof) return undefined;
    let objectUrl = '';
    let cancelled = false;
    api.proofObjectUrl(claimId)
      .then((created) => { objectUrl = created; if (cancelled) { URL.revokeObjectURL(created); return; } setUrl(created); })
      .catch((caught) => { if (!cancelled) setError(caught.message); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [claimId, hasProof]);

  if (!hasProof) return <div className="proof-block"><h3>Proof of payment</h3><p className="proof-missing">No image was attached to this claim.</p></div>;

  return <div className="proof-block">
    <h3>Proof of payment</h3>
    {error && <p className="proof-missing">{error}</p>}
    {!error && !url && <p className="proof-missing">Loading image...</p>}
    {url && <>
      <a href={url} target="_blank" rel="noreferrer" className="proof-thumb"><img src={url} alt="M-Pesa confirmation" /></a>
      <a href={url} target="_blank" rel="noreferrer" className="text-button">Open full size {'↗'}</a>
    </>}
  </div>;
}

function Card({ label, value, detail, tone, onClick }) {
  return <button type="button" className={`stat stat-button tone-${tone}`} onClick={onClick}>
    <span>{label}</span><strong>{value}</strong><small>{detail}</small>
  </button>;
}

function ClaimDetail({ claim, money, user, busy, onClose, onDecide }) {
  const shown = DISPLAY[claim.status] || { label: claim.status, tone: 'gray' };
  // Only a claim still awaiting review can be acted on, and never one's own.
  const actionable = claim.status === PENDING && claim.submittedBy !== user?.email;
  const variance = claim.estimate > 0 ? claim.amount - claim.estimate : 0;

  return <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
    <div className="drawer" onClick={(event) => event.stopPropagation()}>
      <div className="drawer-head">
        <div><span className="kicker">{claim.id}</span><h2>{claim.staffName || claim.submittedBy}</h2></div>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="drawer-amount">
        <span>Amount claimed</span>
        <strong>{money(claim.amount)}</strong>
        {claim.estimate > 0 && <small>Songa estimate {money(claim.estimate)}{variance !== 0 ? ` · ${variance > 0 ? '+' : '−'}${money(Math.abs(variance))}` : ''}</small>}
      </div>

      {isOverBudget(claim) && <p className="over-budget-notice"><b>Over budget.</b> This claim is {money(claim.amount - claim.ceiling)} above {claim.staffName || 'their'} cycle maximum of {money(claim.ceiling)}. Songa let it through so you can decide; approving it commits the full amount.</p>}

      <dl className="drawer-facts">
        <div><dt>Status</dt><dd><b className={`pill ${shown.tone}`}>{shown.label}</b></dd></div>
        <div><dt>Region</dt><dd>{claim.region || '—'}</dd></div>
        <div><dt>Zone</dt><dd>{claim.zone || '—'}</dd></div>
        <div><dt>Trip date</dt><dd>{claim.tripDate || '—'}</dd></div>
        <div><dt>Submitted</dt><dd>{shortDate(claim.submittedAt)}</dd></div>
        <div><dt>Reason</dt><dd>{claim.purpose || '—'}</dd></div>
        <div><dt>Transport</dt><dd>{claim.vehicle || '—'}</dd></div>
        <div><dt>Distance</dt><dd>{Number(claim.km || 0).toFixed(1)} km at {money(claim.rate)} / km</dd></div>
        <div><dt>Claimant</dt><dd>{claim.submittedBy}</dd></div>
        <div><dt>Cycle</dt><dd>{claim.cycleKey || '—'}</dd></div>
      </dl>

      <ProofOfPayment claimId={claim.id} hasProof={Boolean(claim.proofFile)} />

      {claim.decisionLog?.length > 0 && <div className="drawer-log">
        <h3>History</h3>
        {claim.decisionLog.map((entry, index) => <p key={index}>
          <b>{entry.action}</b> by {entry.actor === 'system' ? 'Songa' : entry.actor}
          {entry.at && <span> {'·'} {shortDate(entry.at)}</span>}
          {entry.note && <small>{entry.note}</small>}
        </p>)}
      </div>}

      {actionable ? <div className="drawer-actions">
        <button type="button" className="button outline" disabled={busy} onClick={() => onDecide(claim, 'reject')}>Reject</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => onDecide(claim, 'approve')}>{busy ? 'Saving...' : 'Approve'}</button>
      </div> : <p className="drawer-note">{claim.submittedBy === user?.email ? 'This is your own claim, so someone else reviews it.' : 'This claim has already been decided.'}</p>}
    </div>
  </div>;
}
