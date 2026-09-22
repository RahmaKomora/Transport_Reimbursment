import { APPROVED_STATUSES, PAID_STATUSES, STATUS, visibleToManager } from './routing.js';

/**
 * In-app alerts: what this person needs to do, and by when.
 *
 * The deadline is what makes these worth showing. Approvals are not merely outstanding
 * work — a claim still pending when the cycle seals misses that payment run and the
 * claimant waits another two weeks to be paid back money they have already spent. So an
 * alert says how long is left, not just how many are waiting.
 *
 * Pure: takes claims and a cycle, returns what to display. No storage, no read state.
 * The badge counts things that need action, which is honest in a way an "unread" count
 * derived from nothing would not be.
 */
const DAY_MS = 86_400_000;
const CLOSING_SOON_HOURS = 72;
const STALE_DAYS = 3;

export function buildAlerts(user, claims, cycle, now = new Date()) {
  const hoursLeft = Math.max(0, (cycle.batchAt.getTime() - now.getTime()) / 3_600_000);
  const closingSoon = hoursLeft <= CLOSING_SOON_HOURS;
  const deadline = {
    label: cycle.label,
    range: cycle.range,
    closesAt: cycle.batchAt.toISOString(),
    hoursLeft: Math.round(hoursLeft),
    closingSoon,
    phrase: describeRemaining(hoursLeft),
  };

  const items = user.role === 'hr' || user.role === 'admin'
    ? hrAlerts(claims, deadline, now)
    : user.isApprover
      ? approverAlerts(user, claims, deadline, now)
      : claimantAlerts(user, claims, deadline);

  return {
    cycle: deadline,
    actionCount: items.filter((item) => item.needsAction).reduce((total, item) => total + (item.count || 1), 0),
    items,
  };
}

/** A manager: what is waiting on them, and whether it will make the cycle. */
function approverAlerts(user, claims, deadline, now) {
  const mine = visibleToManager(claims, user).filter((claim) => claim.submittedBy !== user.email);
  const pending = mine.filter((claim) => claim.status === STATUS.PENDING_MANAGER);
  const items = [];

  if (pending.length) {
    items.push({
      id: 'pending',
      tone: deadline.closingSoon ? 'urgent' : 'warn',
      needsAction: true,
      count: pending.length,
      title: `${pending.length} claim${pending.length === 1 ? '' : 's'} waiting for your approval`,
      body: deadline.closingSoon
        ? `${deadline.label} closes ${deadline.phrase}. Anything still pending then misses this payment run.`
        : `Worth clearing before ${deadline.label} closes ${deadline.phrase}.`,
      view: 'team',
      status: 'Pending',
    });
  } else {
    items.push({ id: 'clear', tone: 'calm', needsAction: false, title: 'Nothing waiting on you', body: `${deadline.label} closes ${deadline.phrase}.` });
  }

  // A claim above someone's cycle ceiling is a deliberate decision, not a routine one.
  const overBudget = pending.filter((claim) => claim.ceiling > 0 && claim.amount > claim.ceiling);
  if (overBudget.length) {
    items.push({
      id: 'over-budget',
      tone: 'warn',
      needsAction: false,
      count: overBudget.length,
      title: `${overBudget.length} of them ${overBudget.length === 1 ? 'is' : 'are'} over budget`,
      body: 'Above the claimant’s cycle maximum. Approving commits the full amount.',
      view: 'team',
      status: 'Pending',
    });
  }

  const stale = pending.filter((claim) => now.getTime() - new Date(claim.submittedAt).getTime() > STALE_DAYS * DAY_MS);
  if (stale.length) {
    items.push({
      id: 'stale',
      tone: 'warn',
      needsAction: false,
      count: stale.length,
      title: `${stale.length} ${stale.length === 1 ? 'has' : 'have'} been waiting over ${STALE_DAYS} days`,
      body: 'The oldest was submitted ' + daysAgo(oldest(stale), now) + '.',
      view: 'team',
      status: 'Pending',
    });
  }

  return items;
}

