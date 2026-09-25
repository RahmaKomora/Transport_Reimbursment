# Moving Songa from SQLite to Postgres

Written for whoever runs the migration. It assumes you can create a Postgres database and
run `psql`; it does not assume you have worked on Songa before.

## Where things stand

The data layer has been prepared so that the switch is a change to one file plus a data
load. Nothing in the routes, the tests, or the business logic should need to move.

**Done:**

- Every database call goes through `all` / `get` / `run` / `tx` in `server/db.js`. No
  other module imports the driver. Those four functions are the entire contract.
- All four are `async`, and every caller already awaits them, even though SQLite answers
  synchronously. This was the largest piece of the work — Postgres has no synchronous
  client, so a synchronous data layer would have made this a rewrite of every route that
  touches data rather than a rewrite of one file.
- The SQL has been narrowed to what both engines accept. One query had to change: see
  *The GROUP BY that only worked in SQLite* below.
- `server/schema.postgres.sql` is the target schema.
- `npm run export:postgres` converts the current data into a Postgres-loadable file.

**Not done, deliberately:**

- No `pg` dependency and no Postgres adapter. There is no instance to test one against, so
  it would be untested code that looks finished. Writing it is described below and is
  perhaps an hour's work once a database exists.

## What still has to be written

Replace the body of `server/db.js` with a `pg`-backed version exposing the same four
functions. Two details it must handle:

**Placeholders.** The SQL throughout uses SQLite's `?`. Postgres wants `$1..$n`. Rewrite
in the adapter rather than editing every query:

```js
const toPg = (text) => { let n = 0; return text.replace(/\?/g, () => `$${++n}`); };
```

This is safe for the SQL in this codebase because none of it contains a `?` inside a
string literal. Check that still holds if you add queries.

**Transactions.** `tx` currently guards against re-entry because there is a single
connection. On Postgres, check a client out of the pool per transaction and pass an
`all`/`get`/`run` bound to that client — otherwise the statements inside a transaction go
out on different connections and the `BEGIN` applies to none of them. The re-entrancy
guard goes away once each transaction has its own client. Use `BEGIN`, not SQLite's
`BEGIN IMMEDIATE`, which Postgres rejects.

Also drop the two `PRAGMA` statements and `migrate()` — the schema is applied from
`schema.postgres.sql` instead.

## Differences that actually bite

### Money stops being a float

SQLite stores every amount as `REAL`, which is a float. `schema.postgres.sql` uses
`numeric(12,2)`. Money in a float eventually produces a total that is off by a cent and
cannot be explained to finance.

Nothing has gone wrong yet — every amount currently stored is whole shillings — so this
is a free correction rather than a repair. Take it now; changing a column type later, with
history in it, is a different job.

One consequence: `pg` returns `numeric` as a **string**, not a number, to avoid the very
precision loss the type exists to prevent. `Number(row.amount)` where the code does
arithmetic, or set a type parser. The mappers in `server/store.js` (`toUser`, `toClaim`)
are the right place — they already exist to keep column names out of the rest of the app.

### Booleans stop being 0 and 1

`out_of_office` and `active` are `INTEGER` in SQLite and `boolean` in Postgres. `toUser`
currently reads `row.active === 1`, which will be `false` for a real boolean `true`. That
comparison must become `row.active === true` or just `Boolean(row.active)`, and the
writes must send `true`/`false` instead of `1`/`0`.

**This one fails silently and dangerously**: every user would read as inactive, which
means nobody can sign in and every budget total reads zero. Change it in the same commit
as the adapter, not after.

### Timestamps stop being text

Stored as ISO text they sort correctly but cannot be compared, subtracted or grouped by
month without parsing. `schema.postgres.sql` uses `timestamptz`. `pg` returns those as
JavaScript `Date` objects, so anything that currently expects a string — `claim.submittedAt`
is passed to `new Date()` in several places, which is fine, but it is also compared with
`<` against other strings in `regions.js` — needs checking. The cycle logic in
`server/cycles.js` is the area to review.

`trip_date` becomes `date` and `completed_at` becomes nullable `timestamptz`, where today
a missing value is the empty string.

### The GROUP BY that only worked in SQLite

`lastChanged()` in `server/rates.js` used to be:

```sql
SELECT region, changed_by, MAX(changed_at) AS changed_at
FROM rate_changes WHERE new_rate IS NOT NULL GROUP BY region
```

SQLite permits the bare `changed_by` beside that `MAX` and quietly returns it from the
matching row. Postgres rejects the query outright — it would have failed on the first
load of the Transport Rates page after the cutover. It has been rewritten with a
`ROW_NUMBER()` window function, which both engines accept and which is clearer about
which row it means. Already fixed; noted because it is the kind of thing to look for if
you add queries.

### `DELETE`-then-`INSERT` in `updateClaim`

`store.js` updates a claim by deleting the row and re-inserting it inside a transaction.
It works on Postgres, but a real `UPDATE ... SET` would be better there — cheaper, and it
does not churn the table. Not required for the cutover.

## Runbook

```bash
# 1. Create the database and apply the schema.
createdb songa
psql "$SONGA_DATABASE_URL" -f server/schema.postgres.sql

# 2. Convert the current SQLite contents.
npm run export:postgres

# 3. Load them. Both files are single transactions; a failure leaves nothing behind.
psql "$SONGA_DATABASE_URL" -f server/data/songa-postgres.sql

# 4. Point the app at it and run the suite.
export SONGA_DATABASE_URL=postgres://...
npm test
```

The export is re-runnable: it truncates before loading, so it is the whole dataset rather
than an increment. That makes it safe to rehearse the migration as many times as you like.

### Checks worth running after the load

These are the ones that would catch the failures described above.

```sql
-- Nobody lost their access. Compare against the SQLite count before you cut over.
SELECT active, count(*) FROM users GROUP BY active;

-- Money survived the type change intact.
SELECT sum(transport_per_cycle) FROM users;
SELECT status, count(*), sum(amount) FROM claims GROUP BY status;

-- Timestamps parsed rather than landing as NULL.
SELECT count(*) FROM claims WHERE submitted_at IS NULL;
```

Then sign in, open **Admin → Regional Budgets**, and check the allocation total matches
what SQLite reported. It reads users, claims and rates in one page, so it exercises all
three tables and the arithmetic over them.

## Keeping SQLite working

Nothing here removes SQLite. Until the adapter is written it remains the only backend, and
after that it is still the sensible thing for tests and local development: the suite
currently runs against throwaway `.db` files in about a second, which no Postgres instance
will match. Keeping both means `server/db.js` choosing a driver on `SONGA_DATABASE_URL`.
