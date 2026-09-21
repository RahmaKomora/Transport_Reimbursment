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
