import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Songa's own database.
 *
 * SQLite from Node's standard library, so there is no dependency to install and no server
 * to run: one file on disk, with real transactions. That last part matters — the sheet
 * had no way to stop two writes overwriting each other, and this does.
 *
 * Rates, staff and claims all live here.
 *
 * Everything above this file talks to it through all/get/run/tx below, never through the
 * driver, and every one of those is async even though SQLite answers immediately. That
 * is deliberate: Postgres has no synchronous client, so a synchronous data layer would
 * make moving to it a rewrite of every route that touches data rather than a rewrite of
 * this file. The SQL itself is kept to what both engines accept — see
 * docs/postgres-migration.md for the differences that remain.
 */

/**
 * Resolved when the database is first opened rather than when this module loads, so a
 * test can point SONGA_DB_PATH at a throwaway file without having to win a race with the
 * import graph. Getting that wrong once meant a test run rewrote the development rates.
 */
export const dbPath = () => process.env.SONGA_DB_PATH || path.join(process.cwd(), 'server', 'data', 'songa.db');

let database = null;

export function db() {
  if (database) return database;
  const file = dbPath();
  mkdirSync(path.dirname(file), { recursive: true });
  database = new DatabaseSync(file);
  // Write-ahead logging lets reads continue during a write, which matters the moment more
  // than one person is using the app at once.
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  migrate(database);
  return database;
}

/* ----------------------------------------------------------------- query layer ----- *
 * The whole surface the rest of the app is allowed to use. A Postgres version of this
 * file implements the same four functions over `pg`, rewriting the `?` placeholders to
 * $1..$n, and nothing else in the codebase changes.
 */

/** Every matching row. */
export async function all(text, params = []) {
  return db().prepare(text).all(...params);
}

/** The first matching row, or undefined. */
export async function get(text, params = []) {
  return db().prepare(text).get(...params);
}

/** A write. Returns how many rows it touched. */
export async function run(text, params = []) {
  return { changes: db().prepare(text).run(...params).changes };
}

/**
 * Runs a function inside one transaction, handing it the same all/get/run.
 *
 * Callers never issue BEGIN or COMMIT themselves, because those are spelled differently
 * per engine — SQLite wants BEGIN IMMEDIATE to take the write lock up front, Postgres
 * takes it on first write and would reject the keyword.
 */
let inTransaction = false;

export async function tx(work) {
  // One connection today, so two overlapping transactions are a bug rather than a queue,
  // and SQLite reports it as "cannot start a transaction within a transaction" from
  // whichever call happens to be second. Saying so here names the actual mistake, which
  // is almost always a forgotten await on an earlier write. On Postgres this becomes a
  // client checked out of the pool per transaction, and the guard goes.
  if (inTransaction) {
    throw new Error('A transaction is already open. Check for a missing await on an earlier database call.');
  }
  const handle = db();
  inTransaction = true;
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = await work({ all, get, run });
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    handle.exec('ROLLBACK');
    throw error;
  } finally {
    inTransaction = false;
  }
}

