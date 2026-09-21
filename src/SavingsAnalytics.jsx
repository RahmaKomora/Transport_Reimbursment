import { useEffect, useState } from 'react';
import { api } from './api';

// Unspent budget for the current cycle, by region and by person. Budgets do not roll
// over, so "saved" here is money the department keeps, not money anyone can still spend.
export default function SavingsAnalytics({ money }) {
  const [state, setState] = useState({ loading: true, regions: [], totals: null, cycle: '', error: '' });
  const [openRegion, setOpenRegion] = useState('');

  useEffect(() => {
    api.savings()
      .then((data) => setState({ loading: false, regions: data.regions, totals: data.totals, cycle: data.cycle, error: '' }))
      .catch((error) => setState({ loading: false, regions: [], totals: null, cycle: '', error: error.message }));
  }, []);

  if (state.loading) return <section className="panel"><p className="queue-empty">Working out this cycle's savings...</p></section>;
  if (state.error) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  const { totals } = state;
  return <>
    <section className="stats savings-stats">
      <Stat label="Allocated this cycle" value={money(totals.allocation)} detail={`${totals.staff} staff`} />
      <Stat label="Committed" value={money(totals.committed)} detail={`${totals.claimCount} claims approved or paid`} />
      <Stat label="Paid out" value={money(totals.paid)} detail="M-Pesa sent" />
      <Stat label="Saved" value={money(totals.saved)} detail={`Cycle ${state.cycle} · does not roll over`} tone="mint" />
    </section>
    <section className="panel">
      <div className="panel-heading"><div><span className="kicker">By region</span><h2>Where the budget went</h2></div></div>
      {state.regions.map((region) => {
        const expanded = openRegion === region.region;
        const percent = Math.min(100, Math.round(region.utilisation * 100));
        return <div className="savings-region" key={region.region}>
          <button type="button" className="savings-head" onClick={() => setOpenRegion(expanded ? '' : region.region)} aria-expanded={expanded}>
            <span className="savings-name">{region.region}<small>{region.staff} staff · {region.claimCount} claims</small></span>
            <span className="savings-bar" aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>
            <span className="savings-figures"><b>{money(region.saved)} saved</b><small>{percent}% of {money(region.allocation)} used</small></span>
          </button>
          {expanded && <div className="savings-people">
            <div className="savings-person heading"><span>Staff</span><span>Allocation</span><span>Committed</span><span>Saved</span></div>
            {region.people.map((person) => <div className="savings-person" key={person.email}>
              <span>{person.name || person.email}<small>{person.zone}</small></span>
              <span>{money(person.allocation)}</span>
              <span>{money(person.committed)}</span>
              <span className={person.saved > 0 ? 'saved' : ''}>{money(person.saved)}</span>
            </div>)}
          </div>}
        </div>;
      })}
    </section>
  </>;
}

function Stat({ label, value, detail }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
