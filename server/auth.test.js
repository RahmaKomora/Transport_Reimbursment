import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { issueToken, readToken } from './auth.js';
import { codeMatches, hashPassword, passwordProblem, verifyPassword } from './passwords.js';

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

test('a password verifies against its own hash and nothing else', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$32768\$8\$1\$/, 'the cost is recorded so it can be raised later');
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('correct horse batterz', stored), false);
  assert.notEqual(await hashPassword('correct horse battery'), stored, 'salted, so the same password hashes differently');
});

test('no stored hash, or a mangled one, is a refusal rather than a throw', async () => {
  for (const stored of [undefined, '', 'plaintext', 'scrypt$1$2']) {
    assert.equal(await verifyPassword('anything', stored), false);
  }
});

test('the same password typed on different keyboards compares equal', async () => {
  // "é" as one code point, and as "e" plus a combining accent, which some keyboards send.
  const stored = await hashPassword('caf\u00e9-latte-42');
  assert.equal(await verifyPassword('cafe\u0301-latte-42', stored), true);
});

test('password rules: long enough, not too long, not the email', () => {
  assert.match(passwordProblem('short'), /at least 8/);
  assert.match(passwordProblem('x'.repeat(201)), /at most 200/);
  assert.match(passwordProblem('jane.doe-2026', 'jane.doe@oneacrefund.org'), /email/);
  assert.equal(passwordProblem('a decent passphrase', 'jane.doe@oneacrefund.org'), '');
});

test('a setup code matches only while unexpired, ignoring case and the dash', () => {
  const credential = (code, expiresIn) => ({
    setup_code_hash: createHash('sha256').update(code).digest('hex'),
    setup_code_expires_at: new Date(Date.now() + expiresIn).toISOString(),
  });
  const live = credential('K7QM4XTP', 60_000);
  assert.equal(codeMatches(live, 'K7QM-4XTP'), true);
  assert.equal(codeMatches(live, ' k7qm 4xtp '), true);
  assert.equal(codeMatches(live, 'K7QM-4XTQ'), false);
  assert.equal(codeMatches(credential('K7QM4XTP', -1), 'K7QM-4XTP'), false, 'expired');
  assert.equal(codeMatches({ setup_code_hash: '', setup_code_expires_at: null }, ''), false, 'none outstanding');
});

test('a token carries when it was issued, so a reset can refuse older ones', () => {
  const token = issueToken('a@oneacrefund.org');
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.ok(Math.abs(payload.iat - Date.now()) < 5000);
  assert.ok(payload.exp - payload.iat >= 29 * 24 * 3600_000, 'and lasts about a month');
});
