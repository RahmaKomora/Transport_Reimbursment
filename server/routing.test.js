import { strict as assert } from 'node:assert';
import test from 'node:test';
import { STATUS, applyDecision, canAct, pickReviewer, routeClaim } from './routing.js';
import { cycleLedger } from './budget.js';

const CYCLE = '2026-09-C2';
// A fresh wallet, so these tests read the routing rules rather than the balance.
const fresh = (user) => cycleLedger(user, [], CYCLE);

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
  assert.equal(routeClaim({ amount: 5000, user: agent, ledger: fresh(agent) }).status, STATUS.APPROVED);
  const onTheLine = routeClaim({ amount: 6000, user: agent, ledger: fresh(agent) });
  assert.equal(onTheLine.status, STATUS.APPROVED, 'the allowance itself is inclusive');
  assert.equal(onTheLine.assignedTo, 'hr');
});

test('Case B: between the allowance and the ceiling goes to manager 1', () => {
  const result = routeClaim({ amount: 7000, user: agent, ledger: fresh(agent) });
  assert.equal(result.status, STATUS.PENDING_MANAGER);
  assert.equal(result.assignedTo, 'susan.manager@oneacrefund.org');
});

test('Case C: above the ceiling still goes through, flagged for the approver', () => {
  const atLimit = routeClaim({ amount: 8000, user: agent, ledger: fresh(agent) });
  assert.equal(atLimit.overBudget, false, 'the ceiling itself is within budget');

  // Refusing these outright meant an overspend left no record and no manager ever saw it.
  const over = routeClaim({ amount: 8001, user: agent, ledger: fresh(agent) });
  assert.equal(over.blocked, false, 'submission is not refused');
  assert.equal(over.status, STATUS.PENDING_MANAGER);
  assert.equal(over.assignedTo, 'susan.manager@oneacrefund.org');
  assert.equal(over.overBudget, true);
  assert.equal(over.ceiling, 8000, 'the limit it breached travels with the claim');
  assert.match(over.reason, /over budget/);
});

test('a ceiling below the allowance never becomes a silent auto-approval', () => {
  // A misconfigured row: the maximum is lower than the per-cycle allowance. The claim must
  // still land with a person rather than being waved through on the base allowance.
  const odd = { ...agent, transportPerCycle: 9000, extraAllowancePerCycle: 0, maxPerCycle: 5000 };
  const result = routeClaim({ amount: 6000, user: odd, ledger: cycleLedger(odd, [], CYCLE) });
  assert.equal(result.status, STATUS.PENDING_MANAGER);
  assert.equal(result.overBudget, true);
});

test('a manager submitting their own claim skips themselves and goes to manager 2', () => {
  const manager = { ...agent, email: agent.manager1Email, role: 'manager' };
  const result = routeClaim({ amount: 7000, user: manager, ledger: fresh(manager) });
  assert.equal(result.assignedTo, 'peter.manager@oneacrefund.org');
});

test('a manager with no second approver is left unassigned, not handed to HR', () => {
  // HR collects approved claims for payment; they do not approve. Routing there would
  // park the claim with someone who will not act on it.
  const manager = { ...agent, email: agent.manager1Email, manager2Email: '', role: 'manager' };
  const result = routeClaim({ amount: 7000, user: manager, ledger: fresh(manager) });
  assert.equal(result.assignedTo, '');
  assert.match(result.reason, /administrator to assign one/);
});

test('HR cannot approve a claim, only an approver or an admin can', () => {
  const claim = { status: STATUS.PENDING_MANAGER, submittedBy: 'a@oneacrefund.org', region: 'Coast', assignedTo: '' };
  const hr = { email: 'hr@oneacrefund.org', role: 'hr', isApprover: false, regions: [], approvesFor: [] };
  const check = canAct(hr, claim, 'approve');
  assert.equal(check.allowed, false);
  assert.match(check.reason, /Approvals are made by managers/);

  const manager = { email: 'm@oneacrefund.org', role: 'manager', regions: ['Coast'], approvesFor: [] };
  assert.equal(canAct(manager, claim, 'approve').allowed, true);
  assert.equal(canAct({ email: 'a@x.org', role: 'admin' }, claim, 'approve').allowed, true, 'admin is everything');
});

test('an out of office manager 1 diverts to manager 2', () => {
  const result = routeClaim({ amount: 7000, user: { ...agent, manager1OutOfOffice: true }, ledger: fresh({ ...agent, manager1OutOfOffice: true }) });
  assert.equal(result.assignedTo, 'peter.manager@oneacrefund.org');
});

test('self-approval never routes a claim back to the person who submitted it', () => {
  const lonely = { ...agent, email: agent.manager1Email, manager2Email: agent.manager1Email };
  assert.equal(pickReviewer(lonely).email, '', 'unassigned rather than back to themselves');
});

test('a blank maximum falls back to allowance plus top-up', () => {
  const unconfigured = { ...agent, maxPerCycle: 0, extraAllowancePerCycle: 2000 };
  const ledger = cycleLedger(unconfigured, [], CYCLE);
  assert.equal(ledger.max, 8000, '6000 allowance + 2000 top-up');
  assert.equal(routeClaim({ amount: 99000, user: unconfigured, ledger }).blocked, false, 'still submitted, never refused');
});

test('zero and nonsense amounts are rejected', () => {
  assert.equal(routeClaim({ amount: 0, user: agent, ledger: fresh(agent) }).blocked, true);
  assert.equal(routeClaim({ amount: Number.NaN, user: agent, ledger: fresh(agent) }).blocked, true);
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

test('only HR marks a claim completed, and only an approved one', () => {
  const hr = { email: 'hr@oneacrefund.org', role: 'hr' };
  for (const status of [STATUS.APPROVED, STATUS.BATCHED_FOR_HR]) {
    assert.equal(canAct(hr, { status, submittedBy: 'a@b.c' }, 'complete').allowed, true, status);
  }
  assert.equal(canAct({ email: 'm@oneacrefund.org', role: 'manager' }, { status: STATUS.BATCHED_FOR_HR, submittedBy: 'a@b.c' }, 'complete').allowed, false);
  assert.equal(canAct(hr, { status: STATUS.PENDING_MANAGER, submittedBy: 'a@b.c' }, 'complete').allowed, false);
  assert.equal(canAct(hr, { status: STATUS.REJECTED, submittedBy: 'a@b.c' }, 'complete').allowed, false);
  assert.equal(canAct(hr, { status: STATUS.COMPLETED, submittedBy: 'a@b.c' }, 'complete').allowed, false, 'not twice');
});

test('completing records who marked it and when', () => {
  const done = applyDecision({ status: STATUS.BATCHED_FOR_HR, decisionLog: [] }, { actor: 'hr@oneacrefund.org', action: 'complete', note: 'Paid 30 Sept run' });
  assert.equal(done.status, STATUS.COMPLETED);
  assert.equal(done.completedBy, 'hr@oneacrefund.org');
  assert.ok(done.completedAt);
  assert.equal(done.decisionLog.at(-1).note, 'Paid 30 Sept run');
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
  assert.equal(routeClaim({ amount: 5000, user: agent, ledger: fresh(agent) }).approvalSource, 'system');
});
