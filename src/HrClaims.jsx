import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

/**
 * Every claim in one table, with filters added as they are needed.
 *
 * Three separate tabs meant a question like "what did Coast claim last cycle" could not
 * be answered at all — the data was split by status, which is only one of the things HR
 * needs to slice by. Filters are opt-in rather than always on screen: an empty dropdown
 * for a filter nobody is using is clutter, and HR usually wants one or two at a time.
 */
const FILTERS = [
  { key: 'region', label: 'Region' },
  { key: 'approval', label: 'Approval' },
  { key: 'payout', label: 'Payout' },
  { key: 'dates', label: 'Date range' },
];

/**
 * The four states of HR's day, as a bar across the top.
 *
 * One flat table answers "what did Coast claim last cycle" but buries the question HR
 * actually opens the page with, which is "what is waiting on me". These are the stages a
 * claim passes through, so a claim leaves a tab when it has moved on: paying an approved
 * claim moves it from Approved to Completed, which is what makes Approved a work queue
 * rather than an archive.
 *
 * All claims keeps the old flat view, because it is the only one that also shows rejected
 * claims and the only sensible thing to export for a full reconciliation.
 */
const SEGMENTS = [
  { key: 'pending', label: 'Pending', blurb: 'Waiting on a manager. HR cannot approve these — chase the approver.', match: (claim) => claim.status === 'Pending Manager Review' },
  { key: 'approved', label: 'Approved', blurb: 'Signed off and awaiting payout. Mark them completed once Finance has paid.', match: (claim) => AWAITING_PAYOUT.includes(claim.status) },
  { key: 'completed', label: 'Completed', blurb: 'Paid out.', match: (claim) => claim.status === 'Completed' },
  { key: 'all', label: 'All claims', blurb: 'Everything, including rejected.', match: () => true },
];

// Approval and payout are fixed by every segment except All, so offering them there would
// be a filter that can only narrow the list to nothing.
const FILTERS_FOR = (segment) => (segment === 'all' ? FILTERS : FILTERS.filter((f) => f.key === 'region' || f.key === 'dates'));

/**
 * Approval and payout are two separate questions, so they get two columns.
 *
 * Approval is the manager's or the system's answer: did this claim qualify. Payout is
 * HR's: has Finance settled it. A claim can sit approved and unpaid for a fortnight, and
 * collapsing both into one badge hid exactly the state HR spends its time on.
 *
 * Both are read off the single stored status, so there is no second field to keep in step.
 */
const APPROVED_STATES = ['Approved', 'Batched for HR', 'Completed'];
const AWAITING_PAYOUT = ['Approved', 'Batched for HR'];

const approvalOf = (status) => {
  if (status === 'Pending Manager Review') return { label: 'Pending', tone: 'yellow' };
  if (status === 'Rejected') return { label: 'Rejected', tone: 'red' };
  if (APPROVED_STATES.includes(status)) return { label: 'Approved', tone: 'green' };
  return { label: status, tone: 'gray' };
};

// Nothing is owed on a claim that was never approved, so payout does not apply to it.
const payoutOf = (status) => {
  if (status === 'Completed') return { label: 'Completed', tone: 'orange' };
  if (AWAITING_PAYOUT.includes(status)) return { label: 'Pending', tone: 'gray' };
  return null;
};

