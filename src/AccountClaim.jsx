import { useState } from 'react';

export default function AccountClaim({ trip, claim, setClaim, distance, total, onSubmit, money, compressImage, formatFileSize }) {
  const [uploadError, setUploadError] = useState('');
  const ready = trip.start && trip.end && trip.purposes.length && trip.transport && claim.code.trim() && claim.email.trim() && claim.name.trim() && claim.proof.trim() && !uploadError && Number(claim.amount) > 0;
  const update = (field, value) => setClaim((current) => ({ ...current, [field]: value }));
  const handleProof = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError('');
    update('proof', '');
    try {
      const compressed = await compressImage(file);
      setClaim((current) => ({ ...current, proof: compressed.name, proofSize: compressed.size }));
    } catch (error) {
      setUploadError(error.message);
      event.target.value = '';
    }
  };

  return <>
    <section className="page-heading compact"><div><span className="kicker">Part 2 of 2</span><h1>M-Pesa submission</h1><p>Fill every field and attach proof of payment before submitting.</p></div></section>
    <form className="claim-layout" onSubmit={onSubmit}>
      <div className="form-card">
        <h2>Proof of payment</h2>
        <label>M-Pesa transaction code<input required value={claim.code} onChange={(event) => update('code', event.target.value.toUpperCase())} placeholder="e.g. QWE123ABC" style={{ textTransform: 'uppercase' }} /></label>
        <label>Email address<input required type="email" value={claim.email} readOnly /></label>
        <label>Name on M-Pesa account<input required value={claim.name} onChange={(event) => update('name', event.target.value)} placeholder="Full name" /></label>
        <label>Amount (KES)<input required type="number" min="1" step="1" value={claim.amount} onChange={(event) => update('amount', event.target.value)} placeholder="Enter amount" /></label>
        <label>Proof of payment<input required type="file" accept="image/jpeg,image/png,image/webp" onChange={handleProof} /><small className="file-help">JPEG, PNG or WebP. Images are compressed to 500 KB or less.</small></label>
        {claim.proof && <p className="file-success">{claim.proof} ready ({formatFileSize(claim.proofSize)})</p>}
        {uploadError && <p className="file-error">{uploadError}</p>}
        <div className="claim-summary"><span>{trip.purposes.join(', ')}</span><span>{distance.toFixed(1)} km tracked</span></div>
        <button className="button primary align-right" type="submit" disabled={!ready}>Submit reimbursement</button>
      </div>
      <aside className="total-card"><span>Claim amount</span><strong>{claim.amount ? money(claim.amount) : 'Enter amount'}</strong><small>Your claim amount is captured from the form and reviewed after submission.</small></aside>
    </form>
  </>;
}
