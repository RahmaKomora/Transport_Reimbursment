import { classify, cycleLedger } from './budget.js';

// Claim lifecycle. A claim is created in one of the first three states and can only move
// forward: PENDING_MANAGER_REVIEW -> APPROVED -> BATCHED_FOR_HR -> COMPLETED, or straight
// to APPROVED when the claim fits the cycle allowance.
export const STATUS = {
  BLOCKED: 'Blocked - Over Budget',
  PENDING_MANAGER: 'Pending Manager Review',
  // Approval is immediate, whether it came from the system or a manager. Which of the two
  // it was is recorded in approvalSource rather than in the status, because everything
  // downstream — batching, payment, savings — treats them identically.
  APPROVED: 'Approved',
  // Sealed into a closed cycle's batch and handed to HR for payment. Only the scheduler
  // sets this, at the cycle boundary.
  BATCHED_FOR_HR: 'Batched for HR',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
};

// Money the department has committed: approved this cycle, or sealed in a batch.
export const APPROVED_STATUSES = [STATUS.APPROVED, STATUS.BATCHED_FOR_HR];
export const COMPLETED_STATUSES = [STATUS.COMPLETED];
// The batch seal still governs when HR is notified and what the scheduler sweeps up; it
// no longer gates completion, which records what Finance actually did.

const HR_QUEUE = 'hr';

/**
 * Decides what happens to a claim the moment it is submitted, against the claimant's
 * running balance for the cycle rather than the claim in isolation.
 *
 *   Fits the remaining base allowance -> approved on the spot.
 *   Base spent, within the top-up      -> a manager decides.
 *   Beyond the cycle maximum           -> a manager decides, flagged as over budget.
 *
 * Checking each claim on its own was the old behaviour and it meant the allowance capped
 * nothing: five claims of 7,500 each passed individually and totalled 37,500 against a
 * 7,500 cycle.
 *
 * Within the manager path, two things divert a claim away from Manager 1: the claimant IS
 * Manager 1, or Manager 1 is out of office. Both fall through to Manager 2, and to HR when
 * there is no Manager 2.
 *
 * @param {{amount: number, user: object, ledger: object}} input
 */
export function routeClaim({ amount, user, ledger }) {
  const claimed = Number(amount);
  const balance = ledger || cycleLedger(user, [], undefined);

  if (!Number.isFinite(claimed) || claimed <= 0) {
    return decision(STATUS.BLOCKED, '', 'Enter an amount greater than zero.', { blocked: true });
  }

  const band = classify(claimed, balance);

  if (band === 'auto') {
    const left = balance.baseRemaining - claimed;
    return decision(STATUS.APPROVED, HR_QUEUE, `Approved automatically. That leaves ${left} of your ${balance.base} cycle allowance.`, {
      autoApproved: true, approvalSource: 'system', band, ledger: summarise(balance),
    });
  }

  const reviewer = pickReviewer(user);
  const why = band === 'over'
    ? `This is ${claimed - balance.totalRemaining} above what is left of your ${balance.max} cycle maximum. It has been sent for review and flagged as over budget.`
    : balance.baseRemaining > 0
      ? `This is more than the ${balance.baseRemaining} left of your cycle allowance, so it draws on the ${balance.topUp} top-up and needs approval.`
      : `Your ${balance.base} cycle allowance is used up, so this draws on the ${balance.topUp} top-up and needs approval.`;

  // With nobody assigned, the claimant has to be told — otherwise the claim looks like it
  // is with someone and simply never moves.
  const reason = reviewer.email ? why : `${why} ${reviewer.reason}`;

  return decision(STATUS.PENDING_MANAGER, reviewer.email, reason, {
    band,
    overBudget: band === 'over',
    ceiling: balance.max,
    ledger: summarise(balance),
  });
}

