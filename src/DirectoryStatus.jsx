import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Forces a re-read of the staff sheet. Roles, budgets and manager assignments are read
 * from the sheet on every request anyway, but on a cache that ages out — this is for when
 * someone has just edited the sheet and wants the change to land now.
 */
export default function SheetSync({ onSynced }) {
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.configStatus().then(setStatus).catch(() => {}); }, []);

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await api.refreshSheet();
      setResult(data);
      setStatus({ sync: { syncedAt: data.syncedAt, userCount: data.userCount }, sheets: data.source === 'google-sheet' ? 'connected' : 'not configured' });
      onSynced?.(data);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const syncedAt = result?.syncedAt || status?.sync?.syncedAt;

  return <section className="sheet-sync">
    <div className="sheet-sync-main">
      <span className="kicker">Staff sheet</span>
      <strong>{status?.sheets === 'connected' ? 'Connected to Google Sheets' : 'Not connected'}</strong>
      <small>
        {syncedAt ? `Last synced ${new Date(syncedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not synced yet'}
        {result?.userCount != null && ` · ${result.userCount} staff`}
        {status?.sync?.userCount != null && result?.userCount == null && ` · ${status.sync.userCount} staff`}
      </small>
    </div>
    <button type="button" className="button outline" onClick={refresh} disabled={busy}>{busy ? 'Syncing...' : 'Refresh Sheet Data'}</button>

    {error && <p className="queue-error sheet-sync-wide">{error}</p>}

    {result?.ok && <div className="sheet-sync-wide sync-result">
      <p>Synced {result.userCount} staff in {result.durationMs} ms — {Object.entries(result.roles).map(([role, count]) => `${count} ${role.replace('_', ' ')}`).join(', ')}.</p>
      <p className="sync-regions">{Object.entries(result.regions).map(([region, count]) => <span key={region}>{region} <b>{count}</b></span>)}</p>
      {result.warnings?.map((warning) => <p className="sync-warning" key={warning.issue}>{warning.issue}: {warning.emails.join(', ')}</p>)}
    </div>}
  </section>;
}
