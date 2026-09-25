import { strict as assert } from 'node:assert';
import test from 'node:test';
import { STATUS, applyDecision, canAct, statusCounts, visibleToManager } from './routing.js';

const claim = (over) => ({ id: 'x', submittedBy: 'a@oneacrefund.org', region: 'Rift Valley', assignedTo: '', status: STATUS.PENDING_MANAGER, ...over });

const westernManager = {
  email: 'west@oneacrefund.org', role: 'manager',
  regions: ['Lower Western'], approvesFor: ['ian@oneacrefund.org'],
};

test('a regional manager sees their region and nobody else’s', () => {
  const claims = [
    claim({ id: 'west', region: 'Lower Western', submittedBy: 'ian@oneacrefund.org' }),
    claim({ id: 'coast', region: 'Coast', submittedBy: 'someone@oneacrefund.org' }),
    claim({ id: 'rift', region: 'Rift Valley', submittedBy: 'other@oneacrefund.org' }),
  ];
  const visible = visibleToManager(claims, westernManager).map((c) => c.id);
  assert.deepEqual(visible, ['west']);
});

test('a claim from one of their people is visible even if the region is blank', () => {
  const claims = [claim({ id: 'noregion', region: '', submittedBy: 'ian@oneacrefund.org' })];
  assert.equal(visibleToManager(claims, westernManager).length, 1);
});

test('a claim routed to them is visible even from a region they do not cover', () => {
  const claims = [claim({ id: 'elsewhere', region: 'Nyanza', submittedBy: 'x@oneacrefund.org', assignedTo: 'west@oneacrefund.org' })];
  assert.equal(visibleToManager(claims, westernManager).length, 1, 'otherwise they could never act on it');
});

test('a manager covering two regions sees both, and only those', () => {
  const twoRegions = { ...westernManager, regions: ['Coast', 'Nyanza'], approvesFor: [] };
  const claims = [claim({ id: 'c', region: 'Coast' }), claim({ id: 'n', region: 'Nyanza' }), claim({ id: 'r', region: 'Rift Valley' })];
  assert.deepEqual(visibleToManager(claims, twoRegions).map((c) => c.id), ['c', 'n']);
});

test('HR and admin see everything — that is what makes their view global', () => {
  const claims = [claim({ id: 'a', region: 'Coast' }), claim({ id: 'b', region: 'Nyanza' })];
  for (const role of ['hr', 'admin']) {
    assert.equal(visibleToManager(claims, { email: 'x@oneacrefund.org', role, regions: [] }).length, 2, role);
  }
});

test('a manager with no regions and no reports sees nothing, not everything', () => {
  const orphan = { email: 'new@oneacrefund.org', role: 'manager', regions: [], approvesFor: [] };
  assert.equal(visibleToManager([claim({}), claim({})], orphan).length, 0, 'failing open would leak every region');
});

test('the summary cards count each status once', () => {
  const counts = statusCounts([
    claim({ status: STATUS.PENDING_MANAGER }),
    claim({ status: STATUS.PENDING_MANAGER }),
    claim({ status: STATUS.APPROVED }),
    claim({ status: STATUS.BATCHED_FOR_HR }),
    claim({ status: STATUS.COMPLETED }),
    claim({ status: STATUS.REJECTED }),
  ]);
  assert.equal(counts.pending, 2);
  assert.equal(counts.approved, 3, 'batched and paid claims are still approvals');
  assert.equal(counts.rejected, 1);
  assert.equal(counts.total, 6);
});

test('any approver who can see a claim may decide it, not just the assignee', () => {
  const claim = {
    status: STATUS.PENDING_MANAGER, submittedBy: 'ian@oneacrefund.org',
    region: 'Lower Western', assignedTo: 'first@oneacrefund.org',
  };
  // Manager 2 covers the same region but the claim was routed to Manager 1. Before this,
  // they saw it in their queue and were told it belonged to someone else.
  const second = { email: 'second@oneacrefund.org', role: 'manager', regions: ['Lower Western'], approvesFor: [] };
  const check = canAct(second, claim, 'approve');
  assert.equal(check.allowed, true, 'the queue must not be a dead end when the assignee is away');
});