/** HR: what is coming into the next batch, and what will miss it. */
function hrAlerts(claims, deadline) {
  const items = [];
  const approved = claims.filter((claim) => APPROVED_STATUSES.includes(claim.status) && claim.status !== STATUS.BATCHED_FOR_HR);
  const batched = claims.filter((claim) => claim.status === STATUS.BATCHED_FOR_HR);
  const pending = claims.filter((claim) => claim.status === STATUS.PENDING_MANAGER);

  if (batched.length) {
    items.push({
      id: 'ready',
      tone: 'urgent',
      needsAction: true,
      count: batched.length,
      title: `${batched.length} claim${batched.length === 1 ? '' : 's'} ready for payment`,
      body: `${money(total(batched))} sealed and waiting to be sent.`,
      view: 'hr',
    });
  }

  items.push({
    id: 'incoming',
    tone: 'calm',
    needsAction: false,
    count: approved.length,
    title: `${approved.length} approved claim${approved.length === 1 ? '' : 's'} in the open cycle`,
    body: `${money(total(approved))} will be sealed into the ${deadline.label} batch ${deadline.phrase}.`,
    view: 'hr',
  });

  // The one HR can act on before the deadline: chase the managers still sitting on claims.
  if (pending.length) {
    items.push({
      id: 'chase',
      tone: deadline.closingSoon ? 'urgent' : 'warn',
      needsAction: false,
      count: pending.length,
      title: `${pending.length} claim${pending.length === 1 ? '' : 's'} still with managers`,
      body: deadline.closingSoon
        ? `Unless approved ${deadline.phrase}, ${pending.length === 1 ? 'it misses' : 'they miss'} this batch and the claimant waits another cycle.`
        : 'Not yet approved, so not yet in the batch.',
    });
  }

  return items;
}

/** A claimant: what has happened to their own claims. */
function claimantAlerts(user, claims, deadline) {
  const mine = claims.filter((claim) => claim.submittedBy === user.email);
  const items = [];

  const rejected = mine.filter((claim) => claim.status === STATUS.REJECTED);
  if (rejected.length) {
    items.push({ id: 'rejected', tone: 'warn', needsAction: false, count: rejected.length, title: `${rejected.length} of your claims ${rejected.length === 1 ? 'was' : 'were'} rejected`, body: 'Open the claim to see who decided and why.', view: 'claims' });
  }

  const waiting = mine.filter((claim) => claim.status === STATUS.PENDING_MANAGER);
  if (waiting.length) {
    items.push({ id: 'waiting', tone: 'calm', needsAction: false, count: waiting.length, title: `${waiting.length} claim${waiting.length === 1 ? '' : 's'} with your manager`, body: `${deadline.label} closes ${deadline.phrase}.`, view: 'claims' });
  }

  const unpaid = mine.filter((claim) => APPROVED_STATUSES.includes(claim.status));
  if (unpaid.length) {
    items.push({ id: 'unpaid', tone: 'calm', needsAction: false, count: unpaid.length, title: `${money(total(unpaid))} approved, awaiting payment`, body: `Paid out after ${deadline.label} closes ${deadline.phrase}.`, view: 'claims' });
  }

  const paid = mine.filter((claim) => PAID_STATUSES.includes(claim.status));
  if (!items.length) {
    items.push({ id: 'clear', tone: 'calm', needsAction: false, title: 'Nothing needs your attention', body: paid.length ? `${money(total(paid))} has been paid out to you.` : 'Log a field trip to submit your first claim.' });
  }

  return items;
}

function describeRemaining(hours) {
  if (hours <= 0) return 'now';
  if (hours < 1) return 'in under an hour';
  if (hours < 24) return `in ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function daysAgo(claim, now) {
  const days = Math.floor((now.getTime() - new Date(claim.submittedAt).getTime()) / DAY_MS);
  return days <= 1 ? 'yesterday' : `${days} days ago`;
}

function oldest(claims) {
  return claims.reduce((worst, claim) => (new Date(claim.submittedAt) < new Date(worst.submittedAt) ? claim : worst), claims[0]);
}

const total = (claims) => claims.reduce((sum, claim) => sum + (Number(claim.amount) || 0), 0);
const money = (value) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(value || 0);
