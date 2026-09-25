import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * How many people Songa is working from, and a way to reload them.
 *
 * Roles, budgets and manager assignments are read on every request anyway, off a cache
 * that ages out in a minute. This is for the moment after an admin edit when somebody
 * wants to see the change land now, and for the counts, which are the quickest way to
 * spot that a region has lost its people.
 */
export default function DirectoryStatus({ onSynced }) {
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.configStatus().then(setStatus).catch(() => {}); }, []);

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await api.reloadDirectory();
      setResult(data);
      setStatus({ sync: { syncedAt: data.syncedAt, userCount: data.userCount } });
      onSynced?.(data);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const loadedAt = result?.syncedAt || status?.sync?.syncedAt;
  const count = result?.userCount ?? status?.sync?.userCount;

  return <section className="sheet-sync">
    <div className="sheet-sync-main">
      <span className="kicker">Staff directory</span>
      <strong>{count != null ? `${count.toLocaleString('en-GB')} people` : 'Loading...'}</strong>
      <small>
        {loadedAt
          ? `Last loaded ${new Date(loadedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
          : 'Not loaded yet'}
      </small>
    </div>
    <button type="button" className="button outline" onClick={refresh} disabled={busy}>{busy ? 'Reloading...' : 'Reload directory'}</button>

    {error && <p className="queue-error sheet-sync-wide">{error}</p>}

    {result?.ok && <div className="sheet-sync-wide sync-result">
      <p>Reloaded {result.userCount} staff in {result.durationMs} ms — {Object.entries(result.roles).map(([role, count]) => `${count} ${role.replace('_', ' ')}`).join(', ')}.</p>
      <p className="sync-regions">{Object.entries(result.regions).map(([region, people]) => <span key={region}>{region} <b>{people}</b></span>)}</p>
      {result.warnings?.map((warning) => <p className="sync-warning" key={warning.issue}>{warning.issue}: {warning.emails.join(', ')}</p>)}
    </div>}
  </section>;
}
