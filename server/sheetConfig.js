import { isLive, readUsers } from './googleSheetsService.js';

/**
 * The live view of the staff sheet: who exists, what role they hold, which region and
 * managers they sit under, and what they may spend.
 *
 * The sheet is the only source of truth for all of it. Nothing here is stored in the
 * repository, and there is no fallback list — an unreachable sheet is an error, never a
 * set of assumed permissions. A stale cache is refreshed on read; a missing sheet is
 * reported, so a misconfigured server cannot quietly hand someone a role.
 */
const TTL_MS = Number(process.env.SONGA_SHEET_TTL_MS || 60_000);

let cache = { users: [], syncedAt: 0, error: '' };
let inFlight = null;

/** Users as the sheet currently defines them, refreshing when the cache has aged out. */
export async function getUsers({ force = false } = {}) {
  const fresh = Date.now() - cache.syncedAt < TTL_MS;
  if (!force && fresh && cache.users.length) return cache.users;

  // Collapse concurrent refreshes: a burst of requests after the TTL lapses should read
  // the sheet once, not once each.
  if (!inFlight) {
    inFlight = readUsers()
      .then((users) => {
        const withApprovers = buildDirectory(users);
        cache = { users: withApprovers, syncedAt: Date.now(), error: '' };
        return withApprovers;
      })
      .catch((error) => {
        cache = { ...cache, error: error.message };
        throw error;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * The live sheet row for an email, or null. Called on login and on every authenticated
 * request, so a role, budget or manager edited in the sheet takes effect within the TTL
 * without anyone restarting the server or signing out.
 */
export async function findUserByEmail(email, { force = false } = {}) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  const users = await getUsers({ force });
  return users.find((user) => user.email === target) || null;
}

/**
 * Forces a re-read of the sheet and reports what came back. This is the helper behind the
 * "Refresh Sheet Data" button, and is also worth calling after a bulk edit to the sheet.
 */
export async function fetchLatestSheetConfig() {
  const startedAt = Date.now();
  try {
    const users = await getUsers({ force: true });
    return {
      ok: true,
      source: (await isLive()) ? 'google-sheet' : 'unconfigured',
      syncedAt: new Date(cache.syncedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      userCount: users.length,
      regions: countBy(users, (user) => user.region || 'Unassigned'),
      roles: countBy(users, (user) => user.role),
      // Surfaced because these are the rows that will behave oddly later: someone with no
      // budget can never auto-approve, and someone with no manager escalates to HR.
      warnings: warningsFor(users),
    };
  } catch (error) {
    return { ok: false, source: 'google-sheet', error: error.message, syncedAt: cache.syncedAt ? new Date(cache.syncedAt).toISOString() : null };
  }
}

/** Cache state without touching the sheet, for status displays. */
export function syncStatus() {
  return {
    syncedAt: cache.syncedAt ? new Date(cache.syncedAt).toISOString() : null,
    ageMs: cache.syncedAt ? Date.now() - cache.syncedAt : null,
    userCount: cache.users.length,
    ttlMs: TTL_MS,
    error: cache.error || '',
  };
}

/** Drops the cache so the next read goes to the sheet. */
export function invalidate() {
  cache = { users: [], syncedAt: 0, error: '' };
}

/**
 * Builds the sign-in directory from the sheet.
 *
 * Column C is the list of people who SUBMIT claims. The people who APPROVE them are named
 * only in the manager columns — G/H for Manager 1, I/J for Manager 2 — and deliberately do
 * not appear in column C, because they are not claimants. They still need to sign in, so
 * this synthesises an account for each of them from the columns that already describe
 * them. No sheet edit, no second list to maintain: the same rows define both populations.
 *
 * A manager who also appears in column C keeps their column C row, budgets and role; being
 * named as someone's approver only adds the approver capability on top.
 */
export function buildDirectory(staff) {
  const directory = new Map(staff.map((person) => [person.email, { ...person, isStaff: true, isApprover: false, approvesFor: [], regions: person.region ? [person.region] : [] }]));

  for (const person of staff) {
    const references = [
      { email: person.manager1Email, name: person.manager1Name },
      { email: person.manager2Email, name: person.manager2Name },
    ];
    for (const { email, name } of references) {
      if (!email || !email.includes('@')) continue;
      if (!directory.has(email)) directory.set(email, derivedManager(email, name));
      const manager = directory.get(email);
      manager.isApprover = true;
      // Someone named as an approver reads as a manager to the rest of the app, so the
      // review queue appears in their nav and matches where claims are actually sent.
      if (manager.role === 'field_agent') manager.role = 'manager';
      if (!manager.approvesFor.includes(person.email)) manager.approvesFor.push(person.email);
      if (person.region && !manager.regions.includes(person.region)) manager.regions.push(person.region);
    }
  }

  // A derived manager has no region of their own, so show the one they cover. Where they
  // span several, the review queue groups by region anyway.
  for (const person of directory.values()) {
    if (!person.region && person.regions.length) person.region = person.regions[0];
  }

  return [...directory.values()];
}

/**
 * An account for someone who appears only as an approver. They carry no transport budget
 * because they are not in the claimant list; submitting is refused rather than left
 * uncapped, and adding them to column C is what makes them a claimant too.
 */
function derivedManager(email, name) {
  return {
    name: (name || '').trim() || email.split('@')[0],
    email,
    zone: '',
    roleLabel: '',
    role: 'manager',
    region: '',
    manager1Name: '',
    manager1Email: '',
    manager2Name: '',
    manager2Email: '',
    transportMonth: 0,
    transportPerCycle: 0,
    extraAllowancePerCycle: 0,
    maxPerCycle: 0,
    manager1OutOfOffice: false,
    isStaff: false,
    isApprover: true,
    approvesFor: [],
    regions: [],
  };
}

function warningsFor(users) {
  const warnings = [];
  // Only claimants are warned about budgets. An approver who never claims is expected to
  // have none, and flagging them would bury the rows that genuinely need attention.
  const claimants = users.filter((user) => user.isStaff);
  const noBudget = claimants.filter((user) => !user.transportPerCycle).map((user) => user.email);
  const noCeiling = claimants.filter((user) => !user.maxPerCycle).map((user) => user.email);
  const noManager = claimants.filter((user) => !user.manager1Email && !user.manager2Email && user.role === 'field_agent').map((user) => user.email);

  if (noBudget.length) warnings.push({ issue: 'No "Transport per cycle" set — claims can never auto-approve', emails: noBudget });
  if (noCeiling.length) warnings.push({ issue: 'No "Max possible exp per cycle" set — no ceiling is enforced', emails: noCeiling });
  if (noManager.length) warnings.push({ issue: 'No manager set — claims above the allowance escalate to HR', emails: noManager });
  return warnings;
}

function countBy(items, pick) {
  const counts = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
