import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';
import { rmSync } from 'node:fs';
import path from 'node:path';

// Rates come from the database even when the directory is a test double, so point the
// whole run at a throwaway file. Without this a test run edits the development rates.
const DB_FILE = path.join(process.cwd(), 'server', 'data', 'api-test.db');
process.env.SONGA_DB_PATH = DB_FILE;
// These are the throwaway-SQLite tests: a fresh `.db` file opens in a millisecond, which
// is what lets the suite run in about a second. Without this, a connection string in .env
// would send them at the real Postgres instance and rewrite its contents. Deleting
// SONGA_DATABASE_URL instead would not work — db.js loads dotenv, which puts it back.
process.env.SONGA_DB_FORCE_SQLITE = 'true';

import { setStoreForTests } from './store.js';
import { setTokenVerifierForTests } from './auth.js';
import { resetThrottleForTests } from './passwords.js';
import { invalidate } from './directory.js';
import { getCycleDetails } from './cycles.js';

// An in-memory stand-in for the database. This is a test double for the storage layer,
// not a stored permission set: the running app has no such list, and an empty directory
// lets nobody in rather than granting anybody a default role.
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
  // These tests sign in the way the app does when Google sign-in is switched on.
  process.env.SONGA_GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  setStoreForTests(store);
  invalidate();
  // Sign-in goes through Google now, so the tests do too. The verifier is stubbed because
  // a real ID token cannot be minted here; everything it gates is still exercised.
  setTokenVerifierForTests(async (credential) => ({ email: credential, email_verified: true, hd: 'oneacrefund.org' }));
  process.env.SONGA_DISABLE_SCHEDULER = 'true';
  resetThrottleForTests();
  const { app } = await import('./index.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  setStoreForTests(null);
  setTokenVerifierForTests(null);
  delete process.env.SONGA_GOOGLE_CLIENT_ID;
  const { closeDb } = await import('./db.js');
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${DB_FILE}${suffix}`, { force: true }); } catch {} }
});

const call = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const login = async (email) => (await call('/auth/google', { method: 'POST', body: { credential: email } })).body.token;

// M-Pesa codes are validated and de-duplicated, so each submission needs its own.
let codeSeq = 0;
const nextCode = () => `MPESA${String(codeSeq += 1).padStart(5, '0')}`;

test('a session binds role and budget from the directory, not from the token', async () => {
  const token = await login('agent@oneacrefund.org');
  const before = await call('/me', { token });
  assert.equal(before.body.user.role, 'field_agent');
  assert.equal(before.body.budget.allocation, 6000);

  // Promote them in the directory and force a resync, as the refresh button does.
  store.users[0].role = 'hr';
  store.users[0].transportPerCycle = 9000;
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });

  const after = await call('/me', { token });
  assert.equal(after.body.user.role, 'hr', 'the same session now reads the new role');
  assert.equal(after.body.budget.allocation, 9000, 'and the new budget');

  // A role granted by an admin immediately opens the HR view, with no re-login.
  assert.equal((await call('/claims/live', { token })).status, 200);

  store.users[0].role = 'field_agent';
  store.users[0].transportPerCycle = 6000;
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });
  assert.equal((await call('/claims/live', { token })).status, 403, 'and revoking it closes the view again');
});

test('refresh reports what the directory contains', async () => {
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

test('a claim routes against the budget as it currently stands', async () => {
  const token = await login('agent@oneacrefund.org');
  const submit = (amount) => call('/claims', { method: 'POST', body: { amount, km: 10, rate: 25, estimate: 250, vehicle: 'Piki', purposes: ['Farmer Visit'], mpesaCode: nextCode() }, token });

  const auto = await submit(5000);
  assert.equal(auto.body.claim.status, 'Approved');
  assert.equal(auto.body.claim.approvalSource, 'system');
  assert.equal(auto.body.claim.cycleKey, getCycleDetails().key);

  // The wallet is now drawn down: 5000 of the 6000 allowance is gone, so a second claim
  // of 5000 no longer fits and goes to a manager even though it did on its own before.
  const second = await submit(5000);
  assert.equal(second.body.claim.status, 'Pending Manager Review');
  assert.equal(second.body.claim.assignedTo, 'boss@oneacrefund.org');

  // Raising the allowance makes room again.
  store.users[0].transportPerCycle = 20000;
  store.users[0].maxPerCycle = 30000;
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });
  assert.equal((await submit(5000)).body.claim.status, 'Approved');
});

test('a manager reassigned by an admin changes where new claims go', async () => {
  const token = await login('agent@oneacrefund.org');
  store.users[0].manager1Email = 'big@oneacrefund.org';
  await call('/admin/refresh', { method: 'POST', token: await login('hr@oneacrefund.org') });
  const claim = await call('/claims', { method: 'POST', body: { amount: 7000, km: 10, rate: 25, vehicle: 'Piki', purposes: ['x'], mpesaCode: nextCode() }, token });
  assert.equal(claim.body.claim.assignedTo, 'big@oneacrefund.org');
});

test('an address that is not in the directory cannot sign in', async () => {
  const attempt = await call('/auth/google', { method: 'POST', body: { credential: 'stranger@oneacrefund.org' } });
  assert.equal(attempt.status, 401);
  assert.match(attempt.body.error, /Access denied/);
});

test('an email alone no longer signs anybody in', async () => {
  // The old build-phase path: a known address and nothing else. It must be gone, not just
  // hidden behind the Google switch.
  const attempt = await call('/auth/login', { method: 'POST', body: { email: 'agent@oneacrefund.org' } });
  assert.equal(attempt.status, 400);
  assert.equal(attempt.body.token, undefined);
});

const issueCode = async (email, by = 'hr@oneacrefund.org') => {
  const response = await call('/admin/users/setup-codes', { method: 'POST', body: { emails: [email] }, token: await login(by) });
  return { response, code: response.body.issued?.[0]?.code };
};
const setup = (email, code, password) => call('/auth/setup', { method: 'POST', body: { email, code, password } });
const signInWith = (email, password) => call('/auth/login', { method: 'POST', body: { email, password } });

test('a password is set with a setup code from HR, and then signs in', async () => {
  const email = 'agent@oneacrefund.org';
  assert.equal((await signInWith(email, 'not-set-yet-1')).status, 401, 'no password yet');

  const { response, code } = await issueCode(email);
  assert.equal(response.status, 200);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!/[ILO01]/.test(code), 'no characters that are misread when copied by hand');

  assert.equal((await setup(email, 'ABCD-EFGH', 'a-good-passphrase')).status, 401, 'a wrong code');
  assert.equal((await setup(email, code, 'short')).status, 400, 'too short a password');

  // Typed the way people type it off a screen: lower case, with a space for the dash.
  const done = await setup(email, code.toLowerCase().replace('-', ' '), 'a-good-passphrase');
  assert.equal(done.status, 200);
  assert.equal((await call('/me', { token: done.body.token })).status, 200, 'and is signed in');

  const again = await signInWith(email, 'a-good-passphrase');
  assert.equal(again.status, 200);
  assert.ok(again.body.token);

  assert.equal((await setup(email, code, 'another-passphrase')).status, 401, 'the code is spent once used');
});

test('a wrong password and an unknown address get the same answer', async () => {
  const wrong = await signInWith('agent@oneacrefund.org', 'not-the-password');
  const unknown = await signInWith('stranger@oneacrefund.org', 'not-the-password');
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error, unknown.body.error, 'otherwise the form says who has an account');
});

test('resetting a password signs out every session from before it', async () => {
  const email = 'boss@oneacrefund.org';
  const first = await issueCode(email);
  const before = (await setup(email, first.code, 'first-passphrase')).body.token;
  assert.equal((await call('/me', { token: before })).status, 200);

  const second = await issueCode(email);
  // The old password keeps working until the code is used, so issuing one locks nobody out.
  assert.equal((await signInWith(email, 'first-passphrase')).status, 200);
  const after = (await setup(email, second.code, 'second-passphrase')).body.token;

  assert.equal((await call('/me', { token: before })).status, 401, 'the old session is refused');
  assert.equal((await call('/me', { token: after })).status, 200, 'the new one works');
  assert.equal((await signInWith(email, 'first-passphrase')).status, 401, 'and so is the old password');
});

test('five wrong passwords lock the address, even against the right one', async () => {
  const email = 'big@oneacrefund.org';
  const { code } = await issueCode(email);
  await setup(email, code, 'big-passphrase');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await signInWith(email, `guess-${attempt}-wrong`)).status, 401);
  }
  const locked = await signInWith(email, 'big-passphrase');
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /Too many attempts/);
});

test('HR cannot issue a setup code for an admin', async () => {
  // Otherwise HR could reset an admin's password, sign in as them and grant themselves
  // anything. An admin can still reset another admin.
  store.users.push(person({ name: 'Root', email: 'root@oneacrefund.org', role: 'admin' }));
  invalidate();
  const { response } = await issueCode('root@oneacrefund.org');
  store.users.pop();
  invalidate();

  assert.equal(response.status, 200);
  assert.equal(response.body.issued.length, 0);
  assert.match(response.body.skipped[0].reason, /Only an admin/);
});

test('only HR and admins can issue setup codes', async () => {
  const response = await call('/admin/users/setup-codes', {
    method: 'POST', body: { emails: ['hr@oneacrefund.org'] }, token: await login('agent@oneacrefund.org'),
  });
  assert.equal(response.status, 403);
});

test('the admin list says who can sign in, and never carries a code or a hash', async () => {
  const list = await call('/admin/users', { token: await login('hr@oneacrefund.org') });
  const agent = list.body.people.find((item) => item.email === 'agent@oneacrefund.org');
  assert.equal(agent.signIn.hasPassword, true);
  assert.doesNotMatch(JSON.stringify(list.body), /scrypt\$|setup_code_hash|password_hash/);
});

test('health answers 200 while the store is reachable', async () => {
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
});

test('a claim without a well-formed M-Pesa code is refused', async () => {
  // The code is what Finance reconciles against and what catches a repeat submission, so
  // a truncated or mistyped one has to be caught server-side, not only in the form.
  const token = await login('agent@oneacrefund.org');
  const submit = (mpesaCode) => call('/claims', {
    method: 'POST',
    body: { amount: 400, km: 10, rate: 25, estimate: 250, vehicle: 'Piki', purposes: ['Farmer Visit'], mpesaCode },
    token,
  });

  assert.equal((await submit('QWE123')).status, 400, 'too short');
  assert.equal((await submit('QWE123ABC12')).status, 400, 'too long');
  assert.equal((await submit('')).status, 400, 'missing');
  assert.equal((await submit(undefined)).status, 400, 'absent entirely');

  // A code pasted from the SMS arrives with stray whitespace and lower case. That is how
  // the field is actually filled, so it is normalised rather than rejected.
  const pasted = await submit('  qwe123abc9 ');
  assert.equal(pasted.status, 201);
  assert.equal(pasted.body.claim.mpesaCode, 'QWE123ABC9', 'stored uppercase and trimmed');
});

test('an unknown address and a deactivated one are refused identically', async () => {
  // The point of a single message: if the two answers differ, the sign-in page becomes a
  // way to ask "does this person work here" and get a truthful answer.
  const unknown = await call('/auth/google', { method: 'POST', body: { credential: 'stranger@oneacrefund.org' } });

  store.users.push(person({ name: 'Gone', email: 'gone@oneacrefund.org', active: false }));
  invalidate();
  const deactivated = await call('/auth/google', { method: 'POST', body: { credential: 'gone@oneacrefund.org' } });
  store.users.pop();
  invalidate();

  assert.equal(unknown.status, 401);
  assert.equal(deactivated.status, 401);
  assert.equal(unknown.body.error, deactivated.body.error, 'the two cases must be indistinguishable');
  assert.match(unknown.body.error, /Access denied/);
  assert.doesNotMatch(unknown.body.error, /directory|deactivated/i, 'and must not say which it was');
});
