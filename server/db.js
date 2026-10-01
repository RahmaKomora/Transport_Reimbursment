import 'dotenv/config';
import * as sqlite from './db.sqlite.js';
import * as postgres from './db.postgres.js';

/**
 * Songa's own database.
 *
 * Rates, staff and claims all live here. Everything above this file talks to the database
 * through all/get/run/tx below, never through a driver, and every one of those is async
 * even though SQLite answers immediately. That was the groundwork for this file existing
 * at all: Postgres has no synchronous client, so a synchronous data layer would have made
 * the move to it a rewrite of every route that touches data rather than a new module.
 *
 * Two backends, chosen here and nowhere else:
 *
 *   SONGA_DATABASE_URL, or PGDATABASE    Postgres, via db.postgres.js. What it runs on.
 *   neither                              SQLite, via db.sqlite.js. One file, no server.
 *
 * Either spelling of a Postgres connection will do — one URL, or libpq's own PGHOST /
 * PGPORT / PGUSER / PGPASSWORD / PGDATABASE / PGSSLMODE, which `pg` reads for itself.
 *
 * SQLite is kept rather than deleted because the test suite runs against throwaway `.db`
 * files in about a second, which no Postgres instance will match, and because it makes a
 * fresh checkout work before anybody has a connection string. The SQL is kept to what
 * both engines accept; `docs/postgres-migration.md` records the differences that remain.
 *
 * SONGA_DB_FORCE_SQLITE=true overrides both, and is how the test suite and the SQLite
 * exporter ask for the file backend. It has to be a flag rather than them deleting
 * SONGA_DATABASE_URL, because the `dotenv/config` import above would read it straight back
 * out of .env and put it there again — a delete that looks like it works, does nothing,
 * and sends a test run at the real instance.
 */

/**
 * Which backend answered, decided on first use rather than at import.
 *
 * Deferring it is what lets a test set SONGA_DB_PATH or SONGA_DB_FORCE_SQLITE in its
 * module body: `import` is hoisted, so a static `import ... from './store.js'` at the top
 * of a test file reaches this module *before* any line of that body has run. Choosing a
 * driver at import would read the environment as it was before the test configured it and
 * send the run at whatever SONGA_DATABASE_URL happens to be in .env. Both drivers are
 * imported statically above — neither opens anything until it is asked to — so this costs
 * nothing but gets the ordering right.
 */
let chosen = null;

function driver() {
  if (chosen) return chosen;
  const forceSqlite = String(process.env.SONGA_DB_FORCE_SQLITE || '').toLowerCase() === 'true';
  chosen = postgres.configured() && !forceSqlite ? postgres : sqlite;
  return chosen;
}

/** 'postgres' or 'sqlite'. The store reports it, and store.js branches on it once. */
export const engine = () => driver().engine();

/** Where the data is, for a log line or the admin screen. Never includes a password. */
export const dbPath = () => driver().dbPath();

/** Every matching row. */
export async function all(text, params = []) {
  return driver().all(text, params);
}

/** The first matching row, or undefined. */
export async function get(text, params = []) {
  return driver().get(text, params);
}

/** A write. Returns how many rows it touched. */
export async function run(text, params = []) {
  return driver().run(text, params);
}

/**
 * Runs a function inside one transaction, handing it the same all/get/run.
 *
 * Callers never issue BEGIN or COMMIT themselves: SQLite wants BEGIN IMMEDIATE to take
 * the write lock up front, and Postgres rejects that keyword.
 */
export async function tx(work) {
  return driver().tx(work);
}

/**
 * Makes sure the tables exist. Called once at startup by server/index.js.
 *
 * SQLite builds them when it opens the file; Postgres creates its schema and applies
 * schema.postgres.sql, which is idempotent. Either way this is safe to call against a
 * populated database.
 */
export async function ensureSchema() {
  const active = driver();
  if (active.applySchema) return active.applySchema();
  active.db();
  return undefined;
}

/**
 * Closes the handle or the pool. The server holds it for its lifetime; tests do not.
 *
 * Also forgets which backend was chosen, so a process that closes and carries on picks it
 * up again from the environment as it now stands.
 */
export function closeDb() {
  const active = chosen;
  chosen = null;
  return active ? active.closeDb() : undefined;
}
