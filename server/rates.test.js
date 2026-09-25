import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';
import { rmSync } from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'server', 'data', 'rates-test.db');
process.env.SONGA_DB_PATH = FILE;

const rates = await import('./rates.js');
const { VEHICLES, SEED_RATES, getRates, saveRates, rateFrom, hasRates } = rates;
const { closeDb } = await import('./db.js');

before(async () => { await saveRates(SEED_RATES); });
after(() => { closeDb(); try { rmSync(FILE, { force: true }); rmSync(`${FILE}-wal`, { force: true }); rmSync(`${FILE}-shm`, { force: true }); } catch {} });

test('a hired piki and a personal piki are separate rates', async () => {
  // Collapsing these reimbursed personal journeys at the hired rate in every region.
  assert.equal(VEHICLES.length, 4);
  const table = await getRates();
  assert.notEqual(table.Rift.Piki, table.Rift['Personal Piki']);
  assert.equal(table.Rift.Piki, 25);
  assert.equal(table.Rift['Personal Piki'], 20);
});

test('a region without rates reports zero rather than borrowing from elsewhere', async () => {
  // A wrong number that looks right is worse than a visible gap, and the admin screen
  // surfaces the gap.
  const table = await getRates();
  assert.equal(table.Somewhere, undefined);
  assert.equal(rateFrom(table, 'Matatu', 'Somewhere'), 0);
  assert.equal(hasRates(table, 'Somewhere'), false);
});

test('there is no Default region, and one cannot be created', async () => {
  const saved = await saveRates({ ...(await getRates()), Default: { Piki: 99, Matatu: 99, 'Personal Piki': 99, 'Personal Car': 99 } });
  assert.equal(saved.Default, undefined, 'the fallback must not creep back in');
  assert.equal((await getRates()).Default, undefined);
});

test('a region is only configured once every mode has a rate', async () => {
  const table = await getRates();
  await saveRates({ ...table, Coast: { ...table.Coast, 'Personal Car': 0 } });
  assert.equal(hasRates(await getRates(), 'Coast'), false, 'one blank mode means the region is not ready');
  await saveRates(SEED_RATES);
  assert.equal(hasRates(await getRates(), 'Coast'), true);
});

test('an edit survives a reload, because it is stored rather than held in memory', async () => {
  const table = await getRates();
  await saveRates({ ...table, Coast: { ...table.Coast, Matatu: 42 } });
  assert.equal((await getRates()).Coast.Matatu, 42);
  await saveRates({ ...table, Coast: { ...table.Coast, Matatu: 35 } });
});

test('negative and nonsense rates are floored at zero, never stored as junk', async () => {
  const table = await getRates();
  const saved = await saveRates({ ...table, Coast: { ...table.Coast, Piki: -5, Matatu: 'abc' } });
  assert.equal(saved.Coast.Piki, 0);
  assert.equal(saved.Coast.Matatu, 0);
  await saveRates(SEED_RATES);
});

test('a failed save leaves the previous rates intact', async () => {
  const before = await getRates();
  try { await saveRates(null); } catch { /* expected */ }
  assert.deepEqual((await getRates()).Coast, before.Coast, 'no half-written table');
});

test('a rate change records who made it and what it replaced', async () => {
  const { lastChanged, historyFor } = rates;
  const table = await getRates();
  await saveRates({ ...table, Coast: { ...table.Coast, Piki: 31 } }, 'Rahma Komora');

  const recent = (await lastChanged()).Coast;
  assert.equal(recent.by, 'Rahma Komora');
  assert.ok(recent.at);

  const [change] = await historyFor('Coast');
  assert.equal(change.vehicle, 'Piki');
  assert.equal(change.oldRate, 30);
  assert.equal(change.newRate, 31);
  assert.equal(change.by, 'Rahma Komora');

  await saveRates(SEED_RATES, 'Rahma Komora');
});

test('saving without changing anything writes no history', async () => {
  const before = (await rates.historyFor('Nyanza')).length;
  await saveRates(await getRates(), 'Somebody');
  assert.equal((await rates.historyFor('Nyanza')).length, before, 'a no-op save is not a change');
});

test('removing a region is recorded, not silently forgotten', async () => {
  const table = await getRates();
  await saveRates({ ...table, Temporary: { Piki: 10, Matatu: 10, 'Personal Piki': 10, 'Personal Car': 10 } }, 'Admin');
  const { Temporary, ...without } = await getRates();
  await saveRates(without, 'Admin');

  const [latest] = await rates.historyFor('Temporary');
  assert.equal(latest.newRate, null, 'a removal is a change with no new value');
  assert.equal(latest.oldRate, 10);
});

test('history survives later edits, so an old rate can still be explained', async () => {
  const table = await getRates();
  await saveRates({ ...table, Rift: { ...table.Rift, Matatu: 32 } }, 'First');
  const reloaded = await getRates();
  await saveRates({ ...reloaded, Rift: { ...reloaded.Rift, Matatu: 33 } }, 'Second');
  const trail = (await rates.historyFor('Rift')).filter((c) => c.vehicle === 'Matatu');
  assert.ok(trail.length >= 2, 'both edits are kept');
  assert.equal(trail[0].by, 'Second');
  await saveRates(SEED_RATES, 'Admin');
});
