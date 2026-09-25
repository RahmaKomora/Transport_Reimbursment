import { cycleKeyOf } from './cycles.js';
import { APPROVED_STATUSES, COMPLETED_STATUSES, STATUS } from './routing.js';

/**
 * A claimant's running balance for one cycle.
 *
 * The allowance is a wallet, not a per-claim limit. Someone on 15,000 a month has 7,500 a
 * cycle: a 100 piki fare leaves 7,400, a 500 matatu fare leaves 6,900, and so on. While
 * the claim fits in what is left, Songa approves it on the spot. Once the 7,500 is gone a
 * further 3,000 top-up is available, and that is where a manager starts making decisions —
 * so 10,500 is the most this person can draw in a cycle.
 *
 * Pending claims are counted as spent. They may yet be rejected, which is why they are
 * excluded from the savings figures, but treating them as free here would let someone with
 * 7,000 awaiting approval get another 1,000 auto-approved and quietly overshoot.
 */
const spentStatuses = () => [...APPROVED_STATUSES, ...COMPLETED_STATUSES, STATUS.PENDING_MANAGER];

/**
 * Groups claims by claimant once, so a caller building ledgers for a whole team does not
 * rescan every claim for every person. At 1,400 staff that was the difference between one
 * pass and 1,400.
 */
export function indexClaimsByPerson(claims) {
  const byPerson = new Map();
  for (const claim of claims) {
    const key = claim.submittedBy;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(claim);
  }
  return byPerson;
}

export function cycleLedger(user, claims, cycleKey = cycleKeyOf(), index = null) {
  const base = Number(user.transportPerCycle) || 0;
  const topUp = Number(user.extraAllowancePerCycle) || 0;
  // Trust the sheet's stated maximum; fall back to base + top-up when that cell is blank.
  const max = Number(user.maxPerCycle) || base + topUp;

  const candidates = index ? (index.get(user.email) || []) : claims;
  const mine = candidates.filter((claim) => (
    claim.submittedBy === user.email
    && (claim.cycleKey || cycleKeyOf(claim.submittedAt)) === cycleKey
    && spentStatuses().includes(claim.status)
  ));

  const used = mine.reduce((total, claim) => total + (Number(claim.amount) || 0), 0);
  const awaiting = mine
    .filter((claim) => claim.status === STATUS.PENDING_MANAGER)
    .reduce((total, claim) => total + (Number(claim.amount) || 0), 0);

  const totalRemaining = Math.max(0, max - used);
  const baseRemaining = Math.max(0, base - used);

  return {
    cycleKey,
    base,
    topUp,
    max,
    used,
    awaiting,
    // What is still auto-approvable.
    baseRemaining,
    // What is left of the top-up, which needs a manager.
    topUpRemaining: Math.max(0, totalRemaining - baseRemaining),
    totalRemaining,
    // Unspent base allowance: what the department keeps if the cycle ends here. Pending
    // claims are included in `used`, so this is the cautious figure.
    saved: baseRemaining,
    usingTopUp: used > base,
    exhausted: totalRemaining === 0,
  };
}

/**
 * Where a claim of this size falls against the ledger.
 *   'auto'   — fits in the remaining base allowance, no human needed
 *   'topup'  — the base is spent, so this draws on the top-up and needs a manager
 *   'over'   — beyond the cycle maximum entirely
 *
 * A claim that straddles the base and the top-up is not split: it needs approval in full,
 * because no part of it can be waved through on its own.
 */
export function classify(amount, ledger) {
  const claimed = Number(amount);
  if (!Number.isFinite(claimed) || claimed <= 0) return 'invalid';
  // The maximum is checked first. Asking "does it fit the allowance?" first would let a
  // misconfigured row whose maximum sits below its allowance auto-approve past its own
  // ceiling — the ceiling has to be the outer bound, whatever the other cells say.
  if (ledger.max > 0 && claimed > ledger.totalRemaining) return 'over';
  if (ledger.base > 0 && claimed <= ledger.baseRemaining) return 'auto';
  return 'topup';
}
