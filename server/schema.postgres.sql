-- Songa on Postgres.
--
-- The target schema for the move off SQLite. It is deliberately not a transliteration of
-- the SQLite one: three kinds of column are wrong in a way SQLite tolerates and Postgres
-- gives us the chance to fix.
--
--   money      REAL -> numeric(12,2). REAL is a float, and money in a float eventually
--              produces a total that is off by a cent and cannot be explained to finance.
--              Every amount here is whole shillings today, so nothing has gone wrong yet
--              and nothing is lost by converting.
--   booleans   INTEGER 0/1 -> boolean. The application already treats these as true and
--              false; only the storage was pretending otherwise.
--   timestamps TEXT ISO-8601 -> timestamptz. Stored as text they sort correctly but
--              cannot be compared, subtracted, or grouped by month without parsing, and
--              the cycle boundary work already needs all three.
--
-- Cycle keys ("2026-09-C2") stay text: they are an identifier the app coins, not a date.
--
-- Every table here is unqualified on purpose. It is applied with the connection's
-- search_path already pointing at the schema this tool owns — `transport_reimbursement`
-- unless SONGA_DB_SCHEMA says otherwise — which keeps this SQL identical to the SQLite
-- version instead of having a schema name threaded through every statement. The database
-- is shared, so that schema is also what stops these four tables colliding with anybody
-- else's `users`.
--
-- The schema name comes from configuration, so this file cannot create the schema or set
-- the search_path itself, and it carries no BEGIN/COMMIT because the caller wraps it.
--
-- Apply with:  npm run db:setup
--
-- Which needs no psql on the PATH. To use psql anyway, do by hand what db:setup does:
--
--   psql "$SONGA_DATABASE_URL" \
--     -c 'CREATE SCHEMA IF NOT EXISTS transport_reimbursement' \
--     -c 'SET search_path TO transport_reimbursement' -f server/schema.postgres.sql

CREATE TABLE IF NOT EXISTS rates (
  region   text          NOT NULL,
  vehicle  text          NOT NULL,
  rate     numeric(10,2) NOT NULL CHECK (rate >= 0),
  PRIMARY KEY (region, vehicle)
);

-- Every change to a rate, kept permanently. A rate decides what people are paid, so
-- "who changed this and when" has to be answerable months later, and the current value
-- alone cannot answer it. A NULL new_rate records a region being removed.
CREATE TABLE IF NOT EXISTS rate_changes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region     text        NOT NULL,
  vehicle    text        NOT NULL,
  old_rate   numeric(10,2),
  new_rate   numeric(10,2),
  changed_by text        NOT NULL,
  changed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_changes_by_region ON rate_changes (region, changed_at DESC);

-- The directory. Email is the key because it is what a claim carries and what a Google
-- sign-in returns; everything else about a person can change.
CREATE TABLE IF NOT EXISTS users (
  email                text          PRIMARY KEY,
  name                 text          NOT NULL DEFAULT '',
  department           text          NOT NULL DEFAULT '',
  zone                 text          NOT NULL DEFAULT '',
  job_title            text          NOT NULL DEFAULT '',
  region               text          NOT NULL DEFAULT '',
  manager1_name        text          NOT NULL DEFAULT '',
  manager1_email       text          NOT NULL DEFAULT '',
  manager2_name        text          NOT NULL DEFAULT '',
  manager2_email       text          NOT NULL DEFAULT '',
  transport_month      numeric(12,2) NOT NULL DEFAULT 0,
  transport_per_cycle  numeric(12,2) NOT NULL DEFAULT 0,
  extra_allowance      numeric(12,2) NOT NULL DEFAULT 0,
  max_per_cycle        numeric(12,2) NOT NULL DEFAULT 0,
  out_of_office        boolean       NOT NULL DEFAULT false,
  active               boolean       NOT NULL DEFAULT true,
  -- An admin's explicit answer to "what may this person do", which wins over the one read
  -- from their job title. Blank means nobody has overridden it and the title still
  -- decides. See resolveRole in server/store.js.
  system_role          text          NOT NULL DEFAULT '',
  created_at           timestamptz   NOT NULL,
  updated_at           timestamptz   NOT NULL
);

-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a column
-- added after an instance was first built never reaches it. Spelled out per column, with
-- IF NOT EXISTS, which keeps re-running this file a no-op.
ALTER TABLE users ADD COLUMN IF NOT EXISTS system_role text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS users_by_region ON users (region);
CREATE INDEX IF NOT EXISTS users_by_manager1 ON users (manager1_email);
CREATE INDEX IF NOT EXISTS users_by_manager2 ON users (manager2_email);

-- Claims. The decision log and the two flags are JSON because they are read and written
-- whole and never queried into; everything filtered on is a real column. jsonb rather
-- than text so that stops being true the day somebody needs to query one.
CREATE TABLE IF NOT EXISTS claims (
  id              text          PRIMARY KEY,
  submitted_at    timestamptz   NOT NULL,
  submitted_by    text          NOT NULL,
  staff_name      text          NOT NULL DEFAULT '',
  region          text          NOT NULL DEFAULT '',
  zone            text          NOT NULL DEFAULT '',
  trip_date       date,
  purpose         text          NOT NULL DEFAULT '',
  vehicle         text          NOT NULL DEFAULT '',
  km              numeric(10,2) NOT NULL DEFAULT 0,
  rate            numeric(10,2) NOT NULL DEFAULT 0,
  estimate        numeric(12,2) NOT NULL DEFAULT 0,
  amount          numeric(12,2) NOT NULL DEFAULT 0,
  status          text          NOT NULL,
  assigned_to     text          NOT NULL DEFAULT '',
  decision_log    jsonb         NOT NULL DEFAULT '[]'::jsonb,
  route           text          NOT NULL DEFAULT '',
  cycle_key       text          NOT NULL DEFAULT '',
  approval_source text          NOT NULL DEFAULT '',
  ceiling         numeric(12,2) NOT NULL DEFAULT 0,
  proof_file      text          NOT NULL DEFAULT '',
  mpesa_code      text          NOT NULL DEFAULT '',
  proof_hash      text          NOT NULL DEFAULT '',
  duplicate_flag  jsonb,
  review_flag     jsonb,
  completed_at    timestamptz,
  completed_by    text          NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS claims_by_person ON claims (submitted_by, cycle_key);
CREATE INDEX IF NOT EXISTS claims_by_status ON claims (status);
CREATE INDEX IF NOT EXISTS claims_by_region ON claims (region, cycle_key);

-- Duplicate detection looks up an M-Pesa code and an image hash on every submission.
-- Partial, because most claims have neither and indexing the blanks helps nobody.
CREATE INDEX IF NOT EXISTS claims_by_mpesa ON claims (mpesa_code) WHERE mpesa_code <> '';
CREATE INDEX IF NOT EXISTS claims_by_proof_hash ON claims (proof_hash) WHERE proof_hash <> '';
