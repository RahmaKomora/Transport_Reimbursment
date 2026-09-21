// Claim lifecycle. A claim is created in one of the first three states and can only move
// forward: PENDING_MANAGER_REVIEW -> MANAGER_APPROVED -> PAYMENT_SENT, or straight to
// SYSTEM_APPROVED when it is within the cycle allowance.
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
  PAYMENT_SENT: 'Payment Sent',
  REJECTED: 'Rejected',
};

// Money the department has committed: approved this cycle, or sealed in a batch.
export const APPROVED_STATUSES = [STATUS.APPROVED, STATUS.BATCHED_FOR_HR];
export const PAID_STATUSES = [STATUS.PAYMENT_SENT];
// Only a sealed batch can be paid. An approved claim in the open cycle is visible to HR
// but not yet payable, which is the whole point of batching.
export const PAYABLE_STATUSES = [STATUS.BATCHED_FOR_HR];

const HR_QUEUE = 'hr';

/**
 * Decides what happens to a claim the moment it is submitted.
 *
 * The rules, in the order they are applied:
 *   1. Over the cycle ceiling  -> blocked outright, nothing is written.
 *   2. Within the cycle allowance -> auto-approved, straight to HR for payment.
 *   3. Between the two -> a manager reviews it first.
 *
 * Within rule 3 two things can divert the claim away from Manager 1: the claimant IS
 * Manager 1 (nobody approves their own claim), or Manager 1 is flagged out of office.
 * Both fall through to Manager 2, and to HR when there is no Manager 2 to fall back on.
 *
 * @param {{amount: number, user: object}} input
 * @returns {{status: string, assignedTo: string, reason: string, blocked: boolean, autoApproved: boolean}}
 */
export function routeClaim({ amount, user }) {
  const claimed = Number(amount);
  const withinCycle = user.transportPerCycle || 0;
  const ceiling = user.maxPerCycle || 0;

  if (!Number.isFinite(claimed) || claimed <= 0) {
    return decision(STATUS.BLOCKED, '', 'Enter an amount greater than zero.', { blocked: true });
  }

  // Rule 1. A ceiling of zero means the sheet has no limit recorded for this person; treat
  // that as "not configured" rather than "everything is over budget", which would lock out
  // every claimant the moment a column is left blank.
  if (ceiling > 0 && claimed > ceiling) {
    return decision(STATUS.BLOCKED, '', `This claim of ${claimed} is above the maximum of ${ceiling} allowed for your cycle. Reduce the amount or raise it with your manager outside Songa.`, { blocked: true });
  }

  // Rule 2.
  if (withinCycle > 0 && claimed <= withinCycle) {
    return decision(STATUS.APPROVED, HR_QUEUE, `Within the ${withinCycle} cycle allowance, approved automatically. It joins HR's batch when this cycle closes.`, { autoApproved: true, approvalSource: 'system' });
  }

  // Rule 3.
  const reviewer = pickReviewer(user);
  return decision(STATUS.PENDING_MANAGER, reviewer.email, reviewer.reason);
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
  return {
    email: HR_QUEUE,
    reason: isOwnManager
      ? 'You are the first approver on your own claim and no second approver is set, so HR reviews it.'
      : 'No manager is available to review this claim, so HR reviews it.',
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
  if (action === 'pay') {
    return { ...claim, status: STATUS.PAYMENT_SENT, assignedTo: '', decisionLog: log };
  }
  if (action === 'batch') {
    return { ...claim, status: STATUS.BATCHED_FOR_HR, assignedTo: HR_QUEUE, decisionLog: log };
  }
  throw new Error(`Unknown action: ${action}`);
}

/** Whether a given user is allowed to act on a claim, and why not when they are not. */
export function canAct(user, claim, action) {
  if (action === 'pay') {
    if (user.role !== 'hr' && user.role !== 'admin') return { allowed: false, reason: 'Only HR can mark a claim as paid.' };
    if (claim.status === STATUS.APPROVED) return { allowed: false, reason: 'This claim is in the open cycle. It becomes payable when the cycle closes and the batch is released.' };
    return { allowed: PAYABLE_STATUSES.includes(claim.status), reason: 'Only claims in a released batch can be paid.' };
  }
  if (claim.status !== STATUS.PENDING_MANAGER) {
    return { allowed: false, reason: 'This claim is no longer awaiting review.' };
  }
  if (claim.submittedBy === user.email) {
    return { allowed: false, reason: 'You cannot review your own claim.' };
  }
  const assignedToHr = claim.assignedTo === HR_QUEUE;
  const allowed = assignedToHr
    ? user.role === 'hr' || user.role === 'admin'
    : claim.assignedTo === user.email || user.role === 'admin';
  return { allowed, reason: allowed ? '' : 'This claim is assigned to someone else.' };
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
  const approved = [STATUS.APPROVED, STATUS.BATCHED_FOR_HR, STATUS.PAYMENT_SENT];
  return {
    pending: claims.filter((claim) => claim.status === STATUS.PENDING_MANAGER).length,
    // Once approved a claim keeps counting as approved through batching and payment;
    // dropping it at each step would make the card look like approvals had been undone.
    approved: claims.filter((claim) => approved.includes(claim.status)).length,
    rejected: claims.filter((claim) => claim.status === STATUS.REJECTED).length,
    total: claims.length,
  };
}
