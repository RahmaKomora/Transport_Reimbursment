import { useState } from 'react';

/**
 * An M-Pesa confirmation code is exactly ten alphanumeric characters, e.g. QWE123ABC1.
 *
 * Enforced rather than merely suggested because the code is what ties a claim to a real
 * payment: it is how Finance reconciles, and how a repeated submission is caught. A
 * truncated or mistyped code silently breaks both.
 */
export const MPESA_CODE_LENGTH = 10;

/**
 * Keeps only what a code can contain, uppercased.
 *
 * Stripping rather than rejecting, because the usual way this field gets filled is a paste
 * from the M-Pesa SMS, which brings a trailing space or an invisible character with it.
 * Refusing that paste would be blaming the person for how their phone copied it.
 */
const cleanCode = (raw) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MPESA_CODE_LENGTH);

/**
 * Part 2 of a claim: the M-Pesa details and the money.
 *
 * The allowance is shown as a wallet that draws down, because that is how it behaves — a
 * claim inside what is left is approved on the spot, and one that overruns goes to a
 * manager. Saying so before the amount is typed is the difference between an expected
 * outcome and a surprise.
 */
export default function AccountClaim({ trip, claim, setClaim, distance, total, onSubmit, money, compressImage, formatFileSize, ledger, submitError }) {
  const [uploadError, setUploadError] = useState('');
  const [touched, setTouched] = useState({});
  const claimed = Number(claim.amount);
  const codeComplete = claim.code.length === MPESA_CODE_LENGTH;

  // One line under the button says the form is not ready; the per-field messages below
  // each input say which one, once it has been visited. Listing every outstanding field
  // in a block under the button only repeated the labels directly above it.
  const complete = Boolean(
    trip.purposes.length && trip.transport && trip.start
    && codeComplete && claim.proof.trim() && claimed > 0,
  );

  const ready = complete && !uploadError;
  const update = (field, value) => setClaim((current) => ({ ...current, [field]: value }));
  const blur = (field) => setTouched((current) => ({ ...current, [field]: true }));

  // Where this claim falls against the wallet, mirroring the server's own rule so the
  // outcome is stated before submission rather than discovered after it.
  const band = !ledger || !(claimed > 0) ? null
    : claimed > ledger.totalRemaining ? 'over'
      : claimed <= ledger.baseRemaining ? 'auto' : 'topup';

  const handleProof = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError('');
    update('proof', '');
    try {
      const compressed = await compressImage(file);
      setClaim((current) => ({ ...current, proof: compressed.name, proofSize: compressed.size, proofData: compressed.dataUrl }));
    } catch (error) {
      setUploadError(error.message);
      event.target.value = '';
    }
  };

  return <>
    <section className="page-heading compact"><div>
      <span className="kicker">Part 2 of 2</span>
      <h1>M-Pesa submission</h1>
    </div></section>

    <form className="claim-layout" onSubmit={onSubmit}>
      <div className="form-card">
        <h2>Proof of payment</h2>

        <label>M-Pesa transaction code
          <input
            required
            value={claim.code}
            onChange={(event) => update('code', cleanCode(event.target.value))}
            onBlur={() => blur('code')}
            placeholder="e.g. QWE123ABC1"
            maxLength={MPESA_CODE_LENGTH}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck="false"
            style={{ textTransform: 'uppercase' }}
            className={touched.code && !codeComplete ? 'invalid' : undefined}
          />
          {/* A counter rather than a sentence. It states the rule, shows progress towards
              it, and goes red once the field has been left short — which a line of prose
              explaining that a code is ten characters did none of. */}
          <small className={`char-count${touched.code && !codeComplete ? ' bad' : ''}`}>
            {claim.code.length}/{MPESA_CODE_LENGTH}
          </small>
        </label>

        <label>Email address<input required type="email" value={claim.email} readOnly /></label>

        <label>Amount (KES)
          <input required type="number" min="1" step="1" value={claim.amount} onChange={(event) => update('amount', event.target.value)} onBlur={() => blur('amount')} placeholder="Enter amount" className={touched.amount && !(claimed > 0) ? 'invalid' : undefined} />
        </label>

        <label>Proof of payment
          {/* No `capture` attribute on purpose. It would send the phone straight to the
              rear camera, and the proof is always a screenshot already sitting in the
              gallery — nobody can photograph a confirmation off their own screen. Where
              somebody else paid, they forward their screenshot, so it is still a file to
              pick. Without `capture` the phone offers its normal picker. */}
          <input required type="file" accept="image/jpeg,image/png,image/webp" onChange={handleProof} />
          <small className="file-help">Image with the code, amount and date visible.</small>
        </label>
        {claim.proof && <p className="file-success">{claim.proof} ready ({formatFileSize(claim.proofSize)})</p>}
        {uploadError && <p className="file-error">{uploadError}</p>}

        <div className="claim-summary"><span>{trip.purposes.join(', ')}</span><span>{distance.toFixed(1)} km tracked</span></div>

        {band === 'auto' && <p className="outcome-note calm">Within your allowance, approved straight away.</p>}
        {band === 'topup' && <p className="outcome-note warn">Over your remaining {money(ledger.baseRemaining)}, so it goes to your manager.</p>}
        {band === 'over' && <p className="outcome-note over">{money(claimed - ledger.totalRemaining)} over your cycle maximum. Your manager will see it flagged.</p>}

        {!ready && <p className="outcome-note missing">Attach an M-Pesa payment above to enable submission.</p>}
        {submitError && <p className="queue-error">{submitError}</p>}

        <button className="button primary align-right" type="submit" disabled={!ready}>Submit reimbursement</button>
      </div>

      <aside className="total-card">
        <h2 className="total-title">Claim Overview</h2>
        <div className="total-row"><span>Tracked distance</span><b>{distance.toFixed(1)} km</b></div>
        <div className="total-row amount"><span>Total amount</span><strong>{money(total)}</strong></div>

        {ledger && <>
          <div className="wallet">
            <div className="wallet-head"><span>Cycle allowance</span><b>{money(ledger.baseRemaining)} left</b></div>
            <div className="wallet-bar" aria-hidden="true">
              <i style={{ width: `${ledger.base ? Math.min(100, (ledger.used / ledger.base) * 100) : 0}%` }} />
            </div>
            <small>{money(ledger.used)} of {money(ledger.base)} used this cycle</small>
          </div>
          <div className="total-row"><span>Top-up available</span><b>{money(ledger.topUpRemaining)}</b></div>
          <div className="total-row"><span>Cycle maximum</span><b>{money(ledger.max)}</b></div>
        </>}
      </aside>
    </form>
  </>;
}
