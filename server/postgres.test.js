import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';

/**
 * The Postgres backend, against a real instance.
 *
 * Skipped unless SONGA_TEST_DATABASE_URL is set, because the rest of the suite runs on
 * throwaway SQLite files in about a second and should not need a server to pass.
 *
 *   SONGA_TEST_DATABASE_URL=postgres://user:pw@host:5432/your_own_db npm test
 *
 * **It creates a schema and drops it again**, so point it only at a database where that
 * is yours to do. Not the shared `tupande_automations` one: that database is one schema
 * per tool and nothing else, so an extra schema appearing in it — even briefly — is not
 * on. There is no way to test a real adapter without writing somewhere, and a schema of
 * its own is the smallest somewhere available.
 *
 * The live tables are never read or written either way. Against a database you own, the
 * same connection string as the app's is fine.
 *
 * What is worth testing here is only what differs between the two backends — the type
 * conversions, the placeholder rewrite, transactions over a pool, and the store mappers
 * over real rows. The business logic above the data layer is already covered, and
 * covering it twice would just be a slower way to run the same assertions.
 */

const url = process.env.SONGA_TEST_DATABASE_URL;

if (!url) {
  test('postgres backend (set SONGA_TEST_DATABASE_URL to run)', { skip: true }, () => {});
} else {
  process.env.SONGA_DATABASE_URL = url;
  // Set before the import, because db.postgres.js resolves the schema name once, at
  // import, and pins it to every connection the pool opens.
  process.env.SONGA_DB_SCHEMA = 'transport_reimbursement_pgtest';

  const { SCHEMA, all, get, run, tx, engine, closeDb, applySchema } = await import('./db.postgres.js');

  const EMAIL = 'pgtest-person@oneacrefund.org';
  const CLAIM = 'pgtest-claim-1';

  before(async () => {
    // Dropped first as well as last: a run killed part way through leaves the schema
    // behind, and the next run should start from nothing rather than from that.
    await run(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await applySchema();
  });

  after(async () => {
    await run(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await closeDb();
  });

  test('the selected backend is postgres', () => {
    assert.equal(engine(), 'postgres');
  });

  test('the tables were built in their own schema, not in public', () => {
    // The guard against the whole suite quietly operating on the live tables.
    assert.equal(SCHEMA, 'transport_reimbursement_pgtest');
  });

  test('an unqualified name resolves inside the schema', async () => {
    const row = await get('SELECT current_schema() AS name');
    assert.equal(row.name, SCHEMA);
  });

  test('? placeholders are rewritten, in order', async () => {
    const row = await get('SELECT ?::text AS first, ?::text AS second', ['one', 'two']);
    assert.deepEqual({ ...row }, { first: 'one', second: 'two' });
  });

  test('money comes back as a number, not a string', async () => {
    const now = new Date().toISOString();
    await run(
      `INSERT INTO users (email, name, region, transport_per_cycle, out_of_office, active,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [EMAIL, 'Test Person', 'pgtest-region', 1234.56, false, true, now, now],
    );
    const row = await get('SELECT transport_per_cycle FROM users WHERE email = ?', [EMAIL]);
    assert.equal(typeof row.transport_per_cycle, 'number');
    assert.equal(row.transport_per_cycle, 1234.56);
  });

  test('booleans round-trip as booleans', async () => {
    // The failure this guards against is silent: `row.active === 1` was true of SQLite's
    // integers and false of a real boolean, which would read every person as inactive.
    const row = await get('SELECT active, out_of_office FROM users WHERE email = ?', [EMAIL]);
    assert.equal(row.active, true);
    assert.equal(row.out_of_office, false);

    await run('UPDATE users SET active = ? WHERE email = ?', [false, EMAIL]);
    const after = await get('SELECT active FROM users WHERE email = ?', [EMAIL]);
    assert.equal(after.active, false);
  });

  test('count(*) is a number, so arithmetic on it is arithmetic', async () => {
    const row = await get('SELECT count(*) AS n FROM users WHERE email = ?', [EMAIL]);
    assert.equal(row.n, 1);
    assert.equal(typeof row.n, 'number');
  });

  test('timestamps come back as the ISO strings the app stores', async () => {
    const submitted = '2026-02-03T08:30:00.000Z';
    await run(
      `INSERT INTO claims (id, submitted_at, submitted_by, status, trip_date, amount, decision_log)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [CLAIM, submitted, EMAIL, 'pending', '2026-02-02', 500, JSON.stringify([{ by: 'a' }])],
    );
    const row = await get('SELECT submitted_at, trip_date, completed_at FROM claims WHERE id = ?', [CLAIM]);
    assert.equal(row.submitted_at, submitted);
    // A calendar day, left as one: parsing it to a Date would shift it across a timezone.
    assert.equal(row.trip_date, '2026-02-02');
    // Nothing has completed it, which is NULL here and '' on SQLite. store.js maps both.
    assert.equal(row.completed_at, null);
  });

  test('jsonb columns arrive as text, the way store.js parses them', async () => {
    const row = await get('SELECT decision_log, duplicate_flag FROM claims WHERE id = ?', [CLAIM]);
    assert.equal(typeof row.decision_log, 'string');
    assert.deepEqual(JSON.parse(row.decision_log), [{ by: 'a' }]);
    assert.equal(row.duplicate_flag, null);
  });

  test('a write reports how many rows it touched', async () => {
    const hit = await run('UPDATE claims SET status = ? WHERE id = ?', ['approved', CLAIM]);
    assert.equal(hit.changes, 1);
    const miss = await run('UPDATE claims SET status = ? WHERE id = ?', ['approved', 'pgtest-absent']);
    assert.equal(miss.changes, 0);
  });

  test('a transaction commits as one unit', async () => {
    await tx(async ({ run: write }) => {
      await write('INSERT INTO rates (region, vehicle, rate) VALUES (?, ?, ?)', ['pgtest-region', 'Piki', 25]);
      await write('INSERT INTO rates (region, vehicle, rate) VALUES (?, ?, ?)', ['pgtest-region', 'Matatu', 30]);
    });
    const rows = await all('SELECT vehicle, rate FROM rates WHERE region = ? ORDER BY vehicle', ['pgtest-region']);
    assert.deepEqual(rows.map((r) => [r.vehicle, r.rate]), [['Matatu', 30], ['Piki', 25]]);
  });

  test('a failed transaction leaves nothing behind', async () => {
    // The statements have to reach one connection for this to hold. On a pool that hands
    // out a different client per query, the BEGIN would apply to none of them and the
    // first insert would survive the rollback.
    await assert.rejects(
      tx(async ({ run: write }) => {
        await write('DELETE FROM rates WHERE region = ?', ['pgtest-region']);
        await write('INSERT INTO rates (region, vehicle, rate) VALUES (?, ?, ?)', ['pgtest-region', 'Piki', -5]);
      }),
      /violates check constraint/,
    );
    const rows = await all('SELECT vehicle FROM rates WHERE region = ?', ['pgtest-region']);
    assert.equal(rows.length, 2, 'the DELETE should have rolled back with the failed INSERT');
  });

  test('two transactions in a row each get a client', async () => {
    // SQLite needs a re-entrancy guard because it has one connection. The pool does not,
    // and this is the assertion that the guard was not carried across by habit.
    await tx(async ({ run: write }) => write('UPDATE rates SET rate = ? WHERE region = ? AND vehicle = ?', [26, 'pgtest-region', 'Piki']));
    await tx(async ({ run: write }) => write('UPDATE rates SET rate = ? WHERE region = ? AND vehicle = ?', [27, 'pgtest-region', 'Piki']));
    const row = await get('SELECT rate FROM rates WHERE region = ? AND vehicle = ?', ['pgtest-region', 'Piki']);
    assert.equal(row.rate, 27);
  });

  test('the store maps rows the same way it does on SQLite', async () => {
    // The adapter is only half the job: toUser and toClaim are where a string amount or a
    // real boolean would actually reach the app.
    const store = await import('./store.js');
    const people = await store.readUsers();
    const person = people.find((entry) => entry.email === EMAIL);
    assert.ok(person, 'the test person should be in the directory');
    assert.equal(person.active, false);
    assert.equal(person.manager1OutOfOffice, false);
    assert.equal(typeof person.transportPerCycle, 'number');

    const claim = (await store.readClaims()).find((entry) => entry.id === CLAIM);
    assert.ok(claim, 'the test claim should be readable');
    assert.equal(typeof claim.amount, 'number');
    assert.equal(claim.amount, 500);
    assert.deepEqual(claim.decisionLog, [{ by: 'a' }]);
    assert.equal(claim.completedAt, '', 'a missing timestamp should map to the blank the app expects');
    assert.equal(claim.tripDate, '2026-02-02');
  });

  test('a claim with no trip date is written as NULL, not an empty string', async () => {
    // '' is what SQLite stores and what a `date` column rejects outright, so this is the
    // one type difference store.js has to know about.
    const store = await import('./store.js');
    await store.appendClaim({
      id: 'pgtest-claim-2', submittedAt: new Date().toISOString(), submittedBy: EMAIL,
      status: 'pending', tripDate: '', amount: 0, decisionLog: [],
    });
    const row = await get('SELECT trip_date, completed_at FROM claims WHERE id = ?', ['pgtest-claim-2']);
    assert.equal(row.trip_date, null);
    assert.equal(row.completed_at, null);
  });
}
