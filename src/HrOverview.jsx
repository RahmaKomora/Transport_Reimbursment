import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * HR's landing page: every region's cycle, in one table.
 *
 * HR does not approve individual claims, so a queue is the wrong shape for them. What
 * they need is where the money went by region, and which regions have claims still
 * unapproved — because those miss this cycle's payment run unless a manager acts, and
 * chasing that manager is something only HR is placed to do.
 */
const shortDate = (value) => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—');

function daysWaiting(since) {
  if (!since) return 0;
  return Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000);
}

export default function HrOverview({ money, user, onOpen }) {
  const [state, setState] = useState({ loading: true, regions: [], totals: null, cycle: null, error: '' });

  useEffect(() => {
    api.regionalSummary()
      .then((data) => setState({ loading: false, ...data, error: '' }))
      .catch((error) => setState({ loading: false, regions: [], totals: null, cycle: null, error: error.message }));
  }, []);

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading this cycle...</p></section>;
  if (state.error) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  const { totals, cycle, regions, excluded } = state;
  const first = (user?.name || '').trim().split(' ')[0] || 'there';
  const waiting = regions.filter((region) => region.pending.count > 0);

  return <>
    <section className="page-heading"><div>
      <span className="kicker">Overview</span>
      <h1>Hello {first}</h1>
      <p>{cycle.label}, {cycle.range} {'·'} closes {new Date(cycle.closesAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.</p>
    </div></section>

    <section className="stats hr-stats">
      <div className="stat"><span>Allocated</span><strong>{money(totals.allocation)}</strong><small>{totals.staff} staff across {totals.regions} region{totals.regions === 1 ? '' : 's'}</small></div>
      <div className="stat"><span>Approved</span><strong>{money(totals.approved)}</strong><small>{totals.approvedCount} claim{totals.approvedCount === 1 ? '' : 's'} signed off</small></div>
      <div className="stat"><span>Awaiting managers</span><strong className={totals.pendingCount ? 'attention' : ''}>{money(totals.pending)}</strong><small>{totals.pendingCount} claim{totals.pendingCount === 1 ? '' : 's'} not yet approved</small></div>
      <div className="stat"><span>Rejected</span><strong>{money(totals.rejected)}</strong><small>{totals.rejectedCount} sent back</small></div>
      <div className="stat"><span>Unspent</span><strong className="saved">{money(totals.unspent)}</strong><small>Returns to the department</small></div>
    </section>

    {waiting.length > 0 && <section className="chase-panel">
      <div>
        <strong>{totals.pendingCount} claim{totals.pendingCount === 1 ? '' : 's'} still with managers</strong>
        <p>
          {waiting.map((region) => `${region.region} (${region.pending.count})`).join(', ')}.
          {' '}Anything not approved before the cycle closes misses this payment run.
        </p>
      </div>
      {onOpen && <button type="button" className="button outline" onClick={() => onOpen('hr')}>Open reimbursements</button>}
    </section>}

    <section className="panel">
      <div className="panel-heading"><div>
        <span className="kicker">By region</span>
        <h2>This cycle</h2>
      </div></div>

      {!regions.length ? <p className="queue-empty">No regions have staff with a transport allowance yet.</p> : <div className="claims-table-wrap">
        <table className="claims-table budget-table">
          <thead><tr>
            <th>Region</th><th className="right">Allocated</th><th className="right">Approved</th>
            <th className="right">Pending</th><th className="right">Rejected</th>
            <th className="right">Spent</th><th>Used</th><th className="right">Unspent</th>
          </tr></thead>
          <tbody>
            {regions.map((region) => {
              const percent = Math.min(100, Math.round(region.utilisation * 100));
              const stale = daysWaiting(region.pending.oldest);
              return <tr key={region.region}>
                <td><strong>{region.region}</strong><small>{region.staff} staff</small></td>
                <td className="right">{money(region.allocation)}</td>
                <td className="right"><strong>{money(region.approved.amount)}</strong><small>{region.approved.count} claim{region.approved.count === 1 ? '' : 's'}</small></td>
                <td className="right">
                  {region.pending.count
                    ? <><strong className="attention">{money(region.pending.amount)}</strong><small>{region.pending.count} waiting{stale > 0 ? `, oldest ${stale}d` : ''}</small></>
                    : <span className="none">{'—'}</span>}
                </td>
                <td className="right">{region.rejected.count ? <><strong>{money(region.rejected.amount)}</strong><small>{region.rejected.count}</small></> : <span className="none">{'—'}</span>}</td>
                {/* The money drawn down, next to the bar. The bar answers "is this
                    region close to its limit"; the figure answers "how much". */}
                <td className="right"><strong>{money(region.committed)}</strong></td>
                {/* A region can have spend with no allowance behind it — somebody claiming
                    who has no budget set. A 0% bar would read as "nothing used", which is
                    the opposite of what happened, so say there is no budget instead. */}
                <td>{region.allocation > 0
                  ? <>
                      <span className="budget-bar" aria-label={`${percent}% used`}><i style={{ width: `${percent}%` }} /></span>
                      <small className="budget-percent">{percent}%</small>
                    </>
                  : <small className="budget-percent none">{region.committed > 0 ? 'no budget set' : '—'}</small>}
                </td>
                <td className="right"><strong className={region.unspent > 0 ? 'saved' : ''}>{money(region.unspent)}</strong></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
      <p className="table-footnote">
        Allocated is the sum of this cycle&rsquo;s allowances for staff in each region. Spent is what
        has been drawn against it: approved claims plus those still pending, because that money has
        already left someone&rsquo;s pocket whatever the approval says later. Rejected does not count
        against the budget. Unspent is what returns to the department if nothing else is claimed.
      </p>

      {/* Without this the allocation is unexplainable: a roster of 1,400 showing a five-figure
          budget reads as a broken sum rather than as most of the roster being switched off. */}
      {excluded && (excluded.inactive > 0 || excluded.noAllowance > 0) && <p className="table-footnote muted-note">
        These figures cover {totals.staff} {totals.staff === 1 ? 'person' : 'people'}.
        {excluded.inactive > 0 && ` ${excluded.inactive.toLocaleString('en-GB')} deactivated ${excluded.inactive === 1 ? 'account is' : 'accounts are'} excluded`}
        {excluded.inactive > 0 && excluded.noAllowance > 0 && ', and'}
        {excluded.noAllowance > 0 && ` ${excluded.noAllowance.toLocaleString('en-GB')} active ${excluded.noAllowance === 1 ? 'person has' : 'people have'} no allowance set`}
        . Nothing they claim would be counted here.
      </p>}
    </section>
  </>;
}
