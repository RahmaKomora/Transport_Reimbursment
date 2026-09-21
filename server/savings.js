import { APPROVED_STATUSES, PAID_STATUSES } from './routing.js';
import { cycleKeyOf } from './cycles.js';

// Money committed to a claimant: approved but unpaid, plus already paid. Claims still
// awaiting a manager are deliberately excluded — they may yet be rejected.
const COMMITTED_STATUSES = [...APPROVED_STATUSES, ...PAID_STATUSES];

/**
 * The cycle a date belongs to. Cycles are half-months in Nairobi time (1–15, 16–end);
 * see cycles.js. Budgets do not roll over from one to the next.
 */
export const cycleOf = cycleKeyOf;

// Claims carry their cycle from submission; rows written before cycles existed fall back
// to the cycle their timestamp lands in.
export function claimsInCycle(claims, cycle) {
  return claims.filter((claim) => (claim.cycleKey || cycleOf(claim.submittedAt)) === cycle);
}

/**
 * Per-person savings for one cycle.
 *
 * Saved = allocation - committed claims, floored at zero. Nothing carries forward, so a
 * cycle that ends underspent simply returns that money to the department.
 */
export function savingsForUser(user, claims, cycle) {
  const mine = claimsInCycle(claims, cycle).filter((claim) => claim.submittedBy === user.email);
  const committed = sum(mine.filter((claim) => COMMITTED_STATUSES.includes(claim.status)));
  const paid = sum(mine.filter((claim) => PAID_STATUSES.includes(claim.status)));
  const allocation = user.transportPerCycle || 0;
  return {
    email: user.email,
    name: user.name,
    region: user.region,
    zone: user.zone,
    allocation,
    committed,
    paid,
    saved: Math.max(0, allocation - committed),
    // Negative headroom would mean approvals exceeded the allocation, which the routing
    // rules should prevent; surfaced rather than hidden so it is visible if it happens.
    overspend: Math.max(0, committed - allocation),
    claimCount: mine.length,
  };
}

/** Rolls per-person savings up to regions, for the HR analytics view. */
export function savingsByRegion(users, claims, cycle) {
  const perUser = users.map((user) => savingsForUser(user, claims, cycle));
  const regions = new Map();

  for (const row of perUser) {
    const key = row.region || 'Unassigned';
    if (!regions.has(key)) {
      regions.set(key, { region: key, allocation: 0, committed: 0, paid: 0, saved: 0, overspend: 0, staff: 0, claimCount: 0, people: [] });
    }
    const region = regions.get(key);
    region.allocation += row.allocation;
    region.committed += row.committed;
    region.paid += row.paid;
    region.saved += row.saved;
    region.overspend += row.overspend;
    region.claimCount += row.claimCount;
    region.staff += 1;
    region.people.push(row);
  }

  const rows = [...regions.values()].map((region) => ({
    ...region,
    people: region.people.sort((a, b) => b.committed - a.committed),
    utilisation: region.allocation > 0 ? region.committed / region.allocation : 0,
  }));

  return rows.sort((a, b) => b.saved - a.saved);
}

/** Department-wide totals for the headline figures on the savings tab. */
export function savingsTotals(regions) {
  return regions.reduce((totals, region) => ({
    allocation: totals.allocation + region.allocation,
    committed: totals.committed + region.committed,
    paid: totals.paid + region.paid,
    saved: totals.saved + region.saved,
    staff: totals.staff + region.staff,
    claimCount: totals.claimCount + region.claimCount,
  }), { allocation: 0, committed: 0, paid: 0, saved: 0, staff: 0, claimCount: 0 });
}

/** Groups any claim list by region, used by the manager and HR queues. */
export function groupByRegion(claims) {
  const regions = new Map();
  for (const claim of claims) {
    const key = claim.region || 'Unassigned';
    if (!regions.has(key)) regions.set(key, { region: key, claims: [], total: 0 });
    const region = regions.get(key);
    region.claims.push(claim);
    region.total += claim.amount;
  }
  return [...regions.values()].sort((a, b) => a.region.localeCompare(b.region));
}

function sum(claims) {
  return claims.reduce((total, claim) => total + (Number(claim.amount) || 0), 0);
}
