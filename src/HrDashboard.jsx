import { useState } from 'react';
import SavingsAnalytics from './SavingsAnalytics';
import DirectoryStatus from './DirectoryStatus';
import HrClaims from './HrClaims';

const TABS = [
  { key: 'claims', label: 'All Claims', blurb: 'Every claim, filtered how you need it. Export the list for Finance.' },
  { key: 'savings', label: 'Savings Analytics', blurb: 'Budget left unspent this cycle.' },
];

export default function HrDashboard({ money }) {
  const [tab, setTab] = useState('claims');
  // Bumped on a directory reload so the visible tab refetches against the new figures.
  const [syncNonce, setSyncNonce] = useState(0);
  const active = TABS.find((item) => item.key === tab);

  return <>
    <section className="page-heading"><div>
      <span className="kicker">HR</span>
      <h1>Reimbursements</h1>
      <p>{active.blurb}</p>
    </div></section>
    <DirectoryStatus onSynced={() => setSyncNonce((value) => value + 1)} />
    <div className="hr-tabs" role="tablist">
      {TABS.map((item) => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'selected' : ''} onClick={() => setTab(item.key)}>{item.label}</button>)}
    </div>
    {tab === 'claims' && <HrClaims money={money} key={`claims-${syncNonce}`} />}
    {tab === 'savings' && <SavingsAnalytics money={money} key={`savings-${syncNonce}`} />}
  </>;
}
