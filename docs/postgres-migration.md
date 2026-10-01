# Running Songa on Postgres

Written for whoever sets up or moves an instance. It assumes you can create a Postgres
database; it does not assume you have worked on Songa before.

## Where things stand

Both backends work. `server/db.js` picks one at import and nothing above it knows which:

| `SONGA_DATABASE_URL` | Backend | Used for |
| --- | --- | --- |
| set | Postgres, `server/db.postgres.js` | running the app |
| unset | SQLite, `server/db.sqlite.js` | a fresh checkout, and the test suite |

On Postgres, everything lives in one named schema — see below.

SQLite was kept rather than deleted for two reasons. The suite runs against throwaway
`.db` files in under a second, which no Postgres instance will match, and a fresh clone
works before anybody has a connection string.

## This tool owns a schema, not a database

`tupande_automations` is a shared database, one schema per tool: `Client_360`,
`zs_cockpit`, and now `transport_reimbursement`. Every table this app creates lives in
that last one and never in `public`.

That is not tidiness. `public` in that database **already contains a `users` table**
belonging to something else, and so does `Client_360`. Unqualified writes landing in
`public` would have put Songa's directory on top of another tool's data.

`public` is therefore deliberately *not* in the search path either. An unqualified name
that is not ours should fail to resolve rather than quietly find somebody else's table.

The name comes from `SONGA_DB_SCHEMA`, defaulting to `transport_reimbursement`. It is
interpolated into DDL and into a `SET` — neither of which takes a parameter — so
`db.postgres.js` checks it is a plain identifier and throws if not, rather than trusting
the environment. Mixed case is allowed, because `Client_360` exists; every use quotes it.

### Why `search_path` is a statement and not a startup parameter

The obvious way to pin it is the `options` startup parameter, which needs no extra round
trip and applies before the first query can run:

```js
options: `-c search_path=${SCHEMA}`   // does not work here
```

**It silently does nothing.** The database is reached through a PgBouncer-style pooler on
port 6432 — 5432 is closed — and a pooler drops startup parameters it does not handle.
The connection succeeds, `search_path` stays at its default `"$user", public`, and every
table goes to `public`. That was observed, not guessed: `current_schema()` came back
`public` on a connection opened with that option set.

So it is a `SET`, issued as the first statement on each pooled connection and remembered
in a `WeakSet` so it costs one round trip per connection rather than per query. The pooler
turned out to be in session mode — a `SET` survives explicit transactions and concurrent
peers on the same connection, while a fresh connection starts clean — which is what makes
per-connection setup sound rather than per-query.

Issuing it from `pool.on('connect')` is shorter and is the common idiom, but that handler
cannot be awaited: the query overlaps whatever the pool's caller sends next. `pg`
deprecates that and removes it in 9.0, so it is done on checkout instead.

`applySchema()` then **verifies** `current_schema()` matches before creating anything. The
startup-parameter version failed silently; a wrong answer there has to stop the migration
rather than be discovered in the data later.

## Setting it up

Put the connection in `.env` (gitignored; `.env.example` is the template), then:

```bash
npm run db:setup     # creates the schema and its tables. Idempotent.
npm run dev:all
```

Two ways to spell the connection, and **only one of them at a time** — a URL overrides the
`PG*` variables key by key inside `pg`, so a leftover URL line wins silently:

```bash
# Either one string, which is what a managed instance hands you:
SONGA_DATABASE_URL=postgres://user:password@host:5432/dbname

# ...or libpq's own variables, which `pg` reads itself. Exactly these names.
PGHOST=…  PGPORT=…  PGUSER=…  PGPASSWORD=…  PGDATABASE=…  PGSSLMODE=…
```

`PGDATABASE` is what selects the Postgres backend. `PGHOST` and `PGUSER` deliberately do
not: they are often set in a shell for psql's benefit, and those alone must not repoint
the app. In the URL form a password containing `@ : / ? #` has to be percent-encoded; in
the `PG*` form it does not, which is one reason to prefer it.