test('an approver from another region still cannot touch it', () => {
  const claim = { status: STATUS.PENDING_MANAGER, submittedBy: 'ian@oneacrefund.org', region: 'Coast', assignedTo: 'first@oneacrefund.org' };
  const outsider = { email: 'other@oneacrefund.org', role: 'manager', regions: ['Nyanza'], approvesFor: [] };
  assert.equal(canAct(outsider, claim, 'approve').allowed, false);
});

test('a decided claim cannot be decided again', () => {
  const manager = { email: 'm@oneacrefund.org', role: 'manager', regions: ['Coast'], approvesFor: [] };
  for (const status of [STATUS.APPROVED, STATUS.REJECTED, STATUS.BATCHED_FOR_HR, STATUS.COMPLETED]) {
    const check = canAct(manager, { status, submittedBy: 'a@b.c', region: 'Coast' }, 'approve');
    assert.equal(check.allowed, false, status);
    assert.match(check.reason, /already been decided/);
  }
});

test('reviewing your own claim stays forbidden, region or not', () => {
  const manager = { email: 'm@oneacrefund.org', role: 'manager', regions: ['Coast'], approvesFor: [] };
  const own = { status: STATUS.PENDING_MANAGER, submittedBy: 'm@oneacrefund.org', region: 'Coast' };
  assert.equal(canAct(manager, own, 'approve').allowed, false);
});

/* ---- reopening and flagging a decided claim ---- */

const approver = { email: 'boss@oneacrefund.org', role: 'manager', regions: ['Coast'], approvesFor: [] };
const settled = (over) => ({ status: STATUS.APPROVED, submittedBy: 'a@oneacrefund.org', region: 'Coast', decisionLog: [], ...over });

test('an approved claim can be pulled back for review', () => {
  // Auto-approval means most claims are never read by a person. Without this, noticing
  // something afterwards leaves nothing to do about it.
  const check = canAct(approver, settled({}), 'reopen');
  assert.equal(check.allowed, true);

  const reopened = applyDecision(settled({}), { actor: approver.email, action: 'reopen', note: 'Distance looks wrong' });
  assert.equal(reopened.status, STATUS.PENDING_MANAGER);
  assert.equal(reopened.assignedTo, approver.email);
  assert.equal(reopened.approvalSource, '', 'the earlier approval no longer stands');
  assert.equal(reopened.decisionLog.at(-1).note, 'Distance looks wrong');
});

test('a paid claim is flagged, not reopened', () => {
  const paid = settled({ status: STATUS.COMPLETED });
  const reopen = canAct(approver, paid, 'reopen');
  assert.equal(reopen.allowed, false);
  assert.match(reopen.reason, /already been paid/);
  assert.equal(canAct(approver, paid, 'flag').allowed, true, 'but it can still be questioned');
});

test('flagging records who raised it and why, without changing the claim', () => {
  const flagged = applyDecision(settled({}), { actor: approver.email, action: 'flag', note: 'Third claim this week' });
  assert.equal(flagged.status, STATUS.APPROVED, 'state is untouched');
  assert.equal(flagged.reviewFlag.by, approver.email);
  assert.equal(flagged.reviewFlag.note, 'Third claim this week');
  assert.equal(applyDecision(flagged, { actor: approver.email, action: 'unflag' }).reviewFlag, null);
});

test('a claim already awaiting review cannot be reopened again', () => {
  assert.equal(canAct(approver, settled({ status: STATUS.PENDING_MANAGER }), 'reopen').allowed, false);
});

test('nobody reopens their own claim, and nobody touches another region', () => {
  assert.equal(canAct({ ...approver, email: 'a@oneacrefund.org' }, settled({}), 'reopen').allowed, false);
  const outsider = { email: 'x@oneacrefund.org', role: 'manager', regions: ['Nyanza'], approvesFor: [] };
  assert.equal(canAct(outsider, settled({}), 'reopen').allowed, false);
  assert.equal(canAct(outsider, settled({}), 'flag').allowed, false);
});
