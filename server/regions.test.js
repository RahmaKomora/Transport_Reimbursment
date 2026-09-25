import { strict as assert } from 'node:assert';
import test from 'node:test';
import { regionalSummary } from './regions.js';
import { STATUS } from './routing.js';

const CYCLE = '2026-09-C2';
const staff = (region, base, over = {}) => ({ isStaff: true, region, transportPerCycle: base, extraAllowancePerCycle: 1000, email: `${region}-${base}@x.org`, ...over });
const claim = (region, amount, status, over = {}) => ({ region, amount, status, cycleKey: CYCLE, submittedAt: '2026-09-20T06:00:00Z', ...over });

test('allocation is the sum of the base allowances of the staff in that region', () => {
  const { regions } = regionalSummary([staff('Coast', 7500), staff('Coast', 3000), staff('Nyanza', 6000)], [], CYCLE);
  assert.equal(regions.find((r) => r.region === 'Coast').allocation, 10500);
  assert.equal(regions.find((r) => r.region === 'Coast').staff, 2);
  assert.equal(regions.find((r) => r.region === 'Nyanza').allocation, 6000);
});

test('claims are split into approved, pending and rejected', () => {
  const { regions } = regionalSummary([staff('Coast', 7500)], [
    claim('Coast', 1000, STATUS.APPROVED),
    claim('Coast', 2000, STATUS.BATCHED_FOR_HR),
    claim('Coast', 500, STATUS.COMPLETED),
    claim('Coast', 800, STATUS.PENDING_MANAGER),
    claim('Coast', 400, STATUS.REJECTED),
  ], CYCLE);
  const coast = regions[0];
  assert.equal(coast.approved.amount, 3500, 'batched and paid still count as approved');
  assert.equal(coast.approved.count, 3);
  assert.equal(coast.paid.amount, 500);
  assert.equal(coast.pending.amount, 800);
  assert.equal(coast.rejected.amount, 400, 'rejected is reported but never committed');
});

test('unspent excludes rejected but counts pending as spent', () => {
  const { regions } = regionalSummary([staff('Coast', 10000)], [
    claim('Coast', 3000, STATUS.APPROVED),
    claim('Coast', 2000, STATUS.PENDING_MANAGER),
    claim('Coast', 5000, STATUS.REJECTED),
  ], CYCLE);
  assert.equal(regions[0].committed, 5000);
  assert.equal(regions[0].unspent, 5000, 'the rejected 5,000 is back in the budget');
  assert.equal(regions[0].utilisation, 0.5);
});

test('regions with claims waiting are listed first, since that is HR’s worklist', () => {
  const { regions } = regionalSummary(
    [staff('Quiet', 5000), staff('Busy', 5000)],
    [claim('Busy', 100, STATUS.PENDING_MANAGER), claim('Busy', 200, STATUS.PENDING_MANAGER)],
    CYCLE,
  );
  assert.equal(regions[0].region, 'Busy');
  assert.equal(regions[0].pending.count, 2);
});

test('the oldest pending claim is reported, so HR knows who to chase', () => {
  const { regions } = regionalSummary([staff('Coast', 5000)], [
    claim('Coast', 100, STATUS.PENDING_MANAGER, { submittedAt: '2026-09-22T06:00:00Z' }),
    claim('Coast', 200, STATUS.PENDING_MANAGER, { submittedAt: '2026-09-18T06:00:00Z' }),
  ], CYCLE);
  assert.equal(regions[0].pending.oldest, '2026-09-18T06:00:00Z');
});

test('another cycle does not leak in', () => {
  const { regions, totals } = regionalSummary([staff('Coast', 5000)], [claim('Coast', 900, STATUS.APPROVED, { cycleKey: '2026-09-C1' })], CYCLE);
  assert.equal(regions[0].approved.amount, 0);
  assert.equal(totals.approved, 0);
});

test('a region with staff but no claims still appears, showing its full allowance unspent', () => {
  const { regions } = regionalSummary([staff('Quiet', 4000)], [], CYCLE);
  assert.equal(regions[0].unspent, 4000);
  assert.equal(regions[0].utilisation, 0);
});

test('totals add the regions up', () => {
  const { totals } = regionalSummary([staff('Coast', 5000), staff('Nyanza', 5000)], [
    claim('Coast', 1000, STATUS.APPROVED),
    claim('Nyanza', 500, STATUS.PENDING_MANAGER),
  ], CYCLE);
  assert.equal(totals.allocation, 10000);
  assert.equal(totals.approved, 1000);
  assert.equal(totals.pending, 500);
  assert.equal(totals.pendingCount, 1);
  assert.equal(totals.unspent, 8500);
});

