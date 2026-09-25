import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Regional budgets, for an admin.
 *
 * Two levels on purpose. The top one answers "what did each region get", which is the
 * question asked when planning or reporting, and nothing else competes with the figure.
 * Opening a region answers "and what happened to it" — drawn down, approved, still with
 * a manager, rejected, and what would go back unspent — and whose desk the unapproved
 * claims are sitting on, because that is the name somebody has to call.
 *
 * The HR overview shows the same cycle as one wide table, which suits scanning every
 * region for claims about to miss the payment run. This is the other shape of the same
 * money: one region at a time, in depth.
 */
export default function AdminRegions({ money }) {
  const [state, setState] = useState({ loading: true, regions: [], totals: null, cycle: null, excluded: null, error: '' });
  const [open, setOpen] = useState(null);

  useEffect(() => {
    api.regionalSummary()
      .then((data) => setState({ loading: false, ...data, error: '' }))
      .catch((error) => setState((current) => ({ ...current, loading: false, error: error.message })));
  }, []);

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading regional budgets...</p></section>;
  if (state.error) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  const { regions, totals, cycle, excluded } = state;
  const region = open && regions.find((item) => item.region === open);

  if (region) {
    return <RegionDetail region={region} cycle={cycle} money={money} onBack={() => setOpen(null)} />;
  }

  return <>
    <section className="page-heading"><div>
      <span className="kicker">Admin</span>
      <h1>Regional budgets</h1>
      <p>What each region has to spend this cycle. {cycle.label}, {cycle.range}.</p>
    </div></section>

    <section className="stats region-totals">
      <div className="stat"><span>Allocated</span><strong>{money(totals.allocation)}</strong><small>across {totals.regions} region{totals.regions === 1 ? '' : 's'}</small></div>
      <div className="stat"><span>Spent</span><strong>{money(totals.committed)}</strong><small>approved and pending</small></div>
      <div className="stat"><span>Unspent</span><strong className="saved">{money(totals.unspent)}</strong><small>returns to the department</small></div>
    </section>

    {!regions.length
      ? <section className="panel"><p className="queue-empty">No region has staff with a transport allowance yet.</p></section>
      : <div className="region-grid">
          {[...regions].sort((a, b) => b.allocation - a.allocation || a.region.localeCompare(b.region)).map((item) => {
            const percent = item.allocation > 0 ? Math.min(100, Math.round(item.utilisation * 100)) : null;
            return <button type="button" className="region-card" key={item.region} onClick={() => setOpen(item.region)}>
              <span className="region-card-head">
                <strong>{item.region}</strong>
                <small>{item.staff} {item.staff === 1 ? 'person' : 'people'}</small>
              </span>
              <b className="region-card-figure">{money(item.allocation)}</b>
              <span className="region-card-sub">allocated this cycle</span>
              {percent === null
                ? <span className="region-card-none">{item.committed > 0 ? 'spending with no budget set' : 'no budget set'}</span>
                : <>
                    <span className="budget-bar"><i style={{ width: `${percent}%` }} /></span>
                    <span className="region-card-foot">{money(item.committed)} used {'·'} {percent}%</span>
                  </>}
              {item.pending.count > 0 && <span className="region-card-flag">{item.pending.count} awaiting a manager</span>}
              <span className="region-card-open" aria-hidden="true">{'→'}</span>
            </button>;
          })}
        </div>}

    {excluded && (excluded.inactive > 0 || excluded.noAllowance > 0) && <p className="table-footnote muted-note">
      These budgets cover {totals.staff} {totals.staff === 1 ? 'person' : 'people'}.
      {excluded.inactive > 0 && ` ${excluded.inactive.toLocaleString('en-GB')} deactivated ${excluded.inactive === 1 ? 'account is' : 'accounts are'} excluded`}
      {excluded.inactive > 0 && excluded.noAllowance > 0 && ', and'}
      {excluded.noAllowance > 0 && ` ${excluded.noAllowance.toLocaleString('en-GB')} active ${excluded.noAllowance === 1 ? 'person has' : 'people have'} no allowance set`}
      .
    </p>}
  </>;
}

/**
 * One region, opened.
 *
 * Rejected is shown apart from the rest because it is the one figure that does not touch
 * the budget: the money was never paid, so counting it against the allowance would
 * double-count a trip the region still has the funds for.
 */
