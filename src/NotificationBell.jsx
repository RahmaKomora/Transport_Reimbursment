import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * The sidebar bell: what needs this person's attention, and by when.
 *
 * The badge counts things that require action — claims to approve, a batch to pay — not
 * "unread" items. There is no read state anywhere, so a count of unread messages would be
 * invented; a count of outstanding work is true every time it is shown and disappears by
 * itself when the work is done.
 */
const POLL_MS = 60_000;

export default function NotificationBell({ onNavigate }) {
  const [alerts, setAlerts] = useState(null);
  const [open, setOpen] = useState(false);
  const panel = useRef(null);

  useEffect(() => {
    const load = () => api.alerts().then(setAlerts).catch(() => {});
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  // Clicking away or pressing Escape closes the panel, as any dropdown should.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event) => { if (panel.current && !panel.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!alerts) return null;
  const count = alerts.actionCount;

  return <div className="bell-wrap" ref={panel}>
    <button
      type="button"
      className={`bell ${count > 0 ? 'has-action' : ''}`}
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      aria-label={count > 0 ? `${count} items need your attention` : 'Notifications'}
    >
      <BellIcon />
      <span>Notifications</span>
      {count > 0 && <b className="bell-count">{count > 9 ? '9+' : count}</b>}
    </button>

    {open && <div className="bell-panel">
      <div className="bell-head">
        <strong>{alerts.cycle.label}</strong>
        <small>{alerts.cycle.range} {'·'} closes {alerts.cycle.phrase}</small>
      </div>
      {alerts.items.map((item) => {
        const clickable = Boolean(item.view);
        const Tag = clickable ? 'button' : 'div';
        return <Tag
          key={item.id}
          {...(clickable ? { type: 'button', onClick: () => { setOpen(false); onNavigate(item.view, item.status); } } : {})}
          className={`bell-item tone-${item.tone} ${clickable ? 'clickable' : ''}`}
        >
          <strong>{item.title}</strong>
          <small>{item.body}</small>
        </Tag>;
      })}
    </div>}
  </div>;
}

function BellIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.2 7.5-2.2 7.5h16.4S18 14.5 18 8.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M13.7 19.5a2 2 0 0 1-3.4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>;
}
