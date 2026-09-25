import { createHash } from 'node:crypto';
import { STATUS } from './routing.js';

/**
 * Spots a claim that has probably been submitted before.
 *
 * Three signals, strongest first:
 *
 *   1. The M-Pesa transaction code. One payment produces one code, so the same code twice
 *      is the same payment twice — near certainty, not a guess.
 *   2. The proof image, compared by hash. The same screenshot attached to two claims means
 *      one receipt is doing double duty.
 *   3. Same person, same day, same amount. Circumstantial: two identical piki fares on one
 *      day is entirely possible, so this is raised as worth a look, never as a verdict.
 *
 * Nothing here blocks a submission. Duplicates are usually honest mistakes — a double tap,
 * a resubmission after a lost connection — and the manager is better placed to judge than
 * a rule is. The flag travels to them with the evidence attached.
 */
const DAY_MS = 86_400_000;

export function fingerprintImage(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1];
  if (!base64) return '';
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex').slice(0, 16);
}

/**
 * @returns {{level: 'certain'|'likely'|'possible', reason: string, matches: object[]} | null}
 */
export function findDuplicates(candidate, existing) {
  // A rejected claim is not evidence of a duplicate: resubmitting a corrected version of
  // one is exactly what a claimant is supposed to do.
  const live = existing.filter((claim) => claim.id !== candidate.id && claim.status !== STATUS.REJECTED);

  const code = normaliseCode(candidate.mpesaCode);
  if (code) {
    const sameCode = live.filter((claim) => normaliseCode(claim.mpesaCode) === code);
    if (sameCode.length) {
      return {
        level: 'certain',
        reason: `M-Pesa code ${code} was already claimed`,
        matches: sameCode.map(brief),
      };
    }
  }

  if (candidate.proofHash) {
    const sameImage = live.filter((claim) => claim.proofHash && claim.proofHash === candidate.proofHash);
    if (sameImage.length) {
      return {
        level: 'likely',
        reason: 'The same proof-of-payment image is attached to an earlier claim',
        matches: sameImage.map(brief),
      };
    }
  }

  const sameDayAmount = live.filter((claim) => (
    claim.submittedBy === candidate.submittedBy
    && Number(claim.amount) === Number(candidate.amount)
    && withinADay(claim.submittedAt, candidate.submittedAt)
  ));
  if (sameDayAmount.length) {
    return {
      level: 'possible',
      reason: 'Same claimant, same amount, same day',
      matches: sameDayAmount.map(brief),
    };
  }

  return null;
}

/**
 * The note a manager can send back with a rejection. Written for the claimant to act on:
 * it says what was matched, and what to do if the trip really was separate.
 */
export function duplicateNote(duplicate) {
  const first = duplicate.matches[0];
  const when = first?.submittedAt ? new Date(first.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'an earlier date';
  return `This looks like a duplicate of a claim submitted on ${when}. If it is a separate trip, add a note explaining the difference and resubmit.`;
}

function brief(claim) {
  return {
    id: claim.id,
    submittedAt: claim.submittedAt,
    tripDate: claim.tripDate,
    amount: Number(claim.amount) || 0,
    status: claim.status,
    purpose: claim.purpose,
  };
}

// Codes are typed by hand off a phone screen, so compare them case- and space-insensitively.
function normaliseCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function withinADay(a, b) {
  if (!a || !b) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < DAY_MS;
}
