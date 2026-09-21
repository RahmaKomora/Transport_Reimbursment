import { strict as assert } from 'node:assert';
import test from 'node:test';
import { STATUS, applyDecision, canAct, pickReviewer, routeClaim } from './routing.js';

const agent = {
  email: 'alex.kiptoo@oneacrefund.org',
  role: 'field_agent',
  manager1Email: 'susan.manager@oneacrefund.org',
  manager2Email: 'peter.manager@oneacrefund.org',
  transportPerCycle: 6000,
  maxPerCycle: 8000,
  manager1OutOfOffice: false,
};

test('Case A: at or under the cycle allowance is approved by the system', () => {
  assert.equal(routeClaim({ amount: 5000, user: agent }).status, STATUS.APPROVED);
  const onTheLine = routeClaim({ amount: 6000, user: agent });
  assert.equal(onTheLine.status, STATUS.APPROVED, 'the allowance itself is inclusive');
  assert.equal(onTheLine.assignedTo, 'hr');
});

test('Case B: between the allowance and the ceiling goes to manager 1', () => {
  const result = routeClaim({ amount: 7000, user: agent });
  assert.equal(result.status, STATUS.PENDING_MANAGER);
  assert.equal(result.assignedTo, 'susan.manager@oneacrefund.org');
});

test('Case C: above the ceiling is blocked, inclusive of the ceiling itself', () => {
  assert.equal(routeClaim({ amount: 8000, user: agent }).blocked, false, 'the ceiling is claimable');
  const over = routeClaim({ amount: 8001, user: agent });
  assert.equal(over.blocked, true);
  assert.equal(over.status, STATUS.BLOCKED);
});

test('a manager submitting their own claim skips themselves and goes to manager 2', () => {
  const manager = { ...agent, email: agent.manager1Email, role: 'manager' };
  const result = routeClaim({ amount: 7000, user: manager });
  assert.equal(result.assignedTo, 'peter.manager@oneacrefund.org');
});

test('a manager with no second approver falls through to HR', () => {
  const manager = { ...agent, email: agent.manager1Email, manager2Email: '', role: 'manager' };
  assert.equal(routeClaim({ amount: 7000, user: manager }).assignedTo, 'hr');
});

test('an out of office manager 1 diverts to manager 2', () => {
  const result = routeClaim({ amount: 7000, user: { ...agent, manager1OutOfOffice: true } });
  assert.equal(result.assignedTo, 'peter.manager@oneacrefund.org');
});

test('self-approval never routes a claim back to the person who submitted it', () => {
  const lonely = { ...agent, email: agent.manager1Email, manager2Email: agent.manager1Email };
  assert.equal(pickReviewer(lonely).email, 'hr');
});

test('a blank ceiling does not lock the claimant out', () => {
  const unconfigured = { ...agent, maxPerCycle: 0 };
  assert.equal(routeClaim({ amount: 99000, user: unconfigured }).blocked, false);
});

test('zero and nonsense amounts are rejected', () => {
  assert.equal(routeClaim({ amount: 0, user: agent }).blocked, true);
  assert.equal(routeClaim({ amount: Number.NaN, user: agent }).blocked, true);
});

test('approving moves a claim to the HR queue', () => {
  const claim = { id: 'x', status: STATUS.PENDING_MANAGER, assignedTo: agent.manager1Email, decisionLog: [] };
  const approved = applyDecision(claim, { actor: agent.manager1Email, action: 'approve' });
  assert.equal(approved.status, STATUS.APPROVED);
  assert.equal(approved.assignedTo, 'hr');
  assert.equal(approved.decisionLog.length, 1);
});

test('nobody can review their own claim, even an admin', () => {
  const claim = { status: STATUS.PENDING_MANAGER, assignedTo: 'hr', submittedBy: 'boss@oneacrefund.org' };
  const check = canAct({ email: 'boss@oneacrefund.org', role: 'admin' }, claim, 'approve');
  assert.equal(check.allowed, false);
});

test('only HR pays, and only claims sealed into a released batch', () => {
  const hr = { email: 'hr@oneacrefund.org', role: 'hr' };
  const batched = { status: STATUS.BATCHED_FOR_HR, submittedBy: 'a@b.c' };
  assert.equal(canAct(hr, batched, 'pay').allowed, true);
  assert.equal(canAct({ email: 'm@oneacrefund.org', role: 'manager' }, batched, 'pay').allowed, false);

  // The whole point of batching: approved claims in the open cycle are visible but not payable.
  const live = { status: STATUS.APPROVED, submittedBy: 'a@b.c' };
  const attempt = canAct(hr, live, 'pay');
  assert.equal(attempt.allowed, false);
  assert.match(attempt.reason, /open cycle/);

  assert.equal(canAct(hr, { status: STATUS.PENDING_MANAGER, submittedBy: 'a@b.c' }, 'pay').allowed, false);
});

test('batching seals an approved claim without touching anything else', () => {
  const claim = { id: 'x', status: STATUS.APPROVED, amount: 5000, decisionLog: [] };
  const sealed = applyDecision(claim, { actor: 'system', action: 'batch', note: 'Cycle 1' });
  assert.equal(sealed.status, STATUS.BATCHED_FOR_HR);
  assert.equal(sealed.amount, 5000);
  assert.equal(sealed.decisionLog.at(-1).action, 'batch');
});

test('an approval records who approved it', () => {
  const claim = { status: STATUS.PENDING_MANAGER, decisionLog: [] };
  assert.equal(applyDecision(claim, { actor: 'susan.manager@oneacrefund.org', action: 'approve' }).approvalSource, 'susan.manager@oneacrefund.org');
  assert.equal(routeClaim({ amount: 5000, user: agent }).approvalSource, 'system');
});
