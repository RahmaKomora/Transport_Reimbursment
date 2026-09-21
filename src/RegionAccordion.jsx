import { useState } from 'react';

// Shared by every queue that is read region by region: the manager review list and both
// HR tabs. Takes pre-grouped regions from the API so the grouping rule lives on the
// server, next to the data, rather than being re-derived in each view.
export default function RegionAccordion({ regions, money, emptyMessage, renderClaim, defaultOpen = 1 }) {
  const [open, setOpen] = useState(() => new Set(regions.slice(0, defaultOpen).map((region) => region.region)));
  const [filter, setFilter] = useState('All regions');

  if (!regions.length) return <p className="queue-empty">{emptyMessage}</p>;

  const toggle = (name) => setOpen((current) => {
    const next = new Set(current);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  const visible = filter === 'All regions' ? regions : regions.filter((region) => region.region === filter);

  return <>
    <div className="region-tabs" role="tablist">
      {['All regions', ...regions.map((region) => region.region)].map((name) => <button
        key={name}
        type="button"
        role="tab"
        aria-selected={filter === name}
        className={filter === name ? 'selected' : ''}
        onClick={() => setFilter(name)}
      >{name}{name !== 'All regions' && <b>{regions.find((region) => region.region === name).claims.length}</b>}</button>)}
    </div>
    {visible.map((region) => {
      const expanded = open.has(region.region);
      return <section className="region-group" key={region.region}>
        <button type="button" className="region-head" onClick={() => toggle(region.region)} aria-expanded={expanded}>
          <span className="region-name">{region.region}</span>
          <span className="region-meta">{region.claims.length} {region.claims.length === 1 ? 'claim' : 'claims'} · {money(region.total)}</span>
          <b aria-hidden="true">{expanded ? '⌃' : '⌄'}</b>
        </button>
        {expanded && <div className="region-body">{region.claims.map(renderClaim)}</div>}
      </section>;
    })}
  </>;
}
