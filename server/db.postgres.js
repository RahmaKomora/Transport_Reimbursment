import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * The Postgres backend.
 *
 * Selected by `server/db.js` when SONGA_DATABASE_URL is set. It exports the same four
 * functions as db.sqlite.js — `all`/`get`/`run`/`tx` — and nothing above these two files
 * knows which of them answered a query.
 *
 * Two things make that possible, and they are the whole of this file's job:
 *
 *   placeholders  The SQL in this codebase is written with SQLite's `?`. Postgres wants
 *                 $1..$n, so it is rewritten here rather than in every query.
 *   types         Postgres returns numeric as a string (to avoid the float rounding the
 *                 type exists to prevent), timestamptz as a Date and jsonb as a parsed
 *                 object. SQLite returns numbers, ISO strings and JSON text. The parsers
 *                 below settle on SQLite's shapes, so the app keeps reading what it
 *                 always read while the columns underneath gain real types.
 *
 * Normalising towards SQLite rather than the other way round is deliberate: it is the
 * choice that leaves the routes, the cycle arithmetic and the tests untouched. The one
 * place the difference does surface is a missing date — NULL here, the empty string on
 * SQLite — and `store.js` handles that explicitly.
 *
 * Everything lives in one named schema, `transport_reimbursement` by default, and never
 * in `public`. The database is shared one-schema-per-tool, and `public` there already has
 * a `users` table belonging to something else — so the schema is what stops this app's
 * directory landing on top of it. It is applied as the connection's search_path rather
 * than written into each query, so the SQL stays unqualified and identical to the SQLite
 * version. See acquire() for why that is a statement and not a startup parameter.
 */

const { Pool, types } = pg;

/* ------------------------------------------------------------------- the types ----- *
 * Set once, at import, because pg resolves parsers per connection as results arrive.
 */

// Money and distances. numeric(12,2) holds at most ten digits before the point, so every
// value here is exact in a double; the string pg hands back is what would break
// arithmetic silently, by turning `a + b` into concatenation.
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

// count(*) and the rate_changes identity column come back as bigint, which pg also
// stringifies. Counts in this app are directory-sized, nowhere near 2^53.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

// Timestamps as ISO text, which is how every one of them was stored on SQLite and what
// the cycle keys, the `new Date(...)` calls and the JSON responses all already expect.
const iso = (value) => new Date(value).toISOString();
types.setTypeParser(types.builtins.TIMESTAMPTZ, iso);
types.setTypeParser(types.builtins.TIMESTAMP, iso);

// trip_date is a real `date` now. Left as the raw 'YYYY-MM-DD' Postgres sends, because
// parsing it to a Date would move the day across a timezone and the trip date is a
// calendar day, not an instant.
types.setTypeParser(types.builtins.DATE, (value) => value);

// decision_log and the two flags stay JSON text, so store.js's `json()` parses them the
// same way for both backends and there is one code path rather than two.
types.setTypeParser(types.builtins.JSONB, (value) => value);
types.setTypeParser(types.builtins.JSON, (value) => value);

/* -------------------------------------------------------------------- the pool ----- */

export const engine = () => 'postgres';

/**
 * The schema Songa owns.
 *
 * Interpolated into DDL and into the connection's startup options, neither of which takes
 * a parameter, so the name is checked rather than trusted — an unquoted identifier is the
 * one place a stray value in the environment could become SQL.
 */
export const SCHEMA = (() => {
  const name = process.env.SONGA_DB_SCHEMA || 'transport_reimbursement';
  // Mixed case is allowed because the databases this runs against already contain schemas
  // like `Client_360`, and every use below double-quotes the name so case is preserved.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`SONGA_DB_SCHEMA must be a plain identifier (letters, digits, underscore); got "${name}".`);
  }
  return name;
})();

/** Reported by the admin screen, and worth having in a log without the password in it. */
/**
 * Whether the environment describes a Postgres connection at all.
 *
 * Two ways to spell one, because both are in common use:
 *
 *   SONGA_DATABASE_URL   one connection string, which is what a managed instance hands
 *                        you and what a deployment usually sets.
 *   PGDATABASE & friends libpq's own variables — PGHOST, PGPORT, PGUSER, PGPASSWORD,
 *                        PGSSLMODE. `pg` reads these itself, so they are not re-read
 *                        here; the pool is simply left to pick them up.
 *
 * PGDATABASE is the one that counts as the signal. PGHOST and PGUSER are often set in a
 * shell for psql's benefit, and those alone must not silently repoint the app at a
 * different database than the one it was configured for.
 */