function migrate(handle) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS rates (
      region   TEXT NOT NULL,
      vehicle  TEXT NOT NULL,
      rate     REAL NOT NULL CHECK (rate >= 0),
      PRIMARY KEY (region, vehicle)
    );

    -- Every change to a rate, kept permanently. A rate decides what people are paid, so
    -- "who changed this and when" has to be answerable months later, and the current
    -- value alone cannot answer it. A NULL new_rate records a region being removed.
    CREATE TABLE IF NOT EXISTS rate_changes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      region     TEXT NOT NULL,
      vehicle    TEXT NOT NULL,
      old_rate   REAL,
      new_rate   REAL,
      changed_by TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS rate_changes_by_region ON rate_changes (region, changed_at DESC);

    -- The directory. Email is the key because it is what a claim carries and what a
    -- Google sign-in returns; everything else about a person can change.
    CREATE TABLE IF NOT EXISTS users (
      email                TEXT PRIMARY KEY,
      name                 TEXT NOT NULL DEFAULT '',
      department           TEXT NOT NULL DEFAULT '',
      zone                 TEXT NOT NULL DEFAULT '',
      job_title            TEXT NOT NULL DEFAULT '',
      region               TEXT NOT NULL DEFAULT '',
      manager1_name        TEXT NOT NULL DEFAULT '',
      manager1_email       TEXT NOT NULL DEFAULT '',
      manager2_name        TEXT NOT NULL DEFAULT '',
      manager2_email       TEXT NOT NULL DEFAULT '',
      transport_month      REAL NOT NULL DEFAULT 0,
      transport_per_cycle  REAL NOT NULL DEFAULT 0,
      extra_allowance      REAL NOT NULL DEFAULT 0,
      max_per_cycle        REAL NOT NULL DEFAULT 0,
      out_of_office        INTEGER NOT NULL DEFAULT 0,
      active               INTEGER NOT NULL DEFAULT 1,
      -- An admin's explicit answer to "what may this person do", which wins over the one
      -- read from their job title. Blank means nobody has overridden it and the title
      -- still decides. See resolveRole in store.js.
      system_role          TEXT NOT NULL DEFAULT '',
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS users_by_region ON users (region);
    CREATE INDEX IF NOT EXISTS users_by_manager1 ON users (manager1_email);
    CREATE INDEX IF NOT EXISTS users_by_manager2 ON users (manager2_email);

    -- Claims. The decision log and the two flags are JSON because they are read and
    -- written whole and never queried into; everything filtered on is a real column.
    CREATE TABLE IF NOT EXISTS claims (
      id              TEXT PRIMARY KEY,
      submitted_at    TEXT NOT NULL,
      submitted_by    TEXT NOT NULL,
      staff_name      TEXT NOT NULL DEFAULT '',
      region          TEXT NOT NULL DEFAULT '',
      zone            TEXT NOT NULL DEFAULT '',
      trip_date       TEXT NOT NULL DEFAULT '',
      purpose         TEXT NOT NULL DEFAULT '',
      vehicle         TEXT NOT NULL DEFAULT '',
      km              REAL NOT NULL DEFAULT 0,
      rate            REAL NOT NULL DEFAULT 0,
      estimate        REAL NOT NULL DEFAULT 0,
      amount          REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL,
      assigned_to     TEXT NOT NULL DEFAULT '',
      decision_log    TEXT NOT NULL DEFAULT '[]',
      route           TEXT NOT NULL DEFAULT '',
      cycle_key       TEXT NOT NULL DEFAULT '',
      approval_source TEXT NOT NULL DEFAULT '',
      ceiling         REAL NOT NULL DEFAULT 0,
      proof_file      TEXT NOT NULL DEFAULT '',
      mpesa_code      TEXT NOT NULL DEFAULT '',
      proof_hash      TEXT NOT NULL DEFAULT '',
      duplicate_flag  TEXT,
      review_flag     TEXT,
      completed_at    TEXT NOT NULL DEFAULT '',
      completed_by    TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS claims_by_person ON claims (submitted_by, cycle_key);
    CREATE INDEX IF NOT EXISTS claims_by_status ON claims (status);
    CREATE INDEX IF NOT EXISTS claims_by_region ON claims (region, cycle_key);
  `);

  addColumns(handle, 'users', {
    // Added after the table shipped, so existing databases need it bolted on.
    system_role: "TEXT NOT NULL DEFAULT ''",
  });
}

/**
 * Adds columns that a database created by an earlier version will be missing.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a new column
 * never reaches one. Checked against the live table rather than tracked as a version
 * number, which keeps this honest when a column is added by hand during development.
 */
function addColumns(handle, table, columns) {
  const present = new Set(handle.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (present.has(name)) continue;
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    console.log(`[db] added ${table}.${name}`);
  }
}

/** Closes the handle. Only the tests need this; the server holds it for its lifetime. */
export function closeDb() {
  if (database) { database.close(); database = null; }
}

