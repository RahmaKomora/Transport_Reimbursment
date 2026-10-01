import 'dotenv/config';

/**
 * Creates Songa's tables on Postgres.
 *
 *   npm run db:setup
 *
 * Applies server/schema.postgres.sql through the `pg` driver rather than psql, so it
 * needs nothing on the PATH — the EDB and Postgres.app installers put psql somewhere
 * different on every machine, and the app already has a working connection.
 *
 * Idempotent: every statement in the schema is IF NOT EXISTS and the file is one
 * transaction, so this is safe to re-run against a populated database. The server calls
 * the same code at startup; this exists to do it deliberately, and to report what landed.
 */

const { SCHEMA, all, applySchema, closeDb, configured, dbPath } = await import('./db.postgres.js');

if (!configured()) {
  console.error('No Postgres connection is configured. Set SONGA_DATABASE_URL, or PGDATABASE');
  console.error('and friends, in .env — see .env.example.');
  process.exit(1);
}

const EXPECTED = ['claims', 'rate_changes', 'rates', 'users'];

async function main() {
  console.log(`Applying server/schema.postgres.sql to ${dbPath()}`);
  await applySchema();

  // Read back rather than trusting the DDL, because "it ran" and "the tables are as this
  // version expects" are different claims, and the second is the one worth making.
  // Scoped to Songa's own schema, so a table of the same name elsewhere in a shared
  // database cannot be mistaken for ours.
  const tables = await all(
    `SELECT table_name AS name
     FROM information_schema.tables
     WHERE table_schema = ? AND table_name = ANY (?)
     ORDER BY table_name`,
    [SCHEMA, EXPECTED],
  );

  const counts = {};
  for (const { name } of tables) {
    // Interpolated, which is safe only because `name` came back from the query above
    // filtered against EXPECTED — a table name cannot be a parameter.
    const [row] = await all(`SELECT count(*) AS n FROM "${SCHEMA}"."${name}"`);
    counts[name] = row.n;
  }

  console.log('');
  for (const { name } of tables) console.log(`  ${name.padEnd(13)} ${counts[name]} rows`);

  const missing = EXPECTED.filter((name) => !(name in counts));
  if (missing.length) {
    console.error(`\nMissing after apply: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`\nSchema "${SCHEMA}" is in place.`);
  }
  await closeDb();
}

main().catch(async (error) => {
  console.error(`\nFailed: ${error.message}`);
  // The ones that actually happen, and what each means, because the driver's own wording
  // ("ECONNREFUSED", "permission denied for database") sends people to the wrong file.
  if (error.code === 'ECONNREFUSED') console.error('Nothing is listening on that host and port — is the server running?');
  if (error.code === '28P01') console.error('The password in SONGA_DATABASE_URL was rejected.');
  if (error.code === '3D000') console.error('That database does not exist yet. Create it, or point the URL at one that exists.');
  if (error.code === '42501') console.error(`The role may not create the "${SCHEMA}" schema in that database.`);
  await closeDb().catch(() => {});
  process.exit(1);
});