function RegionDetail({ region, cycle, money, onBack }) {
  const percent = region.allocation > 0 ? Math.min(100, Math.round(region.utilisation * 100)) : null;

  return <>
    <section className="page-heading"><div>
      <button type="button" className="back-link" onClick={onBack}>{'←'} All regions</button>
      <h1>{region.region}</h1>
      <p>{region.staff} {region.staff === 1 ? 'person' : 'people'} with an allowance {'·'} {cycle.label}, {cycle.range}.</p>
    </div></section>

    <section className="stats region-detail-stats">
      <div className="stat"><span>Allocated</span><strong>{money(region.allocation)}</strong><small>base allowances</small></div>
      <div className="stat"><span>Used</span><strong>{money(region.committed)}</strong><small>{percent === null ? 'no budget set' : `${percent}% of the allocation`}</small></div>
      <div className="stat"><span>Saved</span><strong className="saved">{money(region.unspent)}</strong><small>unspent if nothing more is claimed</small></div>
    </section>

    <section className="panel">
      <div className="panel-heading"><div>
        <span className="kicker">Where it went</span>
        <h2>This cycle</h2>
      </div></div>

      <div className="breakdown">
        <div className="breakdown-row">
          <div><strong>Approved</strong><small>signed off by a manager</small></div>
          <div className="breakdown-value"><b>{money(region.approved.amount)}</b><small>{region.approved.count} claim{region.approved.count === 1 ? '' : 's'}</small></div>
        </div>
        <div className="breakdown-row">
          <div><strong>Of that, paid out</strong><small>completed by HR</small></div>
          <div className="breakdown-value"><b>{money(region.paid.amount)}</b><small>{region.paid.count} claim{region.paid.count === 1 ? '' : 's'}</small></div>
        </div>
        <div className="breakdown-row">
          <div><strong>Awaiting a manager</strong><small>misses this payment run unless approved</small></div>
          <div className="breakdown-value">
            <b className={region.pending.count ? 'attention' : ''}>{money(region.pending.amount)}</b>
            <small>{region.pending.count} claim{region.pending.count === 1 ? '' : 's'}</small>
          </div>
        </div>
        <div className="breakdown-row">
          <div><strong>Top-up available</strong><small>on request, above the base allowance</small></div>
          <div className="breakdown-value"><b>{money(region.topUp)}</b><small>across the region</small></div>
        </div>
        <div className="breakdown-row muted">
          <div><strong>Rejected</strong><small>sent back — does not count against the budget</small></div>
          <div className="breakdown-value"><b>{money(region.rejected.amount)}</b><small>{region.rejected.count} claim{region.rejected.count === 1 ? '' : 's'}</small></div>
        </div>
      </div>
    </section>

    <PendingByApprover region={region} money={money} />
  </>;
}

/** How many days a claim has been sitting. Whole days, because that is how it is chased. */
function daysSince(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Who is holding up this region's claims.
 *
 * A claim awaiting approval is money already spent by a field officer out of their own
 * pocket, and it misses the payment run if the cycle closes first. The useful question is
 * therefore not how much is pending but *whose desk it is on*, because that is the name
 * somebody has to call. Sorted by how many each is holding, with the longest wait shown,
 * since one claim sitting nine days matters more than three filed this morning.
 */
function PendingByApprover({ region, money }) {
  const waiting = region.pendingBy || [];
  const worst = Math.max(1, ...waiting.map((item) => item.count));

  return <section className="panel">
    <div className="panel-heading"><div>
      <span className="kicker">Awaiting approval</span>
      <h2><PendingIcon /> Pending claims by approver</h2>
    </div></div>

    {!waiting.length
      ? <p className="queue-empty">Nothing in {region.region} is waiting on an approver.</p>
      : <div className="approver-list">
          {waiting.map((item) => {
            const days = daysSince(item.oldest);
            return <div className="approver-row" key={item.email || 'unassigned'}>
              <div className="approver-who">
                {item.email
                  ? <><strong>{item.name || item.email}</strong><small>{item.email}</small></>
                  : <><strong className="attention">No approver assigned</strong><small>nobody has been asked to decide these</small></>}
              </div>
              <div className="approver-bar">
                <span className="budget-bar"><i style={{ width: `${(item.count / worst) * 100}%` }} className={item.email ? '' : 'over'} /></span>
              </div>
              <div className="approver-count">
                <b>{item.count}</b>
                <small>{item.count === 1 ? 'claim' : 'claims'} {'·'} {money(item.amount)}</small>
              </div>
              <div className="approver-waited">
                {days > 0
                  ? <span className={days >= 5 ? 'attention' : ''}>{days}d waiting</span>
                  : <span className="none">today</span>}
              </div>
            </div>;
          })}
        </div>}

    <p className="table-footnote">
      Longest wait is the oldest claim still with that approver. Anything not approved before the
      cycle closes misses this payment run, whoever it is with.
    </p>
  </section>;
}

/** A clock: the same glyph HR's Pending stage uses, so the two read as the same thing. */
function PendingIcon() {
  return <svg className="heading-icon" width="17" height="17" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
  </svg>;
}
