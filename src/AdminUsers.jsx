import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

/**
 * User roles, as Songa has understood them.
 *
 * This deliberately shows the interpretation next to the source: the role chip is what
 * the app decided, and the grey text beneath is the job title it read. The two drifting
 * apart is not hypothetical — a job title that did not read as a manager left an approver
 * unable to open their own queue, and it stayed invisible until someone went looking.
 */
// A job title and the access it grants are different facts, so they get different
// columns. "Zone Supervisor" is what HR calls the person; ke_asili_approver is what Songa
// lets them do. Showing only one of the two is how a title that failed to parse left an
// approver unable to open their own queue.
const ROLE_LABEL = { field_agent: 'Requester', manager: 'Approver', hr: 'HR', admin: 'Admin' };
const ROLE_TONE = { field_agent: 'gray', manager: 'blue', hr: 'green', admin: 'orange' };
const FILTERS = [
  { key: 'region', label: 'Region' },
  { key: 'jobTitle', label: 'Job title' },
  { key: 'systemRole', label: 'System role' },
  { key: 'status', label: 'Status' },
];

const TABS = [
  { key: 'all', label: 'Everyone' },
  { key: 'field_agent', label: 'ke_asili_requester' },
  { key: 'manager', label: 'ke_asili_approver' },
  { key: 'hr', label: 'ke_asili_hr' },
  { key: 'admin', label: 'ke_asili_admin' },
];

