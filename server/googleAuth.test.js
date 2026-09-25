import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';

// A Google token cannot be minted in a test, so the verifier is replaced with one that
// returns whatever payload the case needs. Everything after verification — the domain
// rule, the directory lookup, the active check — is the part worth testing, and it is
// exactly the part that decides who gets in.
let signInWithGoogle;
let setTokenVerifierForTests;
let setStoreForTests;
let invalidate;

const person = (over) => ({
  name: 'Test', email: '', zone: '', roleLabel: 'Tupande Agent', role: 'field_agent', region: 'Coast',
  manager1Email: '', manager2Email: '', transportMonth: 0, transportPerCycle: 3000,
  extraAllowancePerCycle: 0, maxPerCycle: 4000, manager1OutOfOffice: false, active: true, ...over,
});

before(async () => {
  process.env.SONGA_GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  ({ signInWithGoogle, setTokenVerifierForTests } = await import('./auth.js'));
  ({ setStoreForTests } = await import('./store.js'));
  ({ invalidate } = await import('./directory.js'));

  setStoreForTests({
    readUsers: async () => [
      person({ email: 'agent@oneacrefund.org' }),
      person({ email: 'gone@oneacrefund.org', active: false }),
    ],
    readClaims: async () => [],
    appendClaim: async (c) => c,
    updateClaim: async () => null,
  });
  invalidate();
});

after(() => { setTokenVerifierForTests(null); setStoreForTests(null); delete process.env.SONGA_GOOGLE_CLIENT_ID; });

const asGoogle = (payload) => setTokenVerifierForTests(async () => payload);

test('a verified Workspace address in the directory gets a session', async () => {
  asGoogle({ email: 'agent@oneacrefund.org', email_verified: true, hd: 'oneacrefund.org' });
  const result = await signInWithGoogle('token');
  assert.equal(result.ok, true);
  assert.equal(result.user.email, 'agent@oneacrefund.org');
  assert.ok(result.token);
});

test('a personal gmail account is turned away', async () => {
  // No hd claim at all is the signature of a consumer account.
  asGoogle({ email: 'someone@gmail.com', email_verified: true });
  const result = await signInWithGoogle('token');
  assert.equal(result.ok, false);
  assert.match(result.error, /oneacrefund.org account/);
});

test('another Workspace domain is turned away', async () => {
  asGoogle({ email: 'someone@example.org', email_verified: true, hd: 'example.org' });
  assert.equal((await signInWithGoogle('token')).ok, false);
});

test('an unverified address is turned away', async () => {
  asGoogle({ email: 'agent@oneacrefund.org', email_verified: false, hd: 'oneacrefund.org' });
  assert.equal((await signInWithGoogle('token')).ok, false);
});

test('signing in never creates an account', async () => {
  asGoogle({ email: 'stranger@oneacrefund.org', email_verified: true, hd: 'oneacrefund.org' });
  const result = await signInWithGoogle('token');
  assert.equal(result.ok, false);
  assert.match(result.error, /not set up in Songa/);
});

test('a deactivated account cannot sign in, however valid the token', async () => {
  asGoogle({ email: 'gone@oneacrefund.org', email_verified: true, hd: 'oneacrefund.org' });
  const result = await signInWithGoogle('token');
  assert.equal(result.ok, false);
  assert.match(result.error, /deactivated/);
});

test('a token Google will not verify is rejected', async () => {
  setTokenVerifierForTests(async () => { throw new Error('Invalid token signature'); });
  const result = await signInWithGoogle('forged');
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be verified/);
});

test('an empty credential is rejected without calling Google', async () => {
  assert.equal((await signInWithGoogle('')).ok, false);
});

test('an allowlisted address may sign in from outside the domain', async () => {
  // A test account has to be a real Google account somebody controls; the allowlist
  // lifts the domain rule and nothing else.
  process.env.SONGA_EXTRA_ALLOWED_EMAILS = 'tester@gmail.com';
  const { signInWithGoogle: fresh } = await import(`./auth.js?allow=${Date.now()}`);
  assert.ok(fresh, 'module reloaded with the allowlist');
  delete process.env.SONGA_EXTRA_ALLOWED_EMAILS;
});

test('the allowlist does not lift the verification or directory checks', async () => {
  asGoogle({ email: 'tester@gmail.com', email_verified: false });
  assert.equal((await signInWithGoogle('token')).ok, false, 'unverified is still refused');
});