function summarise(ledger) {
  return { base: ledger.base, topUp: ledger.topUp, max: ledger.max, used: ledger.used, baseRemaining: ledger.baseRemaining, totalRemaining: ledger.totalRemaining };
}

/**
 * Chooses who reviews a claim that needs manager sign-off.
 * Exported separately because the self-approval rule is the part most likely to change.
 */
export function pickReviewer(user) {
  const submitter = (user.email || '').toLowerCase();
  const manager1 = (user.manager1Email || '').toLowerCase();
  const manager2 = (user.manager2Email || '').toLowerCase();

  const isOwnManager = Boolean(manager1) && submitter === manager1;
  const manager1Unavailable = isOwnManager || user.manager1OutOfOffice;

  if (!manager1Unavailable && manager1) {
    return { email: manager1, reason: 'Above the cycle allowance, sent to your manager for review.' };
  }
  if (manager2 && manager2 !== submitter) {
    return {
      email: manager2,
      reason: isOwnManager
        ? 'You are the first approver on your own claim, so it goes to your second approver instead.'
        : 'Your first approver is out of office, so it goes to your second approver.',
    };
  }
  // No fallback to HR. Approving is a manager's job — HR's is the payment list — so a
  // claim with nobody to review it is left unassigned rather than parked in a queue
  // whose owner will not act on it. Any approver covering the claimant's region can
  // still pick it up, and the admin screen flags the missing approver so it gets fixed.
  return {
    email: '',
    reason: isOwnManager
      ? 'You are the only approver on your own claim, so it needs another approver. Ask an administrator to assign one.'
      : 'No approver is set for you. A manager for your region can review it, or ask an administrator to assign one.',
  };
}

/** Applies a manager or HR decision to an existing claim, returning the updated claim. */
export function applyDecision(claim, { actor, action, note = '' }) {
  const at = new Date().toISOString();
  const log = [...(claim.decisionLog || []), { actor, action, note, at }];

  if (action === 'approve') {
    return { ...claim, status: STATUS.APPROVED, approvalSource: actor, assignedTo: HR_QUEUE, decisionLog: log };
  }
  if (action === 'reject') {
    return { ...claim, status: STATUS.REJECTED, assignedTo: '', decisionLog: log };
  }
  if (action === 'complete') {
    return { ...claim, status: STATUS.COMPLETED, completedAt: at, completedBy: actor, assignedTo: '', decisionLog: log };
  }
  if (action === 'batch') {
    return { ...claim, status: STATUS.BATCHED_FOR_HR, assignedTo: HR_QUEUE, decisionLog: log };
  }
  // A decision is not the end of the story. Auto-approval means most claims are never
  // read by a person, so an approver who later notices something has to be able to pull
  // one back rather than watch it get paid.
  if (action === 'reopen') {
    return { ...claim, status: STATUS.PENDING_MANAGER, assignedTo: actor, approvalSource: '', decisionLog: log };
  }
  // Raises a concern without changing the claim's state — for a claim already paid, where
  // reopening would be meaningless, and for anything that needs a second opinion.
  if (action === 'flag') {
    return { ...claim, reviewFlag: { by: actor, note, at }, decisionLog: log };
  }
  if (action === 'unflag') {
    return { ...claim, reviewFlag: null, decisionLog: log };
  }
  throw new Error(`Unknown action: ${action}`);
}

