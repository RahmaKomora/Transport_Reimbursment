import { strict as assert } from 'node:assert';
import test from 'node:test';
import { issueToken, readToken } from './auth.js';

test('a token round-trips an email that contains dots', () => {
  const email = 'alex.kiptoo@oneacrefund.org';
  assert.equal(readToken(issueToken(email)), email);
});

test('a tampered payload is rejected', () => {
  const token = issueToken('a@oneacrefund.org');
  const forged = `${Buffer.from(JSON.stringify({ email: 'hr@oneacrefund.org', exp: Date.now() + 1000 })).toString('base64url')}.${token.split('.').pop()}`;
  assert.equal(readToken(forged), null);
});

test('junk and empty tokens are rejected rather than throwing', () => {
  for (const value of ['', 'nonsense', 'a.b', undefined, null]) {
    assert.equal(readToken(value), null);
  }
});

test('with Google on, email sign-in is refused except for named demo accounts', async () => {
  // The bypass exists because demo accounts have a Songa record but no Google mailbox.
  // It must be exactly the named addresses and nobody else.
  const { signIn } = await import('./auth.js');
  process.env.SONGA_GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';

  const refused = await signIn('agent@oneacrefund.org');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Sign in with Google/);

  delete process.env.SONGA_GOOGLE_CLIENT_ID;
});
