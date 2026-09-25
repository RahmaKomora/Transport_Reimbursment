import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Every wallet in the manager's team for the open cycle.
 *
 * Approvals only show the money that needed a decision. This shows the money that did
 * not: who is running close to their allowance, who has barely touched it, and what the
 * department keeps if the cycle ended today. "Saved" counts pending claims as spent, so
 * it is the figure that cannot be revised downward by an approval still outstanding.
 */
export default function TeamBudgets({ money }) {
  const [state, setState] = useState({ loading: true, people: [], totals: null, cycle: null, scope: null, error: '' });

  useEffect(() => {
    api.teamBudgets()
      .then((data) => setState({ loading: false, ...data, error: '' }))
      .catch((error) => setState({ loading: false, people: [], totals: null, cycle: null, scope: null, error: error.message }));
  }, []);

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading team budgets...</p></section>;
  if (state.error) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  const { totals, cycle, people, scope } = state;
  const where = scope.global ? 'all regions' : scope.regions.join(', ') || 'your region';
  const share = totals.allocated ? Math.round((totals.used / totals.allocated) * 100) : 0;

  return <>
    <section className="page-heading"><div>
      <span className="kicker">Budgets</span>
      <h1>Team allowances</h1>
      <p>{cycle.label}, {cycle.range} {'·'} {where}.</p>
    </div></section>

    <section className="stats manager-stats budget-stats">
      <div className="stat"><span>Allocated</span><strong>{money(totals.allocated)}</strong><small>{totals.staff} staff this cycle</small></div>
      <div className="stat"><span>Used</span><strong>{money(totals.used)}</strong><small>{share}% of the allowance{totals.awaiting ? `, ${money(totals.awaiting)} still awaiting approval` : ''}</small></div>
      <div className="stat"><span>Unspent</span><strong className="saved">{money(totals.saved)}</strong><small>{totals.onTopUp ? `${totals.onTopUp} on the top-up` : 'nobody on the top-up yet'}</small></div>
    </section>

    <section className="panel">
      <div className="panel-heading"><div>
        <span className="kicker">Per person</span>
        <h2>Where the allowance went</h2>
      </div></div>

      {!people.length ? <p className="queue-empty">Nobody in {where} has a transport allowance set.</p> : <div className="claims-table-wrap">
        <table className="claims-table budget-table">
          <thead><tr>
            <th>Staff</th>{scope.global && <th>Region</th>}
            <th className="right">Allowance</th><th className="right">Used</th>
            <th>Drawn down</th><th className="right">Unspent</th><th className="right">Top-up left</th>
          </tr></thead>
          <tbody>
            {people.map((person) => {
              const percent = person.base ? Math.min(100, Math.round((person.used / person.base) * 100)) : 0;
              return <tr key={person.email}>
                <td><strong>{person.name || person.email}</strong>{person.zone && <small>{person.zone}</small>}</td>
                {scope.global && <td>{person.region || '—'}</td>}
                <td className="right">{money(person.base)}</td>
                <td className="right"><strong>{money(person.used)}</strong>{person.awaiting > 0 && <small>{money(person.awaiting)} pending</small>}</td>
                <td>
                  <span className="budget-bar" aria-label={`${percent}% used`}>
                    <i className={person.usingTopUp ? 'over' : ''} style={{ width: `${percent}%` }} />
                  </span>
                  <small className="budget-percent">{percent}%{person.usingTopUp ? ' · on top-up' : ''}</small>
                </td>
                <td className="right"><strong className={person.saved > 0 ? 'saved' : ''}>{money(person.saved)}</strong></td>
                <td className="right">{money(person.topUpRemaining)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
      <p className="table-footnote">
        Unspent counts claims awaiting approval as already spent, so it is the figure that cannot
        shrink once outstanding approvals land. Nothing carries into the next cycle.
      </p>
    </section>
  </>;
}