`SONGA_DATABASE_URL` left at the `USER:PASSWORD@host/DATABASE` template from
`.env.example` is detected and ignored, with a warning. Otherwise it would beat a
filled-in set of `PG*` variables and the error would be a rejected login for a user called
`USER`, which says nothing about which line was at fault.

On SSL: `PGSSLMODE` is read by `pg` itself, but **only when no `ssl` key is passed**. So
`sslOption()` returns `undefined` when it has no explicit instruction, rather than
defaulting to `false` and overruling `PGSSLMODE` with nothing explaining why.

The server applies the schema at startup too, so `db:setup` is really the chance to see
the table list before anything else runs.

### Bringing existing SQLite data across

Only needed if an instance has been running on SQLite. A fresh install skips this — the
app seeds the rate table on first use and the directory starts empty either way.

```bash
npm run export:postgres                                   # reads the SQLite file
psql "$SONGA_DATABASE_URL" -f server/data/songa-postgres.sql
```

The generated file sets its own `search_path`, so it loads into Songa's schema rather than
into `public`.

The export converts as it goes — booleans, timestamps and money all change type — and the
output is one transaction that truncates first, so it is the whole dataset rather than an
increment and a failure leaves nothing behind. That makes it safe to rehearse as often as
you like.

## How the two backends are kept interchangeable

`server/db.postgres.js` exports the same four functions as the SQLite one — `all`, `get`,
`run`, `tx` — and does two things to make that honest.

**Placeholders.** The SQL throughout is written with SQLite's `?`, rewritten to `$1..$n`
in the adapter rather than in every query. Safe here because none of the SQL contains a
`?` inside a string literal; check that still holds if you add a query, because a literal
question mark would be renumbered into a placeholder.

**Types.** Postgres returns `numeric` as a string, `timestamptz` as a `Date` and `jsonb`
as a parsed object. SQLite returns numbers, ISO strings and JSON text. The adapter sets
type parsers that settle on SQLite's shapes, so the routes, the cycle arithmetic and the
tests all keep reading what they always read while the columns underneath gain real types.

Normalising towards SQLite rather than the other way round is what kept this a new module
instead of an edit to every caller.

**Transactions.** `tx` checks one client out of the pool and binds the `all`/`get`/`run`
it hands the callback to that client. This is not optional: the pool hands out a different
connection per query, so a `BEGIN` issued on one would apply to none of the statements
after it and the transaction would silently be three independent writes. SQLite's
re-entrancy guard is gone here — a second overlapping transaction gets its own client and
is a queue rather than an error.

## The differences that bit, and what was done about them

### Money stopped being a float

SQLite stores every amount as `REAL`. The Postgres schema uses `numeric(12,2)`, because
money in a float eventually produces a total that is off by a cent and cannot be explained
to finance. Nothing had gone wrong yet — every amount stored was whole shillings — so this
was a free correction rather than a repair.

`pg` returns `numeric` as a **string**, to avoid the very precision loss the type exists to
prevent. Left alone that turns `a + b` into string concatenation. Handled twice over: a
type parser in the adapter, and explicit `Number(...)` in `toUser`/`toClaim` in
`server/store.js` and in `getRates`/`saveRates` in `server/rates.js`. The `rates.js` one
matters more than it looks — it compares old and new rates with `===` to decide what to
log, and `'25' !== 25` would have logged a change to every rate on every save.

### Booleans stopped being 0 and 1

`out_of_office` and `active` are `INTEGER` in SQLite and `boolean` in Postgres. `toUser`
read `row.active === 1`, which is `false` for a real boolean `true`.

**This one fails silently and dangerously**: every person would read as inactive, which
means nobody can sign in and every budget total reads zero. `toUser` now uses
`Boolean(row.active)`, which is right for both, and the writes send `true`/`false`. The
SQLite adapter converts those to 0/1 when it binds them, because its binder throws on a
JavaScript boolean rather than coercing it.

