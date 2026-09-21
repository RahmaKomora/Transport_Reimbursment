import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';
import { setStoreForTests } from './googleSheetsService.js';
import { invalidate } from './sheetConfig.js';
import { getCycleDetails } from './cycles.js';

// An in-memory stand-in for the spreadsheet. This is a test double for the transport, not
// a stored permission set: the running app has no such list and refuses to start without
// real credentials.
function makeStore(users) {
  const claims = [];
  return {
    users,
    claims,
    readUsers: async () => users,
    readClaims: async () => claims.slice(),
    appendClaim: async (claim) => { claims.push(claim); return claim; },
    updateClaim: async (id, mutate) => {
      const index = claims.findIndex((claim) => claim.id === id);
      if (index === -1) return null;
      claims[index] = mutate(claims[index]);
      return claims[index];
    },
  };
}

const person = (over) => ({
  name: 'Test Person', email: '', zone: 'Zone', roleLabel: '', role: 'field_agent', region: 'Nyanza',
  manager1Email: '', manager2Email: '', transportMonth: 0, transportPerCycle: 6000,
  extraAllowancePerCycle: 0, maxPerCycle: 8000, manager1OutOfOffice: false, ...over,
});

let store;
let server;
let base;

before(async () => {
  store = makeStore([
    person({ name: 'Agent', email: 'agent@oneacrefund.org', manager1Email: 'boss@oneacrefund.org', manager2Email: 'big@oneacrefund.org' }),
    person({ name: 'Boss', email: 'boss@oneacrefund.org', role: 'manager', manager1Email: 'boss@oneacrefund.org', manager2Email: 'big@oneacrefund.org' }),
    person({ name: 'Big', email: 'big@oneacrefund.org', role: 'manager' }),
    person({ name: 'People', email: 'hr@oneacrefund.org', role: 'hr' }),
  ]);
  setStoreForTests(store);
  invalidate();
  process.env.SONGA_DISABLE_SCHEDULER = 'true';
  const { app } = await import('./index.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${server.address().port}/api`;
});

after(() => { server?.close(); setStoreForTests(null); });

const call = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const login = async (email) => (await call('/auth/login', { method: 'POST', body: { email } })).body.token;

test('a session binds role and budget from the sheet, not from the token', async () => {
  const token = await login('agent@oneacrefund.org');
  const before = await call('/me', { token });
  assert.equal(before.body.user.role, 'field_agent');
  assert.equal(before.body.budget.allocation, 6000);

  // Promote them in the "sheet" and force a resync, as the refresh button does.
  store.users[0].role = 'hr';
  store.users[0].transportPerCycle = 9000;
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });

  const after = await call('/me', { token });
  assert.equal(after.body.user.role, 'hr', 'the same session now reads the new role');
  assert.equal(after.body.budget.allocation, 9000, 'and the new budget');

  // A role granted in the sheet immediately opens the HR view, with no re-login.
  assert.equal((await call('/claims/live', { token })).status, 200);

  store.users[0].role = 'field_agent';
  store.users[0].transportPerCycle = 6000;
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });
  assert.equal((await call('/claims/live', { token })).status, 403, 'and revoking it closes the view again');
});

test('refresh reports what the sheet contains', async () => {
  const hr = await login('hr@oneacrefund.org');
  const { status, body } = await call('/admin/refresh', { method: 'POST', token: hr });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.userCount, 4);
  assert.equal(body.roles.field_agent, 1);
  assert.equal(body.roles.manager, 2);
  assert.equal(body.regions.Nyanza, 4);
  assert.ok(body.syncedAt);
});

test('refresh flags rows that will behave oddly', async () => {
  store.users.push(person({ name: 'Unconfigured', email: 'nobudget@oneacrefund.org', transportPerCycle: 0, maxPerCycle: 0 }));
  const { body } = await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });
  const issues = body.warnings.map((warning) => warning.issue).join(' | ');
  assert.match(issues, /auto-approve/);
  assert.match(issues, /ceiling/);
  store.users.pop();
});

test('only HR and admin can force a refresh', async () => {
  const agent = await login('agent@oneacrefund.org');
  assert.equal((await call('/admin/refresh', { method: 'POST', token: agent })).status, 403);
  assert.equal((await call('/admin/refresh', { method: 'POST' })).status, 401);
});

test('a claim routes against the budget currently in the sheet', async () => {
  const token = await login('agent@oneacrefund.org');
  const submit = (amount) => call('/claims', { method: 'POST', body: { amount, km: 10, rate: 25, estimate: 250, vehicle: 'Piki', purposes: ['Farmer Visit'] }, token });

  const auto = await submit(5000);
  assert.equal(auto.body.claim.status, 'Approved');
  assert.equal(auto.body.claim.approvalSource, 'system');
  assert.equal(auto.body.claim.cycleKey, getCycleDetails().key);

  // Raise the allowance in the sheet: a claim that needed a manager now auto-approves.
  store.users[0].transportPerCycle = 7500;
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });
  assert.equal((await submit(7000)).body.claim.status, 'Approved');

  store.users[0].transportPerCycle = 6000;
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });
  const needsReview = await submit(7000);
  assert.equal(needsReview.body.claim.status, 'Pending Manager Review');
  assert.equal(needsReview.body.claim.assignedTo, 'boss@oneacrefund.org');
});

test('a manager reassigned in the sheet changes where new claims go', async () => {
  const token = await login('agent@oneacrefund.org');
  store.users[0].manager1Email = 'big@oneacrefund.org';
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });
  const claim = await call('/claims', { method: 'POST', body: { amount: 7000, km: 10, rate: 25, vehicle: 'Piki', purposes: ['x'] }, token });
  assert.equal(claim.body.claim.assignedTo, 'big@oneacrefund.org');
});

test('an email that is not in the sheet cannot sign in', async () => {
  const attempt = await call('/auth/login', { method: 'POST', body: { email: 'stranger@example.com' } });
  assert.equal(attempt.status, 401);
  assert.match(attempt.body.error, /not in the staff sheet/);
});