export default function AdminUsers({ money }) {
  const [state, setState] = useState({ loading: true, people: [], regions: [], counts: {}, sync: null, error: '' });
  const [region, setRegion] = useState('all');
  const [role, setRole] = useState('all');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [confirming, setConfirming] = useState(false);
  const [activeFilters, setActiveFilters] = useState([]);
  const [addingFilter, setAddingFilter] = useState(false);
  const [jobTitle, setJobTitle] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const filterMenu = useRef(null);
  const [perPage, setPerPage] = useState(25);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);
  const panel = useRef(null);

  const load = () => api.adminUsers()
    .then((data) => setState({ loading: false, ...data, error: '' }))
    .catch((error) => setState((current) => ({ ...current, loading: false, error: error.message })));

  useEffect(() => {
    api.adminUsers()
      .then((data) => setState({ loading: false, ...data, error: '' }))
      .catch((error) => setState((current) => ({ ...current, loading: false, error: error.message })));
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const dropFilter = (key) => {
    setActiveFilters((current) => current.filter((item) => item !== key));
    if (key === 'region') setRegion('all');
    if (key === 'jobTitle') setJobTitle('all');
    if (key === 'status') setStatusFilter('all');
  };

  const jobTitles = useMemo(
    () => [...new Set(state.people.map((person) => person.roleLabel).filter(Boolean))].sort(),
    [state.people],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.people.filter((person) => {
      if (activeFilters.includes('region') && region !== 'all' && person.region !== region) return false;
      if (role !== 'all' && person.role !== role) return false;
      if (activeFilters.includes('jobTitle') && jobTitle !== 'all' && (person.roleLabel || '') !== jobTitle) return false;
      if (activeFilters.includes('status') && statusFilter !== 'all') {
        const isActive = person.source === 'approver' ? null : person.active;
        if (statusFilter === 'active' && isActive !== true) return false;
        if (statusFilter === 'inactive' && isActive !== false) return false;
      }
      if (needle && !`${person.name} ${person.email} ${person.zone} ${person.roleLabel}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [state.people, region, role, query, activeFilters, jobTitle, statusFilter]);

  useEffect(() => { setPage(1); }, [region, role, query, perPage, activeFilters, jobTitle, statusFilter]);

  // 1,400 rows in one table is slow to render and impossible to read. The filters and
  // search narrow it; pagination handles whatever is left.
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * perPage, current * perPage);

  // Only people with a row of their own can be deleted; an approver named in the manager
  // columns has nothing to remove.
  const deletable = rows.filter((person) => person.source !== 'approver');
  const chosen = deletable.filter((person) => selected.has(person.email));
  const pageChosen = shown.filter((person) => person.source !== 'approver' && selected.has(person.email));
  const pageDeletable = shown.filter((person) => person.source !== 'approver');
  const allOnPage = pageDeletable.length > 0 && pageChosen.length === pageDeletable.length;

  // Neither action applies to somebody already in that state, so the counts drive both
  // the labels and whether the button is worth showing at all.
  const toActivate = chosen.filter((person) => person.active === false).length;
  const toDeactivate = chosen.filter((person) => person.active !== false).length;

  const toggle = (email) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(email)) next.delete(email); else next.add(email);
    return next;
  });
  const togglePage = () => setSelected((current) => {
    const next = new Set(current);
    if (allOnPage) pageDeletable.forEach((person) => next.delete(person.email));
    else pageDeletable.forEach((person) => next.add(person.email));
    return next;
  });

  const remove = async (force = false) => {
    setBusy('deleting');
    try {
      const result = await api.deleteUsers(chosen.map((person) => person.email), force);
      setSelected(new Set());
      setConfirming(false);
      if (result.skipped?.length) {
        setState((current) => ({ ...current, error: `${result.deleted} deleted. ${result.skipped.length} kept: ${result.skipped[0].reason}` }));
      }
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setBusy('');
    }
  };

  /**
   * Switching a whole selection on or off in one request.
   *
   * One request rather than one per person, so the "leave at least one HR or admin able
   * to sign in" rule is checked against the entire selection. Done one at a time, each
   * call only knows about itself and the last account can slip out halfway through.
   */
  const setBulkStatus = async (active, { closeDialog = false } = {}) => {
    setBusy(active ? 'activating' : 'deactivating');
    try {
      const result = await api.setUserStatusBulk(chosen.map((person) => person.email), active);
      setSelected(new Set());
      if (closeDialog) setConfirming(false);
      const blocked = (result.skipped || []).filter((item) => !/^Already /.test(item.reason));
      setState((current) => ({
        ...current,
        error: blocked.length ? `${result.changed} changed. ${blocked.length} skipped: ${blocked[0].reason}` : '',
      }));
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setBusy('');
    }
  };
  const deactivate = () => setBulkStatus(false, { closeDialog: true });
  const firstRow = rows.length ? (current - 1) * perPage + 1 : 0;

  const setStatus = async (person, active) => {
    setBusy(person.email);
    try {
      await api.setUserStatus(person.email, active);
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setBusy('');
    }
  };

  const exportCsv = () => {
    const header = ['Name', 'Email', 'Role', 'Job title', 'Region', 'Zone', 'Approver 1', 'Approver 1 email', 'Approver 2', 'Approver 2 email', 'Monthly', 'Per cycle', 'Top-up', 'Maximum', 'Account source'];
    const body = rows.map((p) => [
      p.name, p.email, ROLE_LABEL[p.role] || p.role, p.roleLabel, p.region, p.zone,
      p.manager1Name, p.manager1Email, p.manager2Name, p.manager2Email,
      p.transportMonth, p.transportPerCycle, p.extraAllowancePerCycle, p.maxPerCycle,
      p.source !== 'approver' ? 'Staff' : 'Named as approver',
    ]);
    const csv = [header, ...body].map((line) => line.map(cell).join(',')).join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `songa-user-roles-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (state.loading) return <section className="panel"><p className="queue-empty">Loading the directory...</p></section>;
  if (state.error) return <section className="panel"><p className="queue-error">{state.error}</p></section>;

  const noApprover = state.people.filter((p) => p.source !== 'approver' && !p.manager1Email && !p.manager2Email);
  const noBudget = state.people.filter((p) => p.source !== 'approver' && !p.transportPerCycle);

  return <>
    <section className="page-heading"><div>
      <span className="kicker">Admin</span>
      <h1>User roles</h1>
      <p>Who can do what in Songa. This is the staff list the app runs on.</p>
    </div></section>

    <section className="stats role-stats">
      {['field_agent', 'manager', 'hr', 'admin'].map((key) => (
        <div className="stat" key={key}>
          <span>{ROLE_LABEL[key]}s</span>
          <strong>{state.counts[key] || 0}</strong>
          <small>{key === 'field_agent' ? 'submit claims' : key === 'manager' ? 'approve claims' : key === 'hr' ? 'complete payouts' : 'full access'}</small>
        </div>
      ))}
    </section>

    {(noApprover.length > 0 || !state.counts.admin) && <div className="admin-warnings">
      {!state.counts.admin && <p><b>Nobody holds the Admin role.</b> Give whoever looks after the staff list the job title &ldquo;Admin&rdquo;, and this page can be narrowed to them.</p>}
      {noApprover.length > 0 && <p><b>{noApprover.length} {noApprover.length === 1 ? 'person has' : 'people have'} no approver.</b> Claims above their allowance escalate straight to HR: {noApprover.map((p) => p.name || p.email).join(', ')}.</p>}
      {noBudget.length > 0 && <p><b>{noBudget.length} {noBudget.length === 1 ? 'has' : 'have'} no cycle allowance.</b> Nothing they submit can be approved automatically.</p>}
    </div>}

    <section className="panel">
      <div className="toolbar">
        <div className="toolbar-left">
          {activeFilters.includes('region') && <Filter label="Region" onRemove={() => dropFilter('region')}>
            <select value={region} onChange={(event) => setRegion(event.target.value)}>
              <option value="all">All regions</option>
              {state.regions.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Filter>}

          {activeFilters.includes('jobTitle') && <Filter label="Job title" onRemove={() => dropFilter('jobTitle')}>
            <select value={jobTitle} onChange={(event) => setJobTitle(event.target.value)}>
              <option value="all">Any job title</option>
              {jobTitles.map((title) => <option key={title} value={title}>{title}</option>)}
            </select>
          </Filter>}

          {activeFilters.includes('systemRole') && <Filter label="System role" onRemove={() => { dropFilter('systemRole'); setRole('all'); }}>
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="all">Any system role</option>
              {Object.entries(ROLE_LABEL).map(([key]) => <option key={key} value={key}>{SYSTEM_ROLE[key]}</option>)}
            </select>
          </Filter>}

          {activeFilters.includes('status') && <Filter label="Status" onRemove={() => dropFilter('status')}>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">Any status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Filter>}
        </div>
        <div className="toolbar-right" ref={filterMenu}>
          <div className="filter-menu-wrap">
            <button type="button" className="text-button add-filter" onClick={() => setAddingFilter((value) => !value)} aria-expanded={addingFilter}>
              <FilterIcon /> Filter
            </button>
            {addingFilter && <div className="filter-menu">
              {FILTERS.filter((item) => !activeFilters.includes(item.key)).map((item) => (
                <button key={item.key} type="button" onClick={() => { setActiveFilters((c) => [...c, item.key]); setAddingFilter(false); }}>{item.label}</button>
              ))}
              {activeFilters.length === FILTERS.length && <span className="filter-menu-empty">All filters added</span>}
            </div>}
          </div>
          <button type="button" className="button outline" onClick={() => setAdding(true)}>+ Add user</button>
          <button type="button" className="button primary export" onClick={exportCsv} disabled={!rows.length}>Export</button>
        </div>
      </div>

      {chosen.length > 0 && <div className="select-bar">
        <button type="button" className="select-close" onClick={() => setSelected(new Set())} aria-label="Clear selection">×</button>
        <span><b>{chosen.length}</b> selected</span>
        {chosen.length < deletable.length && <button type="button" className="text-button" onClick={() => setSelected(new Set(deletable.map((p) => p.email)))}>
          Select all {deletable.length}
        </button>}
        {/* Each action says how many of the selection it would actually touch, because a
            mixed selection is normal and "Activate" over 40 people of whom 3 are inactive
            should not imply it is about to change 40. */}
        {toActivate > 0 && <button type="button" className="button outline small" disabled={Boolean(busy)} onClick={() => setBulkStatus(true)}>
          {busy === 'activating' ? 'Activating...' : `Activate ${toActivate}`}
        </button>}
        {toDeactivate > 0 && <button type="button" className="button outline small" disabled={Boolean(busy)} onClick={() => setBulkStatus(false)}>
          {busy === 'deactivating' ? 'Deactivating...' : `Deactivate ${toDeactivate}`}
        </button>}
        <button type="button" className="danger-button" disabled={Boolean(busy)} onClick={() => setConfirming(true)}>
          {busy === 'deleting' ? 'Deleting...' : 'Delete'}
        </button>
      </div>}

      <div className="people-search">
        <SearchIcon />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, email, zone or job title"
          aria-label="Search people"
        />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
      </div>

      <div className="status-tabs" role="tablist">
        {TABS.map((tab) => {
          const count = tab.key === 'all' ? state.people.length : (state.counts[tab.key] || 0);
          return <button key={tab.key} type="button" role="tab" aria-selected={role === tab.key}
            className={`status-tab ${role === tab.key ? 'selected' : ''}`} onClick={() => setRole(tab.key)}>
            {tab.label}<b>{count}</b>
          </button>;
        })}
      </div>

      <p className="table-count">Showing {firstRow}–{Math.min(current * perPage, rows.length)} of {rows.length}{rows.length !== state.people.length ? ` matching, ${state.people.length} in total` : ' people'}</p>

      {!rows.length ? <p className="queue-empty">Nobody matches those filters.</p> : <div className="claims-table-wrap">
        <table className="claims-table roles-table people-table">
          <colgroup>
            <col style={{ width: '3%' }} />
            <col style={{ width: '20%' }} /><col style={{ width: '12%' }} />
            <col style={{ width: '14%' }} /><col style={{ width: '15%' }} />
            <col style={{ width: '21%' }} /><col style={{ width: '8%' }} />
            <col style={{ width: '4%' }} />
          </colgroup>
          <thead><tr>
            <th className="tick"><input type="checkbox" checked={allOnPage} onChange={togglePage} disabled={!pageDeletable.length} aria-label="Select everyone on this page" /></th>
            <th>Person</th><th>Region &amp; zone</th>
            <th>Job title</th><th>System role</th>
            <th>Approvers</th><th>Status</th><th />
          </tr></thead>
          <tbody>
            {shown.map((person) => <tr key={person.email} className={selected.has(person.email) ? 'chosen' : ''}>
              <td className="tick">{person.source !== 'approver' && <input type="checkbox" checked={selected.has(person.email)} onChange={() => toggle(person.email)} aria-label={`Select ${person.email}`} />}</td>
              <td>
                <strong>{person.name || person.email.split('@')[0]}</strong>
                <small className="email-cell">{person.email}</small>
              </td>
              <td>
                {person.region || <span className="none">{'—'}</span>}
                {person.zone && <small>{person.zone}</small>}
              </td>
              <td className="quiet">{person.roleLabel
                ? person.roleLabel
                : <span className="none">{person.source === 'approver' ? 'named as approver' : '—'}</span>}</td>
              {/* A dot marks a role an admin set rather than one read from the job title,
                  so the next person to look knows the title is not the thing to fix. */}
              <td>
                <b className={`pill ${ROLE_TONE[person.role]}`}>{person.systemRole || ROLE_LABEL[person.role]}</b>
                {person.roleSource === 'manual' && <small className="role-set" title="Set by an admin, not read from the job title">set manually</small>}
              </td>
              <td>
                {person.manager1Email || person.manager2Email ? <>
                  {person.manager1Email && <div className="approver">
                    <strong>{person.manager1Name || person.manager1Email.split('@')[0]}</strong>
                    <small>{person.manager1Email}</small>
                  </div>}
                  {person.manager2Email && <div className="approver second">
                    <strong>{person.manager2Name || person.manager2Email.split('@')[0]}</strong>
                    <small>{person.manager2Email}</small>
                  </div>}
                </> : <span className="none">{'—'}</span>}
              </td>
              <td>{person.source === 'approver'
                ? <span className="none" title="No row of their own to deactivate">{'—'}</span>
                : <button type="button" className={`status-toggle ${person.active ? 'on' : 'off'}`} disabled={busy === person.email}
                    onClick={() => setStatus(person, !person.active)}>
                    {busy === person.email ? '...' : person.active ? 'Active' : 'Inactive'}
                  </button>}</td>
              <td className="right"><button type="button" className="row-open" onClick={() => setOpen(person)} aria-label={`Open ${person.name || person.email}`}>{'→'}</button></td>
            </tr>)}
          </tbody>
        </table>
      </div>}

      {pages > 1 && <div className="pager">
        <label>Per page
          <select value={perPage} onChange={(event) => setPerPage(Number(event.target.value))}>
            {[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <div className="pager-buttons">
          <button type="button" onClick={() => setPage(1)} disabled={current === 1}>{'«'}</button>
          <button type="button" onClick={() => setPage(current - 1)} disabled={current === 1}>Previous</button>
          <span>Page {current} of {pages}</span>
          <button type="button" onClick={() => setPage(current + 1)} disabled={current === pages}>Next</button>
          <button type="button" onClick={() => setPage(pages)} disabled={current === pages}>{'»'}</button>
        </div>
      </div>}

      <p className="table-footnote">
        Roles, approvers and allowances live in Songa now, edited here rather than in a
        spreadsheet. A change takes effect within a minute, without anybody signing out.
      </p>
    </section>

    {open && <PersonDetail person={open} money={money} people={state.people} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); load(); }} />}
    {confirming && <ConfirmDelete
      people={chosen}
      busy={busy === 'deleting'}
      onCancel={() => setConfirming(false)}
      onConfirm={() => remove(true)}
      onDeactivate={deactivate}
    />}
    {adding && <AddUser regions={state.regions} people={state.people} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />}
  </>;
}

/**
 * One person's record, editable in place.
 *
 * The email is shown but not editable: it is how a claim knows whose it is, so changing
 * it would orphan their history. Everything else an admin corrects here.
 */
function PersonDetail({ person, money, people, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const editable = person.source !== 'approver';
  const set = (field, value) => { setError(''); setForm((current) => ({ ...(current || base(person)), [field]: value })); };
  const draft = form || base(person);
  const dirty = form !== null;
  const approvers = people.filter((item) => item.isApprover && item.email !== person.email);
  const willBe = ROLE_FROM_TITLE(draft.roleLabel);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.updateUser(person.email, draft);
      onSaved();
    } catch (caught) {
      setError(caught.message);
      setSaving(false);
    }
  };

  return <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
    <div className="drawer" onClick={(event) => event.stopPropagation()}>
      <div className="drawer-head">
        <div>
          <span className="kicker">{SYSTEM_ROLE[person.role] || person.role}</span>
          <h2>{person.name || person.email}</h2>
        </div>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <p className="drawer-email">{person.email}</p>

      {!editable && <p className="drawer-note">
        This account exists only because other people name them as their approver, so there is
        nothing of their own to edit. Add them to the directory to give them a record, an
        allowance and details you can change here.
      </p>}

      {editable && <>
        <label>Full name<input value={draft.name} onChange={(event) => set('name', event.target.value)} /></label>

        <div className="form-pair">
          <label>Region<input value={draft.region} onChange={(event) => set('region', event.target.value)} placeholder="Rift" /></label>
          <label>Zone<input value={draft.zone} onChange={(event) => set('zone', event.target.value)} /></label>
        </div>

        <label>Job title<input value={draft.roleLabel} onChange={(event) => set('roleLabel', event.target.value)} /></label>

        <RolePicker
          jobTitle={draft.roleLabel}
          value={draft.roleOverride}
          onChange={(value) => set('roleOverride', value)}
        />

        <div className="form-pair">
          <label>Approver 1
            <select value={draft.manager1Email} onChange={(event) => set('manager1Email', event.target.value)}>
              <option value="">None</option>
              {approvers.map((item) => <option key={item.email} value={item.email}>{item.name || item.email}</option>)}
            </select>
          </label>
          <label>Approver 2
            <select value={draft.manager2Email} onChange={(event) => set('manager2Email', event.target.value)}>
              <option value="">None</option>
              {approvers.map((item) => <option key={item.email} value={item.email}>{item.name || item.email}</option>)}
            </select>
          </label>
        </div>

        <div className="form-pair">
          <label>Monthly<input type="number" min="0" value={draft.transportMonth} onChange={(event) => set('transportMonth', event.target.value)} /></label>
          <label>Per cycle<input type="number" min="0" value={draft.transportPerCycle} onChange={(event) => set('transportPerCycle', event.target.value)} /></label>
        </div>
        <div className="form-pair">
          <label>Top-up<input type="number" min="0" value={draft.extraAllowancePerCycle} onChange={(event) => set('extraAllowancePerCycle', event.target.value)} /></label>
          <label>Maximum<input type="number" min="0" value={draft.maxPerCycle} onChange={(event) => set('maxPerCycle', event.target.value)} /></label>
        </div>

        {!draft.manager1Email && !draft.manager2Email && <p className="drawer-note">
          With no approver, anything above their allowance cannot be approved by anyone but a
          manager covering their region.
        </p>}

        {error && <p className="queue-error">{error}</p>}

        <div className="drawer-actions">
          <button type="button" className="button outline" onClick={onClose}>Close</button>
          <button type="button" className="button primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving...' : dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </>}

      <div className="drawer-log">
        <h3>What they can do</h3>
        <p>{person.role === 'field_agent' && 'Submit claims and see their own history.'}
          {person.role === 'manager' && 'Approve and reject claims, and see team budgets.'}
          {person.role === 'hr' && 'See every claim and mark payouts completed. Approvals are made by managers.'}
          {person.role === 'admin' && 'Everything.'}</p>
        {person.isApprover && person.approvesFor.length > 0 && <p>
          <b>Approves for {person.approvesFor.length} {person.approvesFor.length === 1 ? 'person' : 'people'}</b>
          <small>{person.approvesFor.join(', ')}</small>
        </p>}
        {person.regionsCovered.length > 0 && <p><b>Sees claims from</b><small>{person.regionsCovered.join(', ')}</small></p>}
        {/* Shown because it is what decides whether this person can be deleted or should
            only be deactivated, and an admin should know that before they try. */}
        {editable && <p>
          <b>{person.claims || 'No'} {person.claims === 1 ? 'claim' : 'claims'} filed</b>
          <small>{person.claims
            ? 'Deactivate rather than delete if they have left — the claims stay either way, but deleting loses the record behind them.'
            : 'Nothing is attached to this account, so it can be deleted cleanly.'}</small>
        </p>}
      </div>
    </div>
  </div>;
}

function base(person) {
  return {
    name: person.name || '',
    region: person.region || '',
    zone: person.zone || '',
    roleLabel: person.roleLabel || '',
    manager1Email: person.manager1Email || '',
    manager2Email: person.manager2Email || '',
    transportMonth: person.transportMonth || '',
    transportPerCycle: person.transportPerCycle || '',
    extraAllowancePerCycle: person.extraAllowancePerCycle || '',
    maxPerCycle: person.maxPerCycle || '',
    roleOverride: person.roleOverride || '',
  };
}

function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Adds somebody to the directory.
 *
 * The job title is free text, as HR writes it, so the form shows what
 * access the title will actually grant as it is typed. Discovering that "Coordinator"
 * produced a requester rather than an approver after the fact is precisely the mistake
 * this screen exists to prevent.
 */
const ROLE_FROM_TITLE = (title = '') => {
  const value = title.toLowerCase();
  if (value.includes('admin')) return 'admin';
  if (value.includes('hr') || value.includes('people')) return 'hr';
  if (value.includes('manager') || value.includes('lead') || value.includes('supervisor')) return 'manager';
  return 'field_agent';
};
const SYSTEM_ROLE = { field_agent: 'ke_asili_requester', manager: 'ke_asili_approver', hr: 'ke_asili_hr', admin: 'ke_asili_admin' };
const ROLE_ORDER = ['field_agent', 'manager', 'hr', 'admin'];

/**
 * The system role, read from the job title unless an admin says otherwise.
 *
 * Reading it from the title is what keeps 1,400 people working without anyone assigning
 * roles by hand, and it is right almost always. It is wrong the moment HR invents a title
 * Songa has never seen: that falls through to requester, so a new "Zone Coordinator"
 * silently cannot approve anything and nothing on screen explains why.
 *
 * So the automatic answer stays the default and is shown as such — including what it
 * currently works out to, so choosing "leave it" is an informed choice rather than a
 * blank. Overriding is one selection, and the override is visibly an override, because
 * the next admin needs to know the title is no longer the thing to fix.
 */
function RolePicker({ jobTitle, value, onChange }) {
  const derived = ROLE_FROM_TITLE(jobTitle);
  const effective = value || derived;
  const overridden = Boolean(value);

  return <div className="role-picker">
    <label>System role
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Automatic {'—'} {SYSTEM_ROLE[derived]}</option>
        {ROLE_ORDER.map((role) => <option key={role} value={role}>{SYSTEM_ROLE[role]} ({ROLE_LABEL[role]})</option>)}
      </select>
    </label>
    <p className="role-preview">
      Grants <b className={`pill ${ROLE_TONE[effective]}`}>{SYSTEM_ROLE[effective]}</b>
      {overridden
        ? <span className="role-note">set by an admin, so the job title no longer decides</span>
        : <span className="role-note">read from the job title</span>}
    </p>
  </div>;
}

function AddUser({ regions, people, onClose, onAdded }) {
  const [form, setForm] = useState({
    name: '', email: '', region: '', zone: '', jobTitle: '',
    manager1Email: '', manager2Email: '',
    transportMonth: '', transportPerCycle: '', extraAllowancePerCycle: '', maxPerCycle: '',
    roleOverride: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const role = form.roleOverride || ROLE_FROM_TITLE(form.jobTitle);
  const approvers = people.filter((person) => person.isApprover);
  const ready = form.name.trim() && form.email.includes('@');

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const named = (email) => approvers.find((person) => person.email === email)?.name || '';
      await api.addUser({
        ...form,
        email: form.email.trim().toLowerCase(),
        manager1Name: named(form.manager1Email),
        manager2Name: named(form.manager2Email),
      });
      onAdded();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSaving(false);
    }
  };

  return <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
    <form className="drawer" onClick={(event) => event.stopPropagation()} onSubmit={save}>
      <div className="drawer-head">
        <div><span className="kicker">Admin</span><h2>Add a user</h2></div>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <label>Full name<input required value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="Jane Wanjiku" /></label>
      <label>Work email<input required type="email" value={form.email} onChange={(event) => set('email', event.target.value)} placeholder="jane.wanjiku@oneacrefund.org" /></label>

      <div className="form-pair">
        <label>Region
          <input list="admin-regions" value={form.region} onChange={(event) => set('region', event.target.value)} placeholder="Rift Valley" />
          <datalist id="admin-regions">{regions.map((name) => <option key={name} value={name} />)}</datalist>
        </label>
        <label>Zone<input value={form.zone} onChange={(event) => set('zone', event.target.value)} placeholder="Dzitsoni Zone" /></label>
      </div>

      <label>Job title<input value={form.jobTitle} onChange={(event) => set('jobTitle', event.target.value)} placeholder="Tupande Agent" /></label>

      <RolePicker jobTitle={form.jobTitle} value={form.roleOverride} onChange={(value) => set('roleOverride', value)} />
      <p className="role-preview">
        {role === 'field_agent' && 'A requester can submit claims only.'}
        {role === 'manager' && 'An approver can approve and reject claims.'}
        {role === 'hr' && 'HR can see every claim and complete payouts.'}
        {role === 'admin' && 'An admin has full access, including this page.'}
      </p>

      <div className="form-pair">
        <label>Approver 1
          <select value={form.manager1Email} onChange={(event) => set('manager1Email', event.target.value)}>
            <option value="">None</option>
            {approvers.map((person) => <option key={person.email} value={person.email}>{person.name || person.email}</option>)}
          </select>
        </label>
        <label>Approver 2
          <select value={form.manager2Email} onChange={(event) => set('manager2Email', event.target.value)}>
            <option value="">None</option>
            {approvers.map((person) => <option key={person.email} value={person.email}>{person.name || person.email}</option>)}
          </select>
        </label>
      </div>

      <div className="form-pair">
        <label>Monthly<input type="number" min="0" value={form.transportMonth} onChange={(event) => set('transportMonth', event.target.value)} placeholder="15000" /></label>
        <label>Per cycle<input type="number" min="0" value={form.transportPerCycle} onChange={(event) => set('transportPerCycle', event.target.value)} placeholder="7500" /></label>
      </div>
      <div className="form-pair">
        <label>Top-up<input type="number" min="0" value={form.extraAllowancePerCycle} onChange={(event) => set('extraAllowancePerCycle', event.target.value)} placeholder="3000" /></label>
        <label>Maximum<input type="number" min="0" value={form.maxPerCycle} onChange={(event) => set('maxPerCycle', event.target.value)} placeholder="10500" /></label>
      </div>

      {!form.transportPerCycle && <p className="drawer-note">Without a per-cycle allowance nothing they submit can be approved automatically. Leave it blank only for approvers and HR, who do not claim.</p>}
      {error && <p className="queue-error">{error}</p>}

      <div className="drawer-actions">
        <button type="button" className="button outline" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={!ready || saving}>{saving ? 'Adding...' : 'Add person'}</button>
      </div>
    </form>
  </div>;
}

function SearchIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
    <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}

/**
 * Confirms a deletion before it happens.
 *
 * Deleting a person removes their row for good, so the dialog names who is going and says
 * plainly that deactivating is the reversible alternative. Anyone who has claimed is
 * refused by the server regardless — their email is what ties those claims to a person.
 */
/**
 * Removing people, with the two answers the situation actually has.
 *
 * Somebody who has left the company is the common case, and for them deactivating is the
 * better one: their access closes, and they stay attached to the claims they filed.
 * Deleting is for records that should never have existed — a duplicate, a wrong address.
 *
 * So both are offered here, with deactivating first, and the consequence of each spelled
 * out against the number of claims involved rather than in the abstract.
 */
function ConfirmDelete({ people, busy, onCancel, onConfirm, onDeactivate }) {
  const many = people.length > 1;
  const claimed = people.filter((person) => person.claims > 0);
  const totalClaims = claimed.reduce((sum, person) => sum + person.claims, 0);

  return <div className="drawer-backdrop centred" role="dialog" aria-modal="true" onClick={onCancel}>
    <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
      <h2>Remove {people.length} {many ? 'people' : 'person'}?</h2>

      {claimed.length > 0
        ? <p>
            {claimed.length === people.length ? 'They have' : `${claimed.length} of them have`}
            {' '}filed {totalClaims} {totalClaims === 1 ? 'claim' : 'claims'}.
            {totalClaims === 1
              ? ' That claim stays in Songa either way — it keeps the name, region and amount it was filed with —'
              : ' Those claims stay in Songa either way — each one keeps the name, region and amount it was filed with —'}
            {' '}but deleting leaves nothing in the directory to look the person up in.
          </p>
        : <p>
            {many ? 'None of them have' : 'They have'} filed any claims, so there is nothing to
            detach. Deleting removes {many ? 'them' : 'them'} outright.
          </p>}

      <ul className="confirm-list">
        {people.slice(0, 8).map((person) => <li key={person.email}>
          <strong>{person.name || person.email}</strong>
          <small>{person.email}{person.claims > 0 && ` · ${person.claims} ${person.claims === 1 ? 'claim' : 'claims'}`}</small>
        </li>)}
        {people.length > 8 && <li className="more">and {people.length - 8} more</li>}
      </ul>

      {claimed.length > 0 && <p className="confirm-hint">
        If {many ? 'they have' : 'they have'} left the company, deactivating is the one you want.
      </p>}

      <div className="drawer-actions">
        <button type="button" className="button outline" onClick={onCancel}>Cancel</button>
        {claimed.length > 0 && <button type="button" className="button primary" disabled={busy} onClick={onDeactivate}>
          {busy ? 'Working...' : 'Deactivate instead'}
        </button>}
        <button type="button" className="danger-button solid" disabled={busy} onClick={onConfirm}>
          {busy ? 'Deleting...' : `Delete ${people.length}`}
        </button>
      </div>
    </div>
  </div>;
}

function Filter({ label, onRemove, children }) {
  return <label className="toolbar-field">{label}
    <span className="toolbar-control">
      {children}
      <button type="button" className="filter-remove" onClick={onRemove} aria-label={`Remove ${label} filter`}>×</button>
    </span>
  </label>;
}

function FilterIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 5h18M7 12h10M10 19h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}
