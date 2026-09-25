import { strict as assert } from 'node:assert';
import test from 'node:test';
import { duplicateNote, findDuplicates, fingerprintImage } from './duplicates.js';
import { STATUS } from './routing.js';

const base = { id: 'new', submittedBy: 'a@oneacrefund.org', amount: 1200, submittedAt: '2026-09-23T08:00:00Z', mpesaCode: '', proofHash: '', status: STATUS.PENDING_MANAGER };
const prior = (over) => ({ id: 'old', submittedBy: 'a@oneacrefund.org', amount: 1200, submittedAt: '2026-09-23T06:00:00Z', tripDate: '2026-09-23', status: STATUS.APPROVED, ...over });

test('the same M-Pesa code is treated as certain, because one payment has one code', () => {
  const found = findDuplicates({ ...base, mpesaCode: 'QWE123ABC' }, [prior({ mpesaCode: 'QWE123ABC' })]);
  assert.equal(found.level, 'certain');
  assert.match(found.reason, /QWE123ABC/);
  assert.equal(found.matches[0].id, 'old');
});

test('codes are compared ignoring case and stray spaces, since they are typed by hand', () => {
  const found = findDuplicates({ ...base, mpesaCode: ' qwe123abc ' }, [prior({ mpesaCode: 'QWE123ABC' })]);
  assert.equal(found.level, 'certain');
});

test('the same receipt image attached twice is likely, not certain', () => {
  const found = findDuplicates({ ...base, proofHash: 'abc123' }, [prior({ proofHash: 'abc123' })]);
  assert.equal(found.level, 'likely');
  assert.match(found.reason, /same proof-of-payment image/i);
});

test('same person, same amount, same day is only worth a look', () => {
  const found = findDuplicates(base, [prior({})]);
  assert.equal(found.level, 'possible');
});

test('two identical fares on different days are not flagged', () => {
  assert.equal(findDuplicates(base, [prior({ submittedAt: '2026-09-20T06:00:00Z' })]), null);
});

test('a different claimant with the same amount is not a duplicate', () => {
  assert.equal(findDuplicates(base, [prior({ submittedBy: 'b@oneacrefund.org' })]), null);
});

test('resubmitting after a rejection is not a duplicate', () => {
  // Fixing and resubmitting is exactly what a claimant is told to do, so the rejected
  // original must not make the corrected version look like a repeat.
  const found = findDuplicates({ ...base, mpesaCode: 'QWE123ABC' }, [prior({ mpesaCode: 'QWE123ABC', status: STATUS.REJECTED })]);
  assert.equal(found, null);
});

test('a claim is never a duplicate of itself', () => {
  assert.equal(findDuplicates({ ...base, id: 'same', mpesaCode: 'X1' }, [prior({ id: 'same', mpesaCode: 'X1' })]), null);
});

test('the same image bytes produce the same fingerprint, different bytes do not', () => {
  const a = 'data:image/png;base64,aGVsbG8=';
  const b = 'data:image/png;base64,d29ybGQ=';
  assert.equal(fingerprintImage(a), fingerprintImage(a));
  assert.notEqual(fingerprintImage(a), fingerprintImage(b));
  assert.equal(fingerprintImage(''), '');
});

test('the note tells the claimant what to do, not just that it was refused', () => {
  const found = findDuplicates({ ...base, mpesaCode: 'Q1' }, [prior({ mpesaCode: 'Q1', submittedAt: '2026-09-21T06:00:00Z' })]);
  const note = duplicateNote(found);
  assert.match(note, /21 September 2026/);
  assert.match(note, /add a note explaining the difference and resubmit/);
});