test('people with no transport allowance are left out of the regional breakdown', () => {
  // HR and approvers hold sheet rows so they can sign in, not because they claim.
  const { regions, totals } = regionalSummary([
    staff('Coast', 5000),
    { isStaff: true, region: '', transportPerCycle: 0, email: 'hr@x.org' },
  ], [], CYCLE);
  assert.equal(regions.length, 1, 'no empty "Unassigned" row');
  assert.equal(regions[0].region, 'Coast');
  assert.equal(totals.staff, 1);
});

test('the breakdown says who its figures leave out', () => {
  // A roster of 1,400 that shows a five-figure budget looks like a broken sum. It is
  // usually most of the roster being deactivated, and the screen has to be able to say so.
  const { totals, excluded } = regionalSummary([
    staff('Coast', 5000),
    staff('Coast', 4000, { active: false }),
    staff('Rift', 3000, { active: false }),
    { isStaff: true, region: 'Rift', transportPerCycle: 0, email: 'hr@x.org' },
  ], [], CYCLE);

  assert.equal(totals.allocation, 5000, 'only the active, funded person counts');
  assert.equal(totals.staff, 1);
  assert.equal(excluded.inactive, 2);
  assert.equal(excluded.noAllowance, 1);
});

test('nobody excluded is reported as nobody, not as a missing field', () => {
  const { excluded } = regionalSummary([staff('Coast', 5000)], [], CYCLE);
  assert.deepEqual(excluded, { inactive: 0, noAllowance: 0 });
});

test('an approver named by others is not counted as an excluded staff member', () => {
  // They have no record of their own, so they are not somebody the allocation is
  // "missing" — counting them would inflate the caveat with people who never claim.
  const { excluded } = regionalSummary([
    staff('Coast', 5000),
    { isStaff: false, isApprover: true, region: 'Coast', transportPerCycle: 0, email: 'boss@x.org' },
  ], [], CYCLE);
  assert.equal(excluded.inactive, 0);
  assert.equal(excluded.noAllowance, 0);
});

test('pending claims are grouped by the approver who has to decide them', () => {
  // The useful question about a region's pending pile is not how much it is but whose
  // desk it is on, because that is the person somebody has to call.
  const users = [
    staff('Coast', 5000, { email: 'a@x.org', manager1Email: 'boss@x.org', manager1Name: 'Big Boss' }),
    staff('Coast', 5000, { email: 'b@x.org', manager1Email: 'boss@x.org', manager1Name: 'Big Boss' }),
  ];
  const { regions } = regionalSummary(users, [
    claim('Coast', 1000, STATUS.PENDING_MANAGER, { assignedTo: 'boss@x.org', submittedAt: '2026-09-18T06:00:00Z' }),
    claim('Coast', 2000, STATUS.PENDING_MANAGER, { assignedTo: 'boss@x.org', submittedAt: '2026-09-20T06:00:00Z' }),
    claim('Coast', 500, STATUS.PENDING_MANAGER, { assignedTo: 'other@x.org' }),
    claim('Coast', 900, STATUS.APPROVED, { assignedTo: 'boss@x.org' }),
  ], CYCLE);

  const [busiest, next] = regions[0].pendingBy;
  assert.equal(busiest.email, 'boss@x.org', 'whoever holds the most comes first');
  assert.equal(busiest.name, 'Big Boss', 'named from the manager fields, not just an address');
  assert.equal(busiest.count, 2, 'approved claims are not pending');
  assert.equal(busiest.amount, 3000);
  assert.equal(busiest.oldest, '2026-09-18T06:00:00Z', 'the longest wait, not the latest');
  assert.equal(next.email, 'other@x.org');
  assert.equal(next.count, 1);
});

test('a pending claim with no approver is reported, not dropped', () => {
  // It will sit until somebody notices, so it is the one bucket that must be visible.
  const { regions } = regionalSummary([staff('Rift', 4000)], [
    claim('Rift', 700, STATUS.PENDING_MANAGER, { assignedTo: '' }),
    claim('Rift', 300, STATUS.PENDING_MANAGER, { assignedTo: 'boss@x.org' }),
  ], CYCLE);

  const buckets = regions[0].pendingBy;
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].email, 'boss@x.org', 'somebody to chase sorts above nobody');
  assert.equal(buckets[1].email, '', 'and the unassigned pile is still listed');
  assert.equal(buckets[1].count, 1);
  assert.equal(regions[0].pending.count, 2, 'both still count as pending for the region');
});

test('a region with nothing pending reports an empty list rather than nothing', () => {
  const { regions } = regionalSummary([staff('Nyanza', 3000)], [
    claim('Nyanza', 500, STATUS.APPROVED),
  ], CYCLE);
  assert.deepEqual(regions[0].pendingBy, []);
});
