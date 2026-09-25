import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { all, closeDb, dbPath } from './db.js';

/**
 * Dumps the SQLite database as Postgres-loadable SQL.
 *
 * Not pg_dump and not a generic tool: SQLite's dump would carry its own type names, its
 * 0/1 booleans and its quoted-text timestamps straight into Postgres, where three of
 * those are wrong. This converts as it goes, to match server/schema.postgres.sql.
 *
 *   npm run export:postgres
 *   psql "$SONGA_DATABASE_URL" -f server/schema.postgres.sql
 *   psql "$SONGA_DATABASE_URL" -f server/data/songa-postgres.sql
 *
 * The output is one transaction, so a failure part way through leaves an empty database
 * rather than half a directory. Re-runnable: it truncates first.
 */

/** Postgres string literal. Doubling the quote is the only escape it needs. */
const text = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '0';
};

const bool = (value) => (value ? 'true' : 'false');

/** A stored ISO string becomes a timestamptz literal; blank becomes NULL, not epoch. */
const stamp = (value) => {
  if (!value) return 'NULL';
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? 'NULL' : `${text(when.toISOString())}::timestamptz`;
};

/** Claims store the trip day as 'YYYY-MM-DD' and sometimes as nothing at all. */
const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? `${text(value)}::date` : 'NULL');

/** The JSON columns are already JSON text, or blank. Invalid text becomes NULL, loudly. */
const jsonb = (value, { orEmptyArray = false } = {}) => {
  if (value === null || value === undefined || value === '') return orEmptyArray ? `'[]'::jsonb` : 'NULL';
  try {
    JSON.parse(value);
  } catch {
    console.warn(`  ! unparseable JSON dropped: ${String(value).slice(0, 60)}`);
    return orEmptyArray ? `'[]'::jsonb` : 'NULL';
  }
  return `${text(value)}::jsonb`;
};

function insert(table, columns, rows) {
  if (!rows.length) return `-- ${table}: nothing to load\n`;
  const values = rows.map((row) => `  (${row.join(', ')})`).join(',\n');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values};\n`;
}

async function main() {
  console.log(`Reading ${dbPath()}`);

  const rates = await all('SELECT region, vehicle, rate FROM rates ORDER BY region, vehicle');
  const changes = await all('SELECT region, vehicle, old_rate, new_rate, changed_by, changed_at FROM rate_changes ORDER BY id');
  const users = await all('SELECT * FROM users ORDER BY email');
  const claims = await all('SELECT * FROM claims ORDER BY submitted_at');

  const parts = [
    '-- Songa data, converted from SQLite for Postgres.',
    `-- Generated ${new Date().toISOString()} from ${dbPath()}`,
    '-- Run server/schema.postgres.sql first.',
    '',
    'BEGIN;',
    '',
    '-- Re-runnable: this file is the whole dataset, not an increment.',
    'TRUNCATE rates, rate_changes, users, claims;',
    '',
    insert('rates', ['region', 'vehicle', 'rate'],
      rates.map((r) => [text(r.region), text(r.vehicle), number(r.rate)])),
    '',
    insert('rate_changes', ['region', 'vehicle', 'old_rate', 'new_rate', 'changed_by', 'changed_at'],
      changes.map((r) => [
        text(r.region), text(r.vehicle),
        r.old_rate === null ? 'NULL' : number(r.old_rate),
        r.new_rate === null ? 'NULL' : number(r.new_rate),
        text(r.changed_by), stamp(r.changed_at),
      ])),
    '',
    insert('users', ['email', 'name', 'department', 'zone', 'job_title', 'region',
      'manager1_name', 'manager1_email', 'manager2_name', 'manager2_email',
      'transport_month', 'transport_per_cycle', 'extra_allowance', 'max_per_cycle',
      'out_of_office', 'active', 'created_at', 'updated_at'],
      users.map((u) => [
        text(u.email), text(u.name), text(u.department), text(u.zone), text(u.job_title), text(u.region),
        text(u.manager1_name), text(u.manager1_email), text(u.manager2_name), text(u.manager2_email),
        number(u.transport_month), number(u.transport_per_cycle), number(u.extra_allowance), number(u.max_per_cycle),
        bool(u.out_of_office), bool(u.active), stamp(u.created_at), stamp(u.updated_at),
      ])),
    '',
    insert('claims', ['id', 'submitted_at', 'submitted_by', 'staff_name', 'region', 'zone', 'trip_date',
      'purpose', 'vehicle', 'km', 'rate', 'estimate', 'amount', 'status', 'assigned_to', 'decision_log',
      'route', 'cycle_key', 'approval_source', 'ceiling', 'proof_file', 'mpesa_code', 'proof_hash',
      'duplicate_flag', 'review_flag', 'completed_at', 'completed_by'],
      claims.map((c) => [
        text(c.id), stamp(c.submitted_at), text(c.submitted_by), text(c.staff_name), text(c.region),
        text(c.zone), day(c.trip_date), text(c.purpose), text(c.vehicle),
        number(c.km), number(c.rate), number(c.estimate), number(c.amount),
        text(c.status), text(c.assigned_to), jsonb(c.decision_log, { orEmptyArray: true }),
        text(c.route), text(c.cycle_key), text(c.approval_source), number(c.ceiling),
        text(c.proof_file), text(c.mpesa_code), text(c.proof_hash),
        jsonb(c.duplicate_flag), jsonb(c.review_flag), stamp(c.completed_at), text(c.completed_by),
      ])),
    '',
    'COMMIT;',
    '',
  ];

  const out = path.join(process.cwd(), 'server', 'data', 'songa-postgres.sql');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, parts.join('\n'), 'utf8');

  console.log('');
  console.log(`Wrote ${out}`);
  console.log(`  rates:        ${rates.length}`);
  console.log(`  rate changes: ${changes.length}`);
  console.log(`  people:       ${users.length}`);
  console.log(`  claims:       ${claims.length}`);
  console.log('');
  console.log('Then: psql "$SONGA_DATABASE_URL" -f server/schema.postgres.sql');
  console.log('      psql "$SONGA_DATABASE_URL" -f server/data/songa-postgres.sql');
  closeDb();
}

main().catch((error) => { console.error(error); process.exit(1); });
