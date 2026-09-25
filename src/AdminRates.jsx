import { useEffect, useMemo, useState } from 'react';
import { api } from './api';

/**
 * Per-kilometre rates, by region and mode, editable in place.
 *
 * Four modes rather than three: a hired piki and someone's own piki are priced
 * differently in every region, and collapsing them charged personal journeys at the
 * hired rate.
 *
 * There is no default region. A region with staff but no rates shows blank and is called
 * out at the top, because a wrong number that looks right is worse than a visible gap.
 */
export default function AdminRates({ money }) {
  const [state, setState] = useState({ loading: true, vehicles: [], table: {}, staffRegions: [], missing: [], lastChanged: {}, error: '' });
  const [history, setHistory] = useState(null);
  const [adding, setAdding] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  const load = () => api.adminRates()
    .then((data) => { setState({ loading: false, ...data, error: '' }); setDraft(null); })
    .catch((error) => setState((current) => ({ ...current, loading: false, error: error.message })));

  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    // Regions with staff first: those are the ones that must be right.
    const table = draft || state.table;
    const withStaff = state.staffRegions.filter((name) => name in table);
    const others = Object.keys(table).filter((name) => !state.staffRegions.includes(name)).sort();
    return [...withStaff, ...others];
  }, [draft, state.table, state.staffRegions]);

  const table = draft || state.table;
  const dirty = draft !== null;
  const blank = (region) => state.vehicles.some((vehicle) => !(Number(table[region]?.[vehicle]) > 0));

  const addRegion = () => {
    const name = adding.trim();
    if (!name) return;
    setDraft({ ...(draft || state.table), [name]: Object.fromEntries(state.vehicles.map((v) => [v, 0])) });
    setAdding('');
  };

  const edit = (region, vehicle, value) => {
    setSaved('');
    setDraft((current) => {
      const base = current || state.table;
      return { ...base, [region]: { ...base[region], [vehicle]: value } };
    });
  };

  const save = async () => {
    setSaving(true);
    setState((current) => ({ ...current, error: '' }));
    try {
      const cleaned = Object.fromEntries(Object.entries(draft).map(([region, rates]) => [
        region,
        Object.fromEntries(state.vehicles.map((vehicle) => [vehicle, Number(rates[vehicle]) || 0])),
      ]));
      const result = await api.saveRates(cleaned);
      setState((current) => ({ ...current, table: result.table }));
      setDraft(null);
      setSaved('Rates saved. New claims use them straight away.');
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setSaving(false);
    }
  };

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading rates...</p></section>;

  return <>
    <section className="page-heading"><div>
      <span className="kicker">Admin</span>
      <h1>Transport rates</h1>
      <p>What Songa pays per kilometre, by region and mode of transport.</p>
    </div></section>

    <section className="panel">
      <div className="toolbar">
        <div className="toolbar-left">
          <p className="rates-note">
            Every region carries its own rates. Changes apply to new claims immediately;
            claims already submitted keep the rate they were calculated with.
          </p>
        </div>
        <div className="toolbar-right">
          {dirty && <button type="button" className="text-button" onClick={() => { setDraft(null); setSaved(''); }}>Discard</button>}
          <button type="button" className="button primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving...' : dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      {state.missing?.length > 0 && <div className="admin-warnings">
        <p>
          <b>{state.missing.length} {state.missing.length === 1 ? 'region has' : 'regions have'} staff but no rates:</b>{' '}
          {state.missing.join(', ')}. Claims from {state.missing.length === 1 ? 'it' : 'them'} cannot be
          estimated until every mode has a rate.
        </p>
      </div>}

      {state.error && <p className="queue-error">{state.error}</p>}
      {saved && <p className="outcome-note calm">{saved}</p>}

      <div className="claims-table-wrap">
        <table className="claims-table rates-table">
          <thead><tr>
            <th>Region</th>
            {state.vehicles.map((vehicle) => <th className="right" key={vehicle}>{vehicle}</th>)}
            <th>Last changed</th>
          </tr></thead>
          <tbody>
            {rows.map((region) => {
              const hasStaff = state.staffRegions.includes(region);
              const incomplete = blank(region);
              return <tr key={region} className={incomplete ? 'needs-rates' : ''}>
                <td>
                  <strong>{region}</strong>
                  <small>{incomplete ? 'rates not set' : hasStaff ? 'has staff' : 'no staff here'}</small>
                </td>
                {state.vehicles.map((vehicle) => <td className="right" key={vehicle}>
                  <span className="rate-input">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={table[region]?.[vehicle] ?? ''}
                      onChange={(event) => edit(region, vehicle, event.target.value)}
                      aria-label={`${vehicle} rate for ${region}`}
                    />
                    <em>/km</em>
                  </span>
                </td>)}
                <td className="changed">
                  {state.lastChanged?.[region]
                    ? <>
                        <strong>{state.lastChanged[region].by}</strong>
                        <small>{ago(state.lastChanged[region].at)}</small>
                        <button type="button" className="text-button" onClick={() => setHistory(region)}>view history</button>
                      </>
                    : <span className="none">never changed</span>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <div className="add-region">
        <input
          type="text"
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addRegion(); } }}
          placeholder="Add a region"
          aria-label="New region name"
        />
        <button type="button" className="button outline" onClick={addRegion} disabled={!adding.trim()}>Add region</button>
      </div>
    </section>

    {history && <RateHistory region={history} money={money} onClose={() => setHistory(null)} />}
  </>;
}

/** How long ago, in the units a person would actually use. */
function ago(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, size] of units) {
    const value = Math.floor(seconds / size);
    if (value >= 1) return `${value} ${name}${value === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/**
 * The full trail for one region.
 *
 * A rate decides what people are paid, so an old claim has to be explainable months
 * later — the current figure alone cannot say what was in force at the time.
 */
function RateHistory({ region, money, onClose }) {
  const [state, setState] = useState({ loading: true, changes: [], error: '' });

  useEffect(() => {
    api.rateHistory(region)
      .then((data) => setState({ loading: false, changes: data.changes, error: '' }))
      .catch((error) => setState({ loading: false, changes: [], error: error.message }));
  }, [region]);

  return <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
    <div className="drawer" onClick={(event) => event.stopPropagation()}>
      <div className="drawer-head">
        <div><span className="kicker">Rate history</span><h2>{region}</h2></div>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {state.loading && <p className="queue-empty">Loading...</p>}
      {state.error && <p className="queue-error">{state.error}</p>}
      {!state.loading && !state.changes.length && <p className="drawer-note">No changes recorded for this region.</p>}

      {state.changes.length > 0 && <div className="history-list">
        {state.changes.map((change, index) => <div className="history-row" key={index}>
          <div>
            <strong>{change.vehicle}</strong>
            <small>{change.by} {'·'} {ago(change.at)}</small>
          </div>
          <div className="history-values">
            {change.newRate === null
              ? <b className="pill red">removed</b>
              : <>
                  {change.oldRate !== null && <span className="was">{money(change.oldRate)}</span>}
                  <b>{money(change.newRate)}</b>
                </>}
          </div>
        </div>)}
      </div>}
    </div>
  </div>;
}
