import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getCycleDetails } from './cycles.js';
import { buildBatchReport } from './notifications.js';
import { STATUS } from './routing.js';

const cycle = getCycleDetails('2026-09-05T06:00:00Z');
const claim = (over) => ({ id: 'SNG-1', staffName: 'A', submittedBy: 'a@oneacrefund.org', region: 'Nyanza', zone: 'Kisumu', amount: 1000, km: 10, status: STATUS.APPROVED, ...over });

test('the batch report groups by region and totals each one', () => {
  const report = buildBatchReport(cycle, [
    claim({ id: 'SNG-1', region: 'Nyanza', amount: 1000 }),
    claim({ id: 'SNG-2', region: 'Nyanza', amount: 2000, submittedBy: 'b@oneacrefund.org' }),
    claim({ id: 'SNG-3', region: 'Coast', amount: 500, submittedBy: 'c@oneacrefund.org' }),
  ]);

  assert.equal(report.claimCount, 3);
  assert.equal(report.total, 3500);
  assert.equal(report.regions.length, 2);

  const nyanza = report.regions.find((region) => region.region === 'Nyanza');
  assert.equal(nyanza.total, 3000);
  assert.equal(nyanza.staff, 2, 'two distinct claimants');
});

test('the report counts staff, not claims, per region', () => {
  const report = buildBatchReport(cycle, [claim({ id: 'SNG-1' }), claim({ id: 'SNG-2' })]);
  assert.equal(report.regions[0].claims.length, 2);
  assert.equal(report.regions[0].staff, 1, 'the same person twice is one member of staff');
});

test('the subject names the cycle and its window', () => {
  const report = buildBatchReport(cycle, [claim({})]);
  assert.match(report.subject, /Cycle 1/);
  assert.match(report.subject, /1–15 September/);
});

test('an empty cycle still produces a readable report', () => {
  const report = buildBatchReport(cycle, []);
  assert.equal(report.claimCount, 0);
  assert.equal(report.total, 0);
  assert.match(report.text, /No approved claims/);
});

test('every claim appears in the report body', () => {
  const report = buildBatchReport(cycle, [claim({ id: 'SNG-AAA' }), claim({ id: 'SNG-BBB', region: 'Coast' })]);
  assert.match(report.text, /SNG-AAA/);
  assert.match(report.text, /SNG-BBB/);
});
