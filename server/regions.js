import { cycleKeyOf } from './cycles.js';
import { APPROVED_STATUSES, COMPLETED_STATUSES, STATUS } from './routing.js';

/**
 * Every region's cycle at a glance, for HR.
 *
 * HR is not approving individual claims — they are answering two questions. How much of
 * each region's allowance has actually been drawn, and which regions have claims sitting
 * unapproved that will miss this cycle's payment run unless a manager acts. The second is
 * the one they can do something about, so pending is reported with a count, a value, and
 * how long the oldest has been waiting.
 *
 * Allocation is the sum of the base allowances of the staff in that region, so it is what
 * the region could spend this cycle, not an annual figure divided down. Anyone without an
 * allowance is left out entirely: HR and approvers hold sheet rows so they can sign in,
 * and counting them as staff with a zero budget only adds empty rows.
 */
export function regionalSummary(users, claims, cycleKey = cycleKeyOf()) {
  const regions = new Map();
  const ensure = (name) => {
    const key = name || 'Unassigned';
    if (!regions.has(key)) {
      regions.set(key, {
        region: key,
        staff: 0,
        allocation: 0,
        topUp: 0,
        approved: { count: 0, amount: 0 },
        pending: { count: 0, amount: 0, oldest: null },
        rejected: { count: 0, amount: 0 },
        paid: { count: 0, amount: 0 },
        // Pending claims bucketed by whoever has to decide them. Keyed by email while
        // counting, flattened to a sorted array below.
        pendingBy: new Map(),
      });
    }
    return regions.get(key);
  };

  // Approvers are named on their own record when they have one, and on the records of
  // the people they approve for when they do not, so both are worth looking in.
  const nameOf = new Map();
  for (const person of users) {
    if (person.email) nameOf.set(person.email, person.name || '');
    if (person.manager1Email && person.manager1Name) nameOf.set(person.manager1Email, person.manager1Name);
    if (person.manager2Email && person.manager2Name) nameOf.set(person.manager2Email, person.manager2Name);
  }

  const claimants = users.filter((user) => user.isStaff && user.active !== false && (Number(user.transportPerCycle) || 0) > 0);

  // Who the allocation does NOT cover. Reported rather than left implicit: a department
  // with most of its people deactivated shows a small allocation that looks like a bug,
  // and without this there is nothing on screen to explain the figure.
  const staff = users.filter((user) => user.isStaff);
  const excluded = {
    inactive: staff.filter((user) => user.active === false).length,
    noAllowance: staff.filter((user) => user.active !== false && !(Number(user.transportPerCycle) > 0)).length,
  };
  for (const person of claimants) {
    const row = ensure(person.region);
    row.staff += 1;
    row.allocation += Number(person.transportPerCycle) || 0;
    row.topUp += Number(person.extraAllowancePerCycle) || 0;
  }

  const inCycle = claims.filter((claim) => (claim.cycleKey || cycleKeyOf(claim.submittedAt)) === cycleKey);
  for (const claim of inCycle) {
    const row = ensure(claim.region);
    const amount = Number(claim.amount) || 0;

    if (claim.status === STATUS.PENDING_MANAGER) {
      row.pending.count += 1;
      row.pending.amount += amount;
      if (!row.pending.oldest || new Date(claim.submittedAt) < new Date(row.pending.oldest)) row.pending.oldest = claim.submittedAt;

      // A claim with nobody to decide it is the worst case, not a missing value: it will
      // sit until somebody notices. It gets its own bucket rather than being dropped.
      const reviewer = (claim.assignedTo || '').toLowerCase();
      const key = reviewer && reviewer !== 'hr' ? reviewer : '';
      if (!row.pendingBy.has(key)) row.pendingBy.set(key, { email: key, name: nameOf.get(key) || '', count: 0, amount: 0, oldest: null });
      const waiting = row.pendingBy.get(key);
      waiting.count += 1;
      waiting.amount += amount;
      if (!waiting.oldest || new Date(claim.submittedAt) < new Date(waiting.oldest)) waiting.oldest = claim.submittedAt;
    } else if (claim.status === STATUS.REJECTED) {
      row.rejected.count += 1;
      row.rejected.amount += amount;
    } else if ([...APPROVED_STATUSES, ...COMPLETED_STATUSES].includes(claim.status)) {
      row.approved.count += 1;
      row.approved.amount += amount;
      if (COMPLETED_STATUSES.includes(claim.status)) {
        row.paid.count += 1;
        row.paid.amount += amount;
      }
    }
  }

  const rows = [...regions.values()].map((row) => {
    // Pending counts against the budget: it is money the region has spent and is waiting
    // to be reimbursed for, whatever the approval says later.
    const committed = row.approved.amount + row.pending.amount;
    return {
      ...row,
      // Most claims waiting first: that is the order somebody chasing them would work in.
      // An unassigned bucket sorts to the end, since there is nobody to chase for it.
      pendingBy: [...row.pendingBy.values()].sort((a, b) => (!a.email) - (!b.email) || b.count - a.count || a.name.localeCompare(b.name)),
      committed,
      unspent: Math.max(0, row.allocation - committed),
      utilisation: row.allocation > 0 ? committed / row.allocation : 0,
    };
  });

  // Regions with claims waiting come first: that is the list HR works from.
  rows.sort((a, b) => b.pending.count - a.pending.count || b.committed - a.committed || a.region.localeCompare(b.region));

  const sum = (pick) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    cycleKey,
    regions: rows,
    excluded,
    totals: {
      regions: rows.length,
      staff: sum((r) => r.staff),
      allocation: sum((r) => r.allocation),
      approved: sum((r) => r.approved.amount),
      approvedCount: sum((r) => r.approved.count),
      pending: sum((r) => r.pending.amount),
      pendingCount: sum((r) => r.pending.count),
      rejected: sum((r) => r.rejected.amount),
      rejectedCount: sum((r) => r.rejected.count),
      paid: sum((r) => r.paid.amount),
      committed: sum((r) => r.committed),
      unspent: sum((r) => r.unspent),
    },
  };
}