### Timestamps stopped being text

`timestamptz` and `date` in Postgres, ISO text in SQLite. The adapter's type parsers hand
timestamps back as ISO strings, so the string comparisons in `server/regions.js` and the
cycle arithmetic in `server/cycles.js` keep working untouched. `trip_date` is deliberately
left as the raw `'YYYY-MM-DD'` rather than parsed into a `Date`, because a trip date is a
calendar day and parsing it would shift it across a timezone.

One difference the adapter cannot hide: a missing date is `NULL` on Postgres and `''` on
SQLite, and a `date` column rejects `''` outright. `trip_date` and `completed_at` are the
two columns affected. `store.js` writes whichever the backend wants through `blankDate()`,
and `toClaim` maps both back to `''` so the rest of the app keeps the one falsy blank it
was written for.

### `system_role` was missing from the Postgres schema

The column was added to SQLite after `schema.postgres.sql` was first written, and the
schema and the export had both missed it. Dropping it on the way across would have handed
everybody back the role their job title implies, undoing every deliberate choice an admin
had made. Both now carry it, and the schema has an `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` so an instance built from the earlier file picks it up.

### The GROUP BY that only worked in SQLite

`lastChanged()` in `server/rates.js` used to be:

```sql
SELECT region, changed_by, MAX(changed_at) AS changed_at
FROM rate_changes WHERE new_rate IS NOT NULL GROUP BY region
```

SQLite permits the bare `changed_by` beside that `MAX` and quietly returns it from the
matching row. Postgres rejects the query outright — it would have failed on the first load
of the Transport Rates page after the cutover. Rewritten with `ROW_NUMBER()`, which both
engines accept and which is clearer about which row it means.

### `DELETE`-then-`INSERT` in `updateClaim`

`store.js` updates a claim by deleting the row and re-inserting it inside a transaction.
It works on Postgres, but a real `UPDATE ... SET` would be better there — cheaper, and it
does not churn the table. Not required, and not done.

## Testing

`npm test` runs against SQLite by design. The three test files that touch the database
delete `SONGA_DATABASE_URL` from the environment before importing `db.js`, so a connection
string in your `.env` cannot send a test run at a real instance and rewrite its contents.

To exercise the Postgres adapter, set `SONGA_TEST_DATABASE_URL`:

```bash
SONGA_TEST_DATABASE_URL="$SONGA_DATABASE_URL" npm test
```

The same connection string as the real one is fine, and is the point of owning a schema:
`server/postgres.test.js` builds its own `transport_reimbursement_pgtest` schema, creates
the real tables in there, and drops the whole thing afterwards. It never touches the live
tables.

**Point it only at a database where creating a schema is yours to do** — not the shared
`tupande_automations` one, which is one schema per tool and nothing else. It stays opt-in
for that reason, and because a test run should not need a server to be reachable.

It covers only what differs between the backends — the type conversions, the placeholder
rewrite, transaction commit and rollback over a pool, schema resolution, and the
`store.js` mappers over real rows.

## Checks worth running after a data load

```sql
-- Nobody lost their access. Compare against the SQLite count before you cut over.
SELECT active, count(*) FROM users GROUP BY active;

-- Money survived the type change intact.
SELECT sum(transport_per_cycle) FROM users;
SELECT status, count(*), sum(amount) FROM claims GROUP BY status;

-- Roles an admin set deliberately came across.
SELECT system_role, count(*) FROM users GROUP BY system_role;

-- Timestamps parsed rather than landing as NULL.
SELECT count(*) FROM claims WHERE submitted_at IS NULL;
```

Then sign in, open **Admin → Regional Budgets**, and check the allocation total matches
what SQLite reported. It reads users, claims and rates in one page, so it exercises all
three tables and the arithmetic over them.
