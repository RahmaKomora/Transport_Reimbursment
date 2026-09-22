import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildAlerts } from './alerts.js';
import { STATUS } from './routing.js';
import { getCycleDetails } from './cycles.js';

const cycle = getCycleDetails('2026-09-20T06:00:00Z');   // Cycle 2, seals 1 Oct 08:00 EAT
const farOff = new Date('2026-09-20T06:00:00Z');          // 11 days before the seal
const nearly = new Date('2026-09-30T06:00:00Z');          // about a day before it

const manager = { email: 'boss@oneacrefund.org', role: 'manager', isApprover: true, regions: ['Coast'], approvesFor: ['a@oneacrefund.org'] };
const claim = (over) => ({ id: 'c', submittedBy: 'a@oneacrefund.org', region: 'Coast', amount: 5000, ceiling: 8000, status: STATUS.PENDING_MANAGER, submittedAt: '2026-09-19T06:00:00Z', ...over });

test('a manager is told how many are waiting, and counts them for the badge', () => {
  const alerts = buildAlerts(manager, [claim({ id: '1' }), claim({ id: '2' })], cycle, farOff);
  assert.equal(alerts.actionCount, 2);
  assert.match(alerts.items[0].title, /2 claims waiting for your approval/);
});

test('the tone sharpens as the cycle deadline approaches', () => {
  assert.equal(buildAlerts(manager, [claim({})], cycle, farOff).items[0].tone, 'warn');
  const urgent = buildAlerts(manager, [claim({})], cycle, nearly).items[0];
  assert.equal(urgent.tone, 'urgent');
  assert.match(urgent.body, /misses this payment run/);
});

test('an empty queue says so instead of going silent', () => {
  const alerts = buildAlerts(manager, [], cycle, farOff);
  assert.equal(alerts.actionCount, 0);
  assert.match(alerts.items[0].title, /Nothing waiting on you/);
});

test('over-budget claims get their own line', () => {
  const alerts = buildAlerts(manager, [claim({ amount: 9000, ceiling: 8000 })], cycle, farOff);
  assert.ok(alerts.items.some((item) => item.id === 'over-budget'));
});

test('claims left sitting for days are surfaced', () => {
  const alerts = buildAlerts(manager, [claim({ submittedAt: '2026-09-10T06:00:00Z' })], cycle, farOff);
  const stale = alerts.items.find((item) => item.id === 'stale');
  assert.ok(stale);
  assert.match(stale.title, /waiting over 3 days/);
});

test('a manager is never nagged about their own claim', () => {
  const own = claim({ submittedBy: manager.email, assignedTo: 'someone@oneacrefund.org' });
  assert.equal(buildAlerts(manager, [own], cycle, farOff).actionCount, 0);
});

test('HR is told what is sealed, what is coming, and what will miss the batch', () => {
  const hr = { email: 'hr@oneacrefund.org', role: 'hr' };
  const alerts = buildAlerts(hr, [
    claim({ id: 'b', status: STATUS.BATCHED_FOR_HR, amount: 4000 }),
    claim({ id: 'a', status: STATUS.APPROVED, amount: 3000 }),
    claim({ id: 'p', status: STATUS.PENDING_MANAGER, amount: 2000 }),
  ], cycle, nearly);

  const ids = alerts.items.map((item) => item.id);
  assert.deepEqual(ids, ['ready', 'incoming', 'chase']);
  assert.equal(alerts.actionCount, 1, 'only the sealed batch needs HR to act');
  assert.match(alerts.items.find((i) => i.id === 'chase').body, /misses this batch/);
});

test('a claimant hears about their own rejections and money owed', () => {
  const agent = { email: 'a@oneacrefund.org', role: 'field_agent', isApprover: false };
  const alerts = buildAlerts(agent, [
    claim({ id: 'r', status: STATUS.REJECTED }),
    claim({ id: 'ok', status: STATUS.APPROVED, amount: 6000 }),
  ], cycle, farOff);
  const ids = alerts.items.map((item) => item.id);
  assert.ok(ids.includes('rejected'));
  assert.ok(ids.includes('unpaid'));
});

test('remaining time reads naturally at each scale', () => {
  const hours = (n) => buildAlerts(manager, [], cycle, new Date(cycle.batchAt.getTime() - n * 3_600_000)).cycle.phrase;
  assert.equal(hours(0.5), 'in under an hour');
  assert.equal(hours(5), 'in 5 hours');
  assert.equal(hours(48), 'in 2 days');
});
