import { strict as assert } from 'node:assert';
import test from 'node:test';
import { STATUS } from './routing.js';
import { cycleOf, savingsByRegion, savingsForUser, savingsTotals } from './savings.js';

const user = { email: 'a@oneacrefund.org', name: 'A', region: 'Nyanza', zone: 'Kisumu', transportPerCycle: 6000 };
const other = { email: 'b@oneacrefund.org', name: 'B', region: 'Nyanza', zone: 'Siaya', transportPerCycle: 4000 };
const claim = (over) => ({ submittedBy: user.email, submittedAt: '2026-09-10T09:00:00.000Z', amount: 0, status: STATUS.APPROVED, ...over });

test('budget cycles are the half-month reimbursement cycles', () => {
  assert.equal(cycleOf('2026-09-10T09:00:00.000Z'), '2026-09-C1');
  assert.equal(cycleOf('2026-09-20T09:00:00.000Z'), '2026-09-C2');
});

test('saved is the allocation less approved and paid claims', () => {
  const claims = [claim({ amount: 2000 }), claim({ amount: 1500, status: STATUS.COMPLETED })];
  const row = savingsForUser(user, claims, '2026-09-C1');
  assert.equal(row.committed, 3500);
  assert.equal(row.paid, 1500);
  assert.equal(row.saved, 2500);
});

test('claims still awaiting a manager do not eat the budget', () => {
  const claims = [claim({ amount: 5000, status: STATUS.PENDING_MANAGER })];
  assert.equal(savingsForUser(user, claims, '2026-09-C1').saved, 6000);
});

test('rejected claims do not eat the budget', () => {
  const claims = [claim({ amount: 5000, status: STATUS.REJECTED })];
  assert.equal(savingsForUser(user, claims, '2026-09-C1').saved, 6000);
});

test('nothing rolls over: last cycle is invisible to this one', () => {
  const claims = [claim({ amount: 6000, submittedAt: '2026-08-10T09:00:00.000Z' })];
  const row = savingsForUser(user, claims, '2026-09-C1');
  assert.equal(row.committed, 0);
  assert.equal(row.saved, 6000, 'a fully spent August does not reduce September');
});

test('regional rollup sums its people and reports utilisation', () => {
  const claims = [claim({ amount: 3000 }), claim({ submittedBy: other.email, amount: 4000 })];
  const [nyanza] = savingsByRegion([user, other], claims, '2026-09-C1');
  assert.equal(nyanza.region, 'Nyanza');
  assert.equal(nyanza.allocation, 10000);
  assert.equal(nyanza.committed, 7000);
  assert.equal(nyanza.saved, 3000);
  assert.equal(nyanza.staff, 2);
  assert.equal(nyanza.utilisation, 0.7);
});

test('department totals add the regions up', () => {
  const claims = [claim({ amount: 3000 })];
  const totals = savingsTotals(savingsByRegion([user, other], claims, '2026-09-C1'));
  assert.equal(totals.allocation, 10000);
  assert.equal(totals.saved, 7000);
});
