import cron from 'node-cron';
import { BATCH_HOUR_EAT, TIMEZONE, cycleFromKey, getCycleDetails, isClosed, previousCycle } from './cycles.js';
import { readClaims, updateClaim } from './store.js';
import { run } from './db.js';
import { STATUS, applyDecision } from './routing.js';
import { buildBatchReport, notifyHr } from './notifications.js';

// Cycle 1 closes on the 16th, Cycle 2 on the 1st of the following month, both at 08:00
// Nairobi time. node-cron applies the timezone itself, so these fire at 08:00 EAT
// regardless of where the process runs.
const SCHEDULE_CYCLE_1 = `0 ${BATCH_HOUR_EAT} 16 * *`;
const SCHEDULE_CYCLE_2 = `0 ${BATCH_HOUR_EAT} 1 * *`;

/**
 * Seals a closed cycle: every APPROVED claim tagged with that cycle becomes
 * BATCHED_FOR_HR, and HR gets one summary grouped by region.
 *
 * Idempotent. Claims already batched or paid are skipped, so a second run — a restart, a
 * manual trigger, an overlapping catch-up — does nothing and sends no second notification.
 *
 * Safe across replicas too. Every pod runs the scheduler, so at 08:00 every pod calls this
 * at once; the lease below lets one of them in and turns the rest away, and the status
 * check inside each update stops a claim that changed since it was read — paid, rejected,
 * already sealed — from being pulled back into a batch.
 *
 * @param {string} cycleKey e.g. "2026-09-C1"
 * @param {{force?: boolean, notify?: boolean}} [options] force runs before the batch moment.
 */
export async function runBatch(cycleKey, { force = false, notify = true } = {}) {
  const cycle = cycleFromKey(cycleKey);
  if (!cycle) return { ok: false, error: `Not a cycle key: ${cycleKey}` };
  if (!force && !isClosed(cycle)) {
    return { ok: false, error: `${cycle.label} (${cycle.range}) has not closed yet. It seals at ${cycle.batchAt.toISOString()}.` };
  }

  if (!(await takeLease(cycle.key))) {
    console.log(`[batch] ${cycle.label} ${cycle.range}: another instance is sealing it.`);
    return { ok: true, cycle: summarise(cycle), batched: 0, skipped: true, reason: 'Another instance is sealing this cycle.' };
  }

  try {
    const claims = await readClaims();
    const due = claims.filter((claim) => claimCycleKey(claim) === cycle.key && claim.status === STATUS.APPROVED);

    if (!due.length) {
      console.log(`[batch] ${cycle.label} ${cycle.range}: nothing to seal.`);
      return { ok: true, cycle: summarise(cycle), batched: 0, skipped: true };
    }

    const batched = [];
    for (const claim of due) {
      let sealed = false;
      const updated = await updateClaim(claim.id, (current) => {
        // Re-checked on the row as it stands inside the transaction, not as it was read
        // above: between the two it may have been paid, and sealing a paid claim would
        // put it back in front of HR as money still owed.
        if (current.status !== STATUS.APPROVED) return current;
        sealed = true;
        return applyDecision(current, {
          actor: 'system',
          action: 'batch',
          note: `Sealed into the ${cycle.label} batch (${cycle.range}).`,
        });
      });
      if (updated && sealed) batched.push(updated);
    }

    const report = buildBatchReport(cycle, batched);
    const delivery = notify && batched.length ? await notifyHr(report) : null;

    return { ok: true, cycle: summarise(cycle), batched: batched.length, total: report.total, regions: report.regions.length, report, delivery };
  } finally {
    await releaseLease(cycle.key);
  }
}

// Long enough for any real batch, short enough that a pod killed mid-run holds the cycle
// for minutes rather than until somebody notices.
const LEASE_MINUTES = 10;

/**
 * Claims the right to seal one cycle. True for exactly one caller at a time.
 *
 * One statement, so the database decides the race rather than this code: the insert
 * succeeds for the first caller, and the conflict clause only takes over a lease that has
 * already run out.
 */
async function takeLease(cycleKey) {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
  const { changes } = await run([
    'INSERT INTO batch_locks (cycle_key, locked_until) VALUES (?, ?)',
    'ON CONFLICT(cycle_key) DO UPDATE SET locked_until = excluded.locked_until',
    'WHERE batch_locks.locked_until < ?',
  ].join(' '), [cycleKey, until, now.toISOString()]);
  return changes === 1;
}

async function releaseLease(cycleKey) {
  await run('DELETE FROM batch_locks WHERE cycle_key = ?', [cycleKey]).catch((error) => {
    console.error(`[batch] could not release the lease on ${cycleKey}; it runs out in ${LEASE_MINUTES} minutes:`, error.message);
  });
}

/**
 * Seals any cycle whose batch moment has already passed but whose claims are still sitting
 * in APPROVED. Without this a server that was asleep at 08:00 — which a locally hosted app
 * routinely is — would leave a batch unsealed until someone noticed.
 */
export async function catchUpMissedBatches() {
  const claims = await readClaims();
  const stale = new Set(
    claims
      .filter((claim) => claim.status === STATUS.APPROVED)
      .map(claimCycleKey)
      .filter((key) => {
        const cycle = cycleFromKey(key);
        return cycle && isClosed(cycle);
      }),
  );

  const results = [];
  for (const key of stale) {
    console.log(`[batch] catching up a missed batch for ${key}`);
    results.push(await runBatch(key));
  }
  return results;
}

/** Starts both cron jobs. Returns a stop function. */
export function startScheduler() {
  const jobs = [
    cron.schedule(SCHEDULE_CYCLE_1, () => closePreviousCycle('Cycle 1'), { timezone: TIMEZONE }),
    cron.schedule(SCHEDULE_CYCLE_2, () => closePreviousCycle('Cycle 2'), { timezone: TIMEZONE }),
  ];
  console.log(`[batch] scheduler armed — Cycle 1 on the 16th, Cycle 2 on the 1st, 08:00 ${TIMEZONE}`);
  return () => jobs.forEach((job) => job.stop());
}

// Both jobs fire at the START of a new cycle, so the cycle being sealed is always the
// previous one. Deriving it beats hardcoding "the 1st means last month's Cycle 2", which
// would be wrong every time a run was late or retried.
async function closePreviousCycle(expected) {
  const closing = previousCycle(new Date());
  if (closing.label !== expected) {
    console.warn(`[batch] ${expected} job fired but the cycle that just closed is ${closing.label} (${closing.key}); sealing that instead.`);
  }
  try {
    const result = await runBatch(closing.key);
    if (!result.ok) console.error('[batch] failed:', result.error);
  } catch (error) {
    console.error('[batch] threw:', error);
  }
}

// Claims carry their cycle from submission. Older rows written before cycles existed fall
// back to the cycle their timestamp lands in, so nothing is stranded.
function claimCycleKey(claim) {
  return claim.cycleKey || getCycleDetails(claim.submittedAt).key;
}

function summarise(cycle) {
  return { key: cycle.key, label: cycle.label, range: cycle.range, batchAt: cycle.batchAt.toISOString() };
}
