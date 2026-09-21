import { strict as assert } from 'node:assert';
import test from 'node:test';
import { cycleFromKey, fromEat, getCycleDetails, isClosed, previousCycle } from './cycles.js';

// Nairobi is UTC+3, so 21:00 UTC is already the next day locally. These fixtures are
// written in UTC deliberately: the point is that the cycle follows the Nairobi clock.
test('days 1 to 15 are Cycle 1', () => {
  assert.equal(getCycleDetails('2026-09-01T06:00:00Z').label, 'Cycle 1');
  assert.equal(getCycleDetails('2026-09-15T06:00:00Z').label, 'Cycle 1');
  assert.equal(getCycleDetails('2026-09-09T06:00:00Z').key, '2026-09-C1');
});

test('day 16 to month end is Cycle 2', () => {
  assert.equal(getCycleDetails('2026-09-16T06:00:00Z').label, 'Cycle 2');
  assert.equal(getCycleDetails('2026-09-30T06:00:00Z').label, 'Cycle 2');
  assert.equal(getCycleDetails('2026-09-20T06:00:00Z').key, '2026-09-C2');
});

test('the boundary follows the Nairobi clock, not UTC', () => {
  // 23:30 on the 15th in Nairobi is 20:30 UTC — still Cycle 1.
  assert.equal(getCycleDetails('2026-09-15T20:30:00Z').label, 'Cycle 1');
  // 00:30 on the 16th in Nairobi is 21:30 UTC on the 15th — already Cycle 2.
  assert.equal(getCycleDetails('2026-09-15T21:30:00Z').label, 'Cycle 2');
});

test('cycle 1 is batched on the 16th at 08:00 EAT', () => {
  const cycle = getCycleDetails('2026-09-05T06:00:00Z');
  assert.equal(cycle.batchAt.toISOString(), '2026-09-16T05:00:00.000Z'); // 08:00 EAT
});

test('cycle 2 is batched on the 1st of the following month at 08:00 EAT', () => {
  const cycle = getCycleDetails('2026-09-20T06:00:00Z');
  assert.equal(cycle.batchAt.toISOString(), '2026-10-01T05:00:00.000Z');
});

test('december cycle 2 rolls into january', () => {
  const cycle = getCycleDetails('2026-12-20T06:00:00Z');
  assert.equal(cycle.batchAt.toISOString(), '2027-01-01T05:00:00.000Z');
  assert.equal(cycle.end.toISOString(), '2026-12-31T20:59:59.999Z'); // 23:59:59.999 EAT
});

test('cycle 2 ends on the real last day, short months included', () => {
  assert.equal(getCycleDetails('2027-02-20T06:00:00Z').end.toISOString(), '2027-02-28T20:59:59.999Z');
  assert.equal(getCycleDetails('2028-02-20T06:00:00Z').end.toISOString(), '2028-02-29T20:59:59.999Z', 'leap year');
});

test('cycle bounds abut with no gap and no overlap', () => {
  const one = getCycleDetails('2026-09-05T06:00:00Z');
  const two = getCycleDetails('2026-09-20T06:00:00Z');
  assert.equal(two.start.getTime() - one.end.getTime(), 1);
});

test('previousCycle steps back across a month boundary', () => {
  assert.equal(previousCycle('2026-10-02T06:00:00Z').key, '2026-09-C2');
  assert.equal(previousCycle('2026-09-20T06:00:00Z').key, '2026-09-C1');
});

test('a cycle key round-trips', () => {
  assert.equal(cycleFromKey('2026-09-C2').key, '2026-09-C2');
  assert.equal(cycleFromKey('2026-09-C1').label, 'Cycle 1');
  assert.equal(cycleFromKey('rubbish'), null);
});

test('a cycle is closed only once its batch moment passes', () => {
  const cycle = getCycleDetails('2026-09-05T06:00:00Z');
  assert.equal(isClosed(cycle, fromEat(2026, 8, 16, 7, 59)), false);
  assert.equal(isClosed(cycle, fromEat(2026, 8, 16, 8, 0)), true);
});