export const configured = () => Boolean(connectionUrl() || process.env.PGDATABASE);

/**
 * The connection string, or '' when there is not a usable one.
 *
 * A URL beats the PG* variables — `pg` parses it last and it overrides them key by key —
 * so the template shipped in .env.example has to not count as one. Left in place beside a
 * filled-in set of PG* variables it would win, and the failure is a rejected login for a
 * user called USER, which says nothing about which of the two lines was being used.
 */
const PLACEHOLDER = /\/\/USER:PASSWORD@|\/DATABASE(\?|$)/;

let warnedAboutPlaceholder = false;

function connectionUrl() {
  const url = process.env.SONGA_DATABASE_URL || '';
  if (url && PLACEHOLDER.test(url)) {
    if (!warnedAboutPlaceholder) {
      warnedAboutPlaceholder = true;
      console.warn('[db] SONGA_DATABASE_URL in .env is still the USER:PASSWORD@host/DATABASE template.');
      console.warn('[db] Ignoring it. Fill it in, or delete the line if you are using PGDATABASE and friends.');
    }
    return '';
  }
  return url;
}

export const dbPath = () => {
  const url = connectionUrl();
  if (url) {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname} (schema ${SCHEMA})`;
    } catch {
      return `postgres (schema ${SCHEMA})`;
    }
  }
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || '5432';
  return `${host}:${port}/${process.env.PGDATABASE || ''} (schema ${SCHEMA})`;
};

/**
 * TLS, or no opinion.
 *
 * A managed instance (Neon, Supabase, RDS) requires it; a local one has no certificate
 * and refuses it. SONGA_DATABASE_SSL forces the answer either way, and otherwise the
 * URL's own sslmode decides.
 *
 * Returning undefined matters: `pg` reads PGSSLMODE for itself, but only when no `ssl`
 * key was passed. Passing `ssl: false` as a default would quietly overrule a PGSSLMODE of
 * `require` and the connection would be refused with nothing pointing at the cause.
 */
function sslOption(url) {
  const forced = String(process.env.SONGA_DATABASE_SSL || '').toLowerCase();
  if (forced === 'true') return { rejectUnauthorized: false };
  if (forced === 'false') return false;
  if (/sslmode=(require|verify-ca|verify-full)/.test(url)) return { rejectUnauthorized: false };
  if (/sslmode=disable/.test(url)) return false;
  return undefined;
}

let pool = null;

export function db() {
  if (pool) return pool;
  if (!configured()) {
    throw new Error('Neither SONGA_DATABASE_URL nor PGDATABASE is set, so the Postgres backend has nothing to connect to.');
  }
  const url = connectionUrl();
  const config = {
    max: Number(process.env.SONGA_DB_POOL_MAX || 10),
    // Long enough to survive a managed instance waking from idle, short enough that a
    // wrong host fails on startup instead of hanging the first request for a minute.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  };
  // Each key is set only when there is something to say, because `pg` falls back to the
  // PG* variables per key, and a key present but empty is not a fallback — it is an
  // answer. `connectionString: ''` would mean "no host", not "look at PGHOST".
  if (url) config.connectionString = url;
  const ssl = sslOption(url);
  if (ssl !== undefined) config.ssl = ssl;

  pool = new Pool(config);

  // An idle client dropped by the server reaches us as an error event, and an unhandled
  // one on the pool takes the process down. Reconnecting is the pool's own job.
  pool.on('error', (error) => console.error('[db] idle client error:', error.message));
  return pool;
}

/* ----------------------------------------------------------------- query layer ----- */

/**
 * `?` to $1..$n.
 *
 * Safe for the SQL in this codebase because none of it contains a `?` inside a string
 * literal. Check that still holds if you add a query — a literal question mark would be
 * renumbered into a placeholder and the query would fail on the parameter count.
 */
const toPg = (text) => {
  let n = 0;
  return text.replace(/\?/g, () => `$${++n}`);
};

const rowsOf = (result) => result.rows;

/**
 * Connections that have already been pointed at Songa's schema.
 *
 * Weakly held, so a connection the pool discards is forgotten with it, and a replacement
 * is set up again rather than inheriting the record of its predecessor.
 */
const prepared = new WeakSet();

/**
 * A pooled client with `search_path` already set to Songa's schema.
 *
 * This was a `-c search_path=...` startup parameter, which is tidier and needs no extra
 * round trip. It silently does not work: these databases are reached through a
 * PgBouncer-style pooler on 6432, and a pooler drops startup parameters it does not
 * handle. The connection succeeds, `search_path` stays at its default of `"$user",
 * public`, and every table goes to `public` — where, in this database, a `users` table
 * belonging to another tool already exists.
 *
 * So it is a statement instead, and the first one on the connection. Issuing it from a
 * `pool.on('connect')` handler would be shorter, but that handler cannot be awaited: the
 * query overlaps whatever the pool's caller sends next, which pg deprecates and removes
 * in 9.0. Doing it on checkout is explicit, awaited, and costs one round trip per
 * connection rather than per query — the pool keeps its clients, so the WeakSet above
 * means this is paid once each.
 */
async function acquire() {
  const client = await db().connect();
  if (prepared.has(client)) return client;
  try {
    await client.query(`SET search_path TO "${SCHEMA}"`);
    prepared.add(client);
    return client;
  } catch (error) {
    // Passing the error discards the connection rather than returning it to the pool: a
    // client whose search_path is unknown must not serve a query.
    client.release(error);
    throw error;
  }
}

/** Every matching row. */
export async function all(text, params = []) {
  const client = await acquire();
  try {
    return rowsOf(await client.query(toPg(text), params));
  } finally {
    client.release();
  }
}

/** The first matching row, or undefined. */
export async function get(text, params = []) {
  const client = await acquire();
  try {
    return rowsOf(await client.query(toPg(text), params))[0];
  } finally {
    client.release();
  }
}

/** A write. Returns how many rows it touched. */
export async function run(text, params = []) {
  const client = await acquire();
  try {
    return { changes: (await client.query(toPg(text), params)).rowCount ?? 0 };
  } finally {
    client.release();
  }
}

/**
 * Runs a function inside one transaction, handing it the same all/get/run.
 *
 * The handed-in trio is bound to one client checked out of the pool, which is the whole
 * point: the pool hands out a different connection per query, so a BEGIN issued on one
 * would apply to none of the statements that followed and the "transaction" would be
 * three independent writes. SQLite's re-entrancy guard is not needed here — a second
 * overlapping transaction gets its own client and is a queue rather than an error.
 */
export async function tx(work) {
  const client = await acquire();
  const scoped = {
    all: async (text, params = []) => rowsOf(await client.query(toPg(text), params)),
    get: async (text, params = []) => rowsOf(await client.query(toPg(text), params))[0],
    run: async (text, params = []) => ({ changes: (await client.query(toPg(text), params)).rowCount ?? 0 }),
  };
  try {
    await client.query('BEGIN');
    const result = await work(scoped);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A failed ROLLBACK means the connection is already gone, which is the error we want
    // to report, not this one. Releasing it below discards it either way.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ---------------------------------------------------------------------- schema ----- */

const schemaFile = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.postgres.sql');

/**
 * Applies schema.postgres.sql.
 *
 * Every statement in it is IF NOT EXISTS and the file is one transaction, so running it
 * against a populated database is a no-op rather than a risk. That is what lets db.js
 * call it at startup, keeping this backend as self-setting-up as the SQLite one, where
 * migrate() has always done exactly the same job.
 *
 * Also what `npm run db:setup` runs, so applying the schema needs no psql on the PATH.
 */
export async function applySchema() {
  const client = await acquire();
  try {
    // The schema has to exist before an unqualified CREATE TABLE can land in it: with a
    // search_path naming only a schema that is not there, Postgres refuses with "no
    // schema has been selected to create in".
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    // Check, rather than assume, that unqualified names now resolve to our schema. The
    // startup-parameter version of this failed silently against a pooler and would have
    // created four tables in `public`, on top of another tool's `users`. A wrong answer
    // here has to stop the migration, not be discovered in the data later.
    const { rows } = await client.query('SELECT current_schema() AS name');
    if (rows[0]?.name !== SCHEMA) {
      throw new Error(
        `search_path did not take: unqualified tables would be created in `
        + `"${rows[0]?.name ?? 'nothing'}" rather than "${SCHEMA}". `
        + 'A connection pooler that drops the search_path setting is the usual cause.',
      );
    }

    // One transaction, so a half-applied schema is never left behind. The file itself
    // carries no BEGIN, because it is applied through here rather than through psql.
    await client.query('BEGIN');
    await client.query(readFileSync(schemaFile(), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Closes the pool. Returns a promise; the server holds the pool for its lifetime. */
export function closeDb() {
  if (!pool) return Promise.resolve();
  const closing = pool.end();
  pool = null;
  return closing;
}