const canComplete = (claim) => AWAITING_PAYOUT.includes(claim.status);
const stamp = (value) => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function HrClaims({ money }) {
  const [state, setState] = useState({ loading: true, claims: [], cycles: [], regions: [], currentCycle: '', error: '' });
  const [segment, setSegment] = useState('pending');
  const [active, setActive] = useState([]);
  const [cycle, setCycle] = useState('all');
  const [region, setRegion] = useState('all');
  const [approval, setApproval] = useState('all');
  const [payout, setPayout] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [marking, setMarking] = useState(false);
  const menu = useRef(null);

  const load = useCallback(() => {
    api.allClaims()
      .then((data) => setState({ loading: false, ...data, error: '' }))
      .catch((error) => setState((current) => ({ ...current, loading: false, error: error.message })));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!adding) return undefined;
    const close = (event) => { if (menu.current && !menu.current.contains(event.target)) setAdding(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [adding]);

  // The cycle applies before everything, so the tab counts describe the cycle on screen
  // rather than all of history.
  const inCycle = useMemo(
    () => (cycle === 'all' ? state.claims : state.claims.filter((claim) => (claim.cycleKey || '') === cycle)),
    [state.claims, cycle],
  );
  const counts = useMemo(
    () => Object.fromEntries(SEGMENTS.map((item) => [item.key, inCycle.filter(item.match).length])),
    [inCycle],
  );

  const rows = useMemo(() => {
    const fromTime = from ? new Date(`${from}T00:00:00`).getTime() : null;
    // The "to" bound covers the whole of that day, so the same date twice returns that day.
    const toTime = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    const stage = SEGMENTS.find((item) => item.key === segment) || SEGMENTS[3];

    return inCycle.filter((claim) => {
      if (!stage.match(claim)) return false;
      if (active.includes('region') && region !== 'all' && claim.region !== region) return false;
      if (active.includes('approval') && approval !== 'all' && approvalOf(claim.status).label !== approval) return false;
      if (active.includes('payout') && payout !== 'all' && (payoutOf(claim.status)?.label || '') !== payout) return false;
      if (active.includes('dates')) {
        const at = new Date(claim.submittedAt).getTime();
        if (fromTime && at < fromTime) return false;
        if (toTime && at > toTime) return false;
      }
      return true;
    });
  }, [inCycle, segment, active, region, approval, payout, from, to]);

  const total = rows.reduce((sum, claim) => sum + (Number(claim.amount) || 0), 0);

  // Only rows that can actually be marked are selectable, so the bulk action never
  // half-fails on a row the user could see should not have been included.
  const selectable = rows.filter(canComplete);
  const chosen = selectable.filter((claim) => selected.has(claim.id));
  const chosenTotal = chosen.reduce((sum, claim) => sum + (Number(claim.amount) || 0), 0);
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;

  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allChosen ? new Set() : new Set(selectable.map((claim) => claim.id)));

  const markCompleted = async (ids) => {
    setMarking(true);
    try {
      const result = await api.completeClaims(ids);
      setSelected(new Set());
      if (result.skipped?.length) {
        setState((current) => ({ ...current, error: `${result.completed} marked. ${result.skipped.length} could not be: ${result.skipped[0].reason}` }));
      }
      load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setMarking(false);
    }
  };

  /**
   * Switching stage clears the selection and drops any filter the new stage fixes.
   *
   * Leaving an Approval filter applied while moving to Pending would show an empty table
   * with no visible reason — the control that emptied it is no longer on screen.
   */
  const chooseSegment = (key) => {
    setSegment(key);
    setSelected(new Set());
    const allowed = new Set(FILTERS_FOR(key).map((filter) => filter.key));
    setActive((current) => current.filter((item) => allowed.has(item)));
    if (!allowed.has('approval')) setApproval('all');
    if (!allowed.has('payout')) setPayout('all');
    setAdding(false);
  };

  const addFilter = (key) => {
    setActive((current) => (current.includes(key) ? current : [...current, key]));
    setAdding(false);
  };
  const removeFilter = (key) => {
    setActive((current) => current.filter((item) => item !== key));
    if (key === 'region') setRegion('all');
    if (key === 'approval') setApproval('all');
    if (key === 'payout') setPayout('all');
    if (key === 'dates') { setFrom(''); setTo(''); }
  };

  const exportCsv = () => {
    const header = ['Claim ID', 'Submitted', 'Staff', 'Email', 'Region', 'Zone', 'Trip date', 'Purpose', 'Transport', 'Distance km', 'Rate', 'Amount', 'Approval', 'Approved by', 'Payout', 'Completed on', 'Completed by', 'M-Pesa code', 'Cycle'];
    const body = rows.map((claim) => [
      claim.id, claim.submittedAt, claim.staffName, claim.submittedBy, claim.region, claim.zone,
      claim.tripDate, claim.purpose, claim.vehicle, claim.km, claim.rate, claim.amount,
      approvalOf(claim.status).label,
      claim.approvalSource === 'system' ? 'Songa (automatic)' : claim.approvalSource,
      payoutOf(claim.status)?.label || '', claim.completedAt || '', claim.completedBy || '',
      claim.mpesaCode, claim.cycleKey,
    ]);
    const csv = [header, ...body].map((line) => line.map(cell).join(',')).join('\r\n');
    // A BOM so Excel opens it as UTF-8 rather than mangling names and the Ksh symbol.
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `songa-claims-${cycle === 'all' ? 'all-cycles' : cycle}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading claims...</p></section>;

  const stage = SEGMENTS.find((item) => item.key === segment) || SEGMENTS[3];
  const unused = FILTERS_FOR(segment).filter((filter) => !active.includes(filter.key));

  return <section className="panel">
    <div className="hr-stages" role="tablist" aria-label="Claim stage">
      {SEGMENTS.map((item) => <button
        key={item.key}
        type="button"
        role="tab"
        aria-selected={segment === item.key}
        className={`hr-stage ${segment === item.key ? 'selected' : ''}`}
        onClick={() => chooseSegment(item.key)}
      >
        <StageIcon name={item.key} />
        <span>{item.label}</span>
        <b>{counts[item.key]}</b>
      </button>)}
    </div>
    <p className="hr-stage-blurb">{stage.blurb}</p>

    <div className="toolbar">
      <div className="toolbar-left">
        <label className="toolbar-field">Cycle
          <select value={cycle} onChange={(event) => setCycle(event.target.value)}>
            <option value="all">All cycles</option>
            {state.cycles.map((item) => <option key={item.key} value={item.key}>
              {item.label}{item.range ? ` · ${item.range}` : ''}{item.current ? ' (open)' : ''}
            </option>)}
          </select>
        </label>

        {active.includes('region') && <Filter label="Region" onRemove={() => removeFilter('region')}>
          <select value={region} onChange={(event) => setRegion(event.target.value)}>
            <option value="all">All regions</option>
            {state.regions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Filter>}

        {active.includes('approval') && <Filter label="Approval" onRemove={() => removeFilter('approval')}>
          <select value={approval} onChange={(event) => setApproval(event.target.value)}>
            <option value="all">Any</option>
            <option value="Pending">Pending</option>
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
          </select>
        </Filter>}

        {active.includes('payout') && <Filter label="Payout" onRemove={() => removeFilter('payout')}>
          <select value={payout} onChange={(event) => setPayout(event.target.value)}>
            <option value="all">Any</option>
            <option value="Pending">Pending</option>
            <option value="Completed">Completed</option>
          </select>
        </Filter>}

        {active.includes('dates') && <Filter label="Submitted between" onRemove={() => removeFilter('dates')}>
          <input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
          <input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
        </Filter>}
      </div>

      <div className="toolbar-right" ref={menu}>
        {unused.length > 0 && <div className="filter-menu-wrap">
          <button type="button" className="text-button add-filter" onClick={() => setAdding((value) => !value)} aria-expanded={adding}>
            <FilterIcon /> Add filter
          </button>
          {adding && <div className="filter-menu">
            {unused.map((filter) => <button key={filter.key} type="button" onClick={() => addFilter(filter.key)}>{filter.label}</button>)}
          </div>}
        </div>}
        <button type="button" className="button primary export" onClick={exportCsv} disabled={!rows.length}>
          <ExportIcon /> Export
        </button>
      </div>
    </div>

    {state.error && <p className="queue-error">{state.error}</p>}

    {chosen.length > 0 && <div className="bulk-bar">
      <span><b>{chosen.length}</b> selected {'·'} {money(chosenTotal)}</span>
      <div>
        <button type="button" className="text-button" onClick={() => setSelected(new Set())}>Clear selection</button>
        <button type="button" className="button complete" disabled={marking} onClick={() => markCompleted(chosen.map((claim) => claim.id))}>
          {marking ? 'Marking...' : `Mark ${chosen.length} as completed`}
        </button>
      </div>
    </div>}

    <p className="table-count">
      {rows.length} claim{rows.length === 1 ? '' : 's'} {'·'} {money(total)}
      {rows.length !== state.claims.length ? ` of ${state.claims.length} total` : ''}
      {selectable.length > 0 && !chosen.length && <span className="await-hint">
        {' · '}{selectable.length} awaiting payout {'—'} tick them to mark as completed
      </span>}
    </p>

    {!rows.length ? <p className="queue-empty">{emptyMessage(segment, active.length > 0, state.claims.length)}</p> : <div className="claims-table-wrap">
      <table className="claims-table">
        <thead><tr>
          <th className="tick"><TickAll
            checked={allChosen}
            partial={chosen.length > 0 && !allChosen}
            disabled={!selectable.length}
            onChange={toggleAll}
            title={selectable.length ? `Select all ${selectable.length} awaiting payout` : 'Nothing is awaiting payout'}
          /></th>
          <th>Staff</th><th>Region</th><th>Trip date</th><th className="right">Amount</th>
          <th>Reason</th><th>Submitted</th><th>Cycle</th>
          <th>Approval</th><th>Payout</th><th aria-label="Actions" />
        </tr></thead>
        <tbody>
          {rows.map((claim) => {
            const approved = approvalOf(claim.status);
            const paid = payoutOf(claim.status);
            return <tr key={claim.id} className={selected.has(claim.id) ? 'chosen' : ''}>
              <td className="tick">{canComplete(claim) && <input type="checkbox" checked={selected.has(claim.id)} onChange={() => toggle(claim.id)} aria-label={`Select ${claim.id}`} />}</td>
              <td><strong>{claim.staffName || claim.submittedBy}</strong>{claim.zone && <small>{claim.zone}</small>}</td>
              <td>{claim.region || '—'}</td>
              <td>{claim.tripDate || '—'}</td>
              <td className="right"><strong>{money(claim.amount)}</strong></td>
              <td className="reason" title={claim.purpose}>{claim.purpose || '—'}</td>
              <td>{stamp(claim.submittedAt)}</td>
              <td>{claim.cycleKey || '—'}</td>
              <td>
                <b className={`pill ${approved.tone}`}>{approved.label}</b>
                {approved.label === 'Approved' && <small className="by-line">{claim.approvalSource === 'system' ? 'automatic' : claim.approvalSource || 'manager'}</small>}
                {claim.duplicateFlag && <small className="dup-tag">possible duplicate</small>}
                {claim.reviewFlag && <small className="dup-tag">flagged</small>}
              </td>
              <td>
                {paid ? <b className={`pill ${paid.tone}`}>{paid.label}</b> : <span className="none">{'—'}</span>}
                {claim.completedAt && <small className="by-line">{stamp(claim.completedAt)}</small>}
              </td>
              <td className="right">{canComplete(claim)
                ? <button type="button" className="button complete row" disabled={marking} onClick={() => markCompleted([claim.id])}>Mark completed</button>
                : <span className="none">{'—'}</span>}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
  </section>;
}

/**
 * Select-all with a real partial state.
 *
 * Indeterminate is a DOM property rather than an attribute, so it has to be set through
 * a ref. Without it a half-selected table shows an unticked box, which reads as though
 * the selection was lost.
 */
function TickAll({ checked, partial, disabled, onChange, title }) {
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.indeterminate = partial; }, [partial]);
  return <input
    ref={box}
    type="checkbox"
    checked={checked}
    disabled={disabled}
    onChange={onChange}
    title={title}
    aria-label={title}
  />;
}

function Filter({ label, onRemove, children }) {
  return <label className="toolbar-field">{label}
    <span className="toolbar-control">
      {children}
      <button type="button" className="filter-remove" onClick={onRemove} aria-label={`Remove ${label} filter`}>×</button>
    </span>
  </label>;
}

/** One line-art glyph per stage: a clock waiting, a tick signed off, a note paid, a list. */
function StageIcon({ name }) {
  const paths = {
    pending: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
    approved: <><circle cx="12" cy="12" r="8.5" /><path d="m8.2 12.2 2.6 2.6 5-5.6" /></>,
    completed: <><rect x="3" y="6.5" width="18" height="11" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6.5 12h.01M17.5 12h.01" /></>,
    all: <path d="M4 7h16M4 12h16M4 17h10" />,
  };
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name]}
  </svg>;
}

function FilterIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 5h18M7 12h10M10 19h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}

function ExportIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/**
 * Why the table is empty, which is rarely "there is nothing".
 *
 * An empty Approved tab is good news and should read that way; an empty one because a
 * filter is applied is a different thing entirely, and saying so is what stops somebody
 * concluding the claims have gone missing.
 */
function emptyMessage(segment, filtered, total) {
  if (!total) return 'No claims have been submitted yet.';
  if (filtered) return 'No claims match these filters.';
  if (segment === 'pending') return 'Nothing is waiting on a manager. Every claim this cycle has been decided.';
  if (segment === 'approved') return 'Nothing is awaiting payout. Everything approved this cycle has been paid.';
  if (segment === 'completed') return 'Nothing has been paid out this cycle yet.';
  return 'No claims in this cycle.';
}

// Quote anything a spreadsheet would otherwise split or reinterpret.
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