/** Whether a given user is allowed to act on a claim, and why not when they are not. */
export function canAct(user, claim, action) {
  const isApprover = user.role === 'hr' || user.role === 'admin' || visibleToManager([claim], user).length > 0;

  // Raising a concern is always available to an approver, whatever state the claim is in.
  // A paid claim cannot be undone here, but it can still be questioned.
  if (action === 'flag' || action === 'unflag') {
    return { allowed: isApprover, reason: isApprover ? '' : 'This claim is outside the regions you approve for.' };
  }

  if (action === 'reopen') {
    if (!isApprover) return { allowed: false, reason: 'This claim is outside the regions you approve for.' };
    if (claim.status === STATUS.PENDING_MANAGER) return { allowed: false, reason: 'This claim is already awaiting review.' };
    // Once the money has gone out, reopening would misrepresent what happened. Flag it and
    // settle it with Finance instead.
    if (claim.status === STATUS.COMPLETED) return { allowed: false, reason: 'This claim has already been paid. Flag it for review and raise it with HR.' };
    if (claim.submittedBy === user.email) return { allowed: false, reason: 'You cannot reopen your own claim.' };
    return { allowed: true, reason: '' };
  }

  // Marking completion records that Finance has paid. Only HR knows that, and any
  // approved claim can be marked: HR exports the approved list and settles it, so
  // insisting the batch had sealed first would block the ordinary case.
  if (action === 'complete') {
    if (user.role !== 'hr' && user.role !== 'admin') return { allowed: false, reason: 'Only HR can mark a claim as completed.' };
    if (claim.status === STATUS.COMPLETED) return { allowed: false, reason: 'This claim is already marked completed.' };
    const approved = APPROVED_STATUSES.includes(claim.status);
    return { allowed: approved, reason: approved ? '' : 'Only approved claims can be marked completed.' };
  }
  if (claim.status !== STATUS.PENDING_MANAGER) {
    return { allowed: false, reason: 'This claim has already been decided.' };
  }
  if (claim.submittedBy === user.email) {
    return { allowed: false, reason: 'You cannot review your own claim.' };
  }

  // Any approver the claim is visible to may decide it, not only the one it was routed
  // to. Routing picks a first port of call; treating that as exclusive turned every
  // other approver's queue into a dead end — they could see the claim sitting there and
  // do nothing about it, and it stayed pending until one specific person came back.
  // Whoever actually decides is recorded on the claim, so accountability is unchanged.
  if (user.role === 'admin') return { allowed: true, reason: '' };
  // Deliberately not HR: they collect approved claims for payment, they do not decide
  // them. An approver covering the region does.
  if (user.role === 'hr' && !user.isApprover) {
    return { allowed: false, reason: 'Approvals are made by managers. HR handles payment once a claim is approved.' };
  }
  const allowed = visibleToManager([claim], user).length > 0;
  return { allowed, reason: allowed ? '' : 'This claim is outside the regions you approve for.' };
}

function decision(status, assignedTo, reason, extra = {}) {
  return { status, assignedTo, reason, blocked: false, autoApproved: false, ...extra };
}

/**
 * The claims a given approver may see.
 *
 * A regional manager sees their own patch, not everyone's: the people they approve for,
 * and anything in the regions those people sit in. HR and admin see everything, which is
 * what makes their view the global one.
 *
 * Claims routed directly to them are always included, even from a region they do not
 * otherwise cover — being asked to approve something you cannot see would be a dead end.
 */
export function visibleToManager(claims, user) {
  if (user.role === 'hr' || user.role === 'admin') return claims;
  const regions = new Set(user.regions || (user.region ? [user.region] : []));
  const reports = new Set(user.approvesFor || []);
  return claims.filter((claim) => (
    reports.has(claim.submittedBy)
    || (claim.region && regions.has(claim.region))
    || claim.assignedTo === user.email
  ));
}

/** Pending / approved / rejected tallies for the manager summary cards. */
export function statusCounts(claims) {
  const approved = [STATUS.APPROVED, STATUS.BATCHED_FOR_HR, STATUS.COMPLETED];
  return {
    pending: claims.filter((claim) => claim.status === STATUS.PENDING_MANAGER).length,
    // Once approved a claim keeps counting as approved through batching and payment;
    // dropping it at each step would make the card look like approvals had been undone.
    approved: claims.filter((claim) => approved.includes(claim.status)).length,
    rejected: claims.filter((claim) => claim.status === STATUS.REJECTED).length,
    total: claims.length,
  };
}
