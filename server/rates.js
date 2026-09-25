import { all, run, tx } from './db.js';

/**
 * Per-kilometre transport rates, by region.
 *
 * Four modes, not three. A hired piki and someone's own piki are priced differently in
 * every region — 25 against 20 in Rift — and treating them as one key reimbursed personal
 * journeys at the hired rate.
 *
 * There is no default region. Every region is named and carries its own rates, so a
 * region nobody has configured reports zero rather than quietly borrowing someone else's
 * figures: a wrong number that looks right is worse than a visible gap, and the admin
 * screen surfaces the gap so it gets filled.
 */
export const VEHICLES = ['Piki', 'Matatu', 'Personal Piki', 'Personal Car'];

// Seeded on first run only. After that the table is whatever an admin has set.
export const SEED_RATES = {
  Coast: { Piki: 30, Matatu: 35, 'Personal Piki': 25, 'Personal Car': 40 },
  'Lower Western': { Piki: 30, Matatu: 30, 'Personal Piki': 25, 'Personal Car': 40 },
  'Mount Kenya': { Piki: 27, Matatu: 35, 'Personal Piki': 25, 'Personal Car': 40 },
  Nyanza: { Piki: 25, Matatu: 30, 'Personal Piki': 20, 'Personal Car': 35 },
  Rift: { Piki: 25, Matatu: 30, 'Personal Piki': 20, 'Personal Car': 35 },
  'Upper Western': { Piki: 30, Matatu: 30, 'Personal Piki': 25, 'Personal Car': 40 },
};

export async function getRates() {
  // A Default row from an earlier version would act as the fallback this no longer has.
  await run("DELETE FROM rates WHERE region = 'Default'");

  const rows = await all('SELECT region, vehicle, rate FROM rates');
  if (!rows.length) {
    await saveRates(SEED_RATES);
    return structuredClone(SEED_RATES);
  }

  const table = {};
  for (const row of rows) {
    if (!table[row.region]) table[row.region] = {};
    table[row.region][row.vehicle] = row.rate;
  }
  return table;
}

export async function saveRates(table, actor = 'system') {
  const clean = {};
  for (const [region, rates] of Object.entries(table || {})) {
    const name = String(region).trim();
    // "Default" is not a region. Rejecting the name stops the fallback creeping back in.
    if (!name || name.toLowerCase() === 'default') continue;
    clean[name] = Object.fromEntries(VEHICLES.map((vehicle) => [vehicle, Math.max(0, Number(rates?.[vehicle]) || 0)]));
  }

  // What changed, worked out before the write so the log records the transition rather
  // than just the new value.
  const previous = {};
  for (const row of await all('SELECT region, vehicle, rate FROM rates')) {
    if (!previous[row.region]) previous[row.region] = {};
    previous[row.region][row.vehicle] = row.rate;
  }

  const changes = [];
  const at = new Date().toISOString();
  for (const [region, rates] of Object.entries(clean)) {
    for (const vehicle of VEHICLES) {
      const before = previous[region]?.[vehicle];
      if (before === rates[vehicle]) continue;
      changes.push([region, vehicle, before ?? null, rates[vehicle], actor, at]);
    }
  }
  // A region that has gone is a change worth recording too.
  for (const region of Object.keys(previous)) {
    if (clean[region]) continue;
    for (const vehicle of VEHICLES) changes.push([region, vehicle, previous[region][vehicle] ?? null, null, actor, at]);
  }

  // One transaction: a half-written table would price claims from a mix of old and new
  // figures, with nothing to show which, and the log would not match the rates.
  await tx(async ({ run: write }) => {
    await write('DELETE FROM rates');
    for (const [region, rates] of Object.entries(clean)) {
      for (const vehicle of VEHICLES) {
        await write('INSERT INTO rates (region, vehicle, rate) VALUES (?, ?, ?)', [region, vehicle, rates[vehicle]]);
      }
    }
    for (const change of changes) {
      await write('INSERT INTO rate_changes (region, vehicle, old_rate, new_rate, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)', change);
    }
  });
  return clean;
}

/** The rate for one mode in one region. Zero when the region has none — never borrowed. */
export function rateFrom(table, vehicle, region) {
  return table[region]?.[vehicle] ?? 0;
}

/** True when a region has a complete set of rates, which is what "configured" means. */
export function hasRates(table, region) {
  const rates = table[region];
  return Boolean(rates) && VEHICLES.every((vehicle) => Number(rates[vehicle]) > 0);
}

/**
 * Who last touched each region's rates, and when. Keyed by region.
 *
 * Ranked with a window function rather than `MAX(changed_at) GROUP BY region`. SQLite
 * permits a bare `changed_by` beside that MAX and quietly hands back the matching row;
 * Postgres rejects the query outright, so the shorter version would have failed on the
 * first page load after the move. This form is also honest about which row it means.
 */
export async function lastChanged() {
  const rows = await all(`
    SELECT region, changed_by, changed_at FROM (
      SELECT region, changed_by, changed_at,
             ROW_NUMBER() OVER (PARTITION BY region ORDER BY changed_at DESC, id DESC) AS rank
      FROM rate_changes
      WHERE new_rate IS NOT NULL
    ) ranked
    WHERE rank = 1
  `);
  return Object.fromEntries(rows.map((row) => [row.region, { by: row.changed_by, at: row.changed_at }]));
}

/** The full trail for one region, newest first. */
export async function historyFor(region, limit = 100) {
  return all(`
    SELECT region, vehicle, old_rate AS oldRate, new_rate AS newRate, changed_by AS by, changed_at AS at
    FROM rate_changes
    WHERE region = ?
    ORDER BY changed_at DESC, id DESC
    LIMIT ?
  `, [region, limit]);
}
