import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildDirectory } from './sheetConfig.js';

const person = (over) => ({
  name: '', email: '', role: 'field_agent', region: '', zone: '',
  manager1Name: '', manager1Email: '', manager2Name: '', manager2Email: '',
  transportPerCycle: 6000, maxPerCycle: 8000, ...over,
});

test('an approver named only in the manager columns gets a sign-in account', () => {
  const directory = buildDirectory([
    person({ email: 'agent@oneacrefund.org', region: 'Rift Valley', manager1Name: 'Odaba', manager1Email: 'odaba.p@oneacrefund.org' }),
  ]);
  assert.equal(directory.length, 2, 'the claimant plus the approver the sheet names');

  const odaba = directory.find((item) => item.email === 'odaba.p@oneacrefund.org');
  assert.ok(odaba, 'can sign in without a column C row');
  assert.equal(odaba.name, 'Odaba', 'named from column G');
  assert.equal(odaba.role, 'manager');
  assert.equal(odaba.isApprover, true);
  assert.equal(odaba.isStaff, false, 'not a claimant');
  assert.equal(odaba.transportPerCycle, 0, 'no allowance, so nothing to claim against');
  assert.deepEqual(odaba.approvesFor, ['agent@oneacrefund.org']);
  assert.equal(odaba.region, 'Rift Valley', 'shown the region they cover');
});

test('one approver covering several people collects all of them', () => {
  const directory = buildDirectory([
    person({ email: 'a@oneacrefund.org', region: 'Coast', manager1Email: 'boss@oneacrefund.org' }),
    person({ email: 'b@oneacrefund.org', region: 'Nyanza', manager1Email: 'boss@oneacrefund.org' }),
  ]);
  const boss = directory.find((item) => item.email === 'boss@oneacrefund.org');
  assert.deepEqual(boss.approvesFor, ['a@oneacrefund.org', 'b@oneacrefund.org']);
  assert.deepEqual(boss.regions, ['Coast', 'Nyanza']);
});

test('manager 2 is an approver as well', () => {
  const directory = buildDirectory([
    person({ email: 'a@oneacrefund.org', manager1Email: 'one@oneacrefund.org', manager2Name: 'Two', manager2Email: 'two@oneacrefund.org' }),
  ]);
  assert.equal(directory.find((item) => item.email === 'two@oneacrefund.org').isApprover, true);
});

test('a claimant who also approves keeps their own row, budget and role', () => {
  const directory = buildDirectory([
    person({ email: 'a@oneacrefund.org', manager1Email: 'hr@oneacrefund.org' }),
    person({ email: 'hr@oneacrefund.org', role: 'hr', transportPerCycle: 5000, region: 'HQ' }),
  ]);
  const hr = directory.find((item) => item.email === 'hr@oneacrefund.org');
  assert.equal(directory.length, 2, 'not duplicated');
  assert.equal(hr.role, 'hr', 'an explicit role is never downgraded to manager');
  assert.equal(hr.isStaff, true);
  assert.equal(hr.isApprover, true);
  assert.equal(hr.transportPerCycle, 5000, 'their own budget survives');
});

test('a plain claimant is not made an approver', () => {
  const [agent] = buildDirectory([person({ email: 'agent@oneacrefund.org', manager1Email: 'boss@oneacrefund.org' })]);
  assert.equal(agent.role, 'field_agent');
  assert.equal(agent.isApprover, false);
  assert.equal(agent.isStaff, true);
});

test('blank and malformed manager cells are ignored', () => {
  const directory = buildDirectory([
    person({ email: 'a@oneacrefund.org', manager1Email: '', manager2Email: '   ' }),
    person({ email: 'b@oneacrefund.org', manager1Email: 'not-an-email' }),
  ]);
  assert.equal(directory.length, 2, 'no phantom accounts');
});

test('an approver with no name in the sheet falls back to their address stem', () => {
  const directory = buildDirectory([person({ email: 'a@oneacrefund.org', manager1Email: 'lecian.o@oneacrefund.org' })]);
  assert.equal(directory.find((item) => item.email === 'lecian.o@oneacrefund.org').name, 'lecian.o');
});
