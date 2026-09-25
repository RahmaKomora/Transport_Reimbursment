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
-- Load with:  psql "$SONGA_DATABASE_URL" -f server/schema.postgres.sql

BEGIN;

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
  created_at           timestamptz   NOT NULL,
  updated_at           timestamptz   NOT NULL
);

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

COMMIT;
