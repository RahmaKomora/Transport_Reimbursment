import { strict as assert } from 'node:assert';
import test from 'node:test';
import { classify, cycleLedger } from './budget.js';
import { STATUS, routeClaim } from './routing.js';

// Rahma's real sheet row: 15,000 a month, 7,500 a cycle, 3,000 top-up, 10,500 maximum.
const rahma = {
  email: 'rahma.komora@oneacrefund.org',
  transportPerCycle: 7500,
  extraAllowancePerCycle: 3000,
  maxPerCycle: 10500,
  manager1Email: 'odaba.p@oneacrefund.org',
  manager2Email: 'ashioya.b@oneacrefund.org',
};
const CYCLE = '2026-09-C2';
const spent = (amount, over = {}) => ({ submittedBy: rahma.email, cycleKey: CYCLE, amount, status: STATUS.APPROVED, ...over });
const ledgerAfter = (claims) => cycleLedger(rahma, claims, CYCLE);
const route = (amount, claims) => routeClaim({ amount, user: rahma, ledger: ledgerAfter(claims) });

test('the allowance is a wallet that draws down claim by claim', () => {
  assert.equal(ledgerAfter([]).baseRemaining, 7500);
  assert.equal(ledgerAfter([spent(100)]).baseRemaining, 7400, 'a 100 piki fare');
  assert.equal(ledgerAfter([spent(100), spent(500)]).baseRemaining, 6900, 'then a 500 matatu fare');
});

test('anything inside the remaining allowance is approved on the spot', () => {
  const result = route(100, []);
  assert.equal(result.status, STATUS.APPROVED);
  assert.equal(result.approvalSource, 'system');
  assert.match(result.reason, /leaves 7400/);
});

test('once the allowance is spent, the top-up needs a manager', () => {
  const drained = [spent(7500)];
  assert.equal(ledgerAfter(drained).baseRemaining, 0);
  assert.equal(ledgerAfter(drained).topUpRemaining, 3000);

  const result = route(1000, drained);
  assert.equal(result.status, STATUS.PENDING_MANAGER);
  assert.equal(result.band, 'topup');
  assert.equal(result.assignedTo, 'odaba.p@oneacrefund.org');
  assert.match(result.reason, /used up/);
});

test('a claim straddling the allowance and the top-up is not split', () => {
  // 200 left of the base; a 1,000 claim cannot be part-approved, so the whole thing goes
  // to a manager rather than 200 being waved through.
  const nearlyOut = [spent(7300)];
  const result = route(1000, nearlyOut);
  assert.equal(result.status, STATUS.PENDING_MANAGER);
  assert.equal(result.band, 'topup');
  assert.match(result.reason, /more than the 200 left/);
});

test('the cycle maximum is 10,500 and past it is flagged', () => {
  const nearMax = [spent(10000)];
  assert.equal(ledgerAfter(nearMax).totalRemaining, 500);

  assert.equal(route(500, nearMax).band, 'topup', 'the last 500 is still claimable');
  const over = route(900, nearMax);
  assert.equal(over.band, 'over');
  assert.equal(over.overBudget, true);
  assert.equal(over.status, STATUS.PENDING_MANAGER, 'still submitted, not refused');
  assert.match(over.reason, /400 above/);
});

test('five claims of 7,500 no longer pass as five separate claims', () => {
  // The old per-claim check let this through: 37,500 against a 7,500 cycle.
  let claims = [];
  const outcomes = [];
  for (let i = 0; i < 5; i += 1) {
    const result = route(7500, claims);
    outcomes.push(result.band);
    claims = [...claims, spent(7500, { status: result.status })];
  }
  assert.deepEqual(outcomes, ['auto', 'over', 'over', 'over', 'over']);
});

test('pending claims hold their share of the wallet', () => {
  // Otherwise 7,000 awaiting approval leaves 7,500 still auto-approvable.
  const waiting = [spent(7000, { status: STATUS.PENDING_MANAGER })];
  const ledger = ledgerAfter(waiting);
  assert.equal(ledger.baseRemaining, 500);
  assert.equal(ledger.awaiting, 7000);
  assert.equal(route(1000, waiting).band, 'topup');
});

test('a rejected claim releases the money it was holding', () => {
  const rejected = [spent(7000, { status: STATUS.REJECTED })];
  assert.equal(ledgerAfter(rejected).baseRemaining, 7500);
  assert.equal(route(1000, rejected).band, 'auto');
});

test('last cycle does not eat this cycle', () => {
  const lastCycle = [spent(7500, { cycleKey: '2026-09-C1' })];
  assert.equal(ledgerAfter(lastCycle).baseRemaining, 7500);
});

test('saved is what is left of the allowance, for the manager view', () => {
  assert.equal(ledgerAfter([spent(2500)]).saved, 5000);
  assert.equal(ledgerAfter([spent(9000)]).saved, 0, 'never negative once into the top-up');
  assert.equal(ledgerAfter([spent(9000)]).usingTopUp, true);
});

test('classify rejects nonsense before any of this matters', () => {
  assert.equal(classify(0, ledgerAfter([])), 'invalid');
  assert.equal(classify(Number.NaN, ledgerAfter([])), 'invalid');
  assert.equal(routeClaim({ amount: -5, user: rahma, ledger: ledgerAfter([]) }).blocked, true);
});
