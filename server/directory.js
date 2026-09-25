import { readUsers } from './store.js';

/**
 * The directory: who exists, what role they hold, which region and managers they sit
 * under, and what they may spend.
 *
 * Songa's own database is the source of truth for all of it, edited through the admin
 * screens. Nothing is stored in the repository and there is no fallback list, so a server
 * that cannot read the directory reports an error rather than quietly handing someone a
 * role.
 *
 * The short cache is not about the read being slow — it is about buildDirectory below,
 * which walks every person's manager columns and is wasted work on each of a burst of
 * requests. Every admin write calls invalidate(), so an edit still shows immediately.
 */
const TTL_MS = Number(process.env.SONGA_DIRECTORY_TTL_MS || 60_000);

let cache = { users: [], syncedAt: 0, error: '' };
let inFlight = null;

/** The directory as it currently stands, rebuilt when the cache has aged out. */
export async function getUsers({ force = false } = {}) {
  const fresh = Date.now() - cache.syncedAt < TTL_MS;
  if (!force && fresh && cache.users.length) return cache.users;

  // Collapse concurrent refreshes: a burst of requests after the TTL lapses should rebuild
  // the directory once, not once each.
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
 * The current record for an email, or null. Called on login and on every authenticated
 * request, so a role, budget or manager an admin edits takes effect straight away without
 * anyone restarting the server or signing out.
 */
export async function findUserByEmail(email, { force = false } = {}) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  const users = await getUsers({ force });
  return users.find((user) => user.email === target) || null;
}

/**
 * Forces a rebuild of the directory and reports what came back. This is the helper behind
 * the "Reload directory" button and the startup summary.
 */
export async function reloadDirectory() {
  const startedAt = Date.now();
  try {
    const users = await getUsers({ force: true });
    return {
      ok: true,
      source: 'songa',
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
    return { ok: false, source: 'songa', error: error.message, syncedAt: cache.syncedAt ? new Date(cache.syncedAt).toISOString() : null };
  }
}

/** Cache state without rebuilding, for status displays. */
export function syncStatus() {
  return {
    syncedAt: cache.syncedAt ? new Date(cache.syncedAt).toISOString() : null,
    ageMs: cache.syncedAt ? Date.now() - cache.syncedAt : null,
    userCount: cache.users.length,
    ttlMs: TTL_MS,
    error: cache.error || '',
  };
}

/** Drops the cache so the next read goes to the database. */
export function invalidate() {
  cache = { users: [], syncedAt: 0, error: '' };
}

/**
 * Builds the sign-in directory from the stored people.
 *
 * The directory is the list of people who SUBMIT claims. Many of the people who APPROVE
 * them are named only as somebody's Manager 1 or Manager 2 and have no record of their
 * own, because they are not claimants. They still need to sign in, so this synthesises an
 * account for each of them from the fields that already describe them. No second list to
 * maintain: the same records define both populations.
 *
 * A manager who also has a record of their own keeps it, along with their budgets and
 * role; being named as someone's approver only adds the approver capability on top.
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

  // An approver who exists only because somebody names them as a manager has no record,
  // and so nothing to switch off. Their access instead follows the people they approve
  // for: once every one of those is deactivated there is nothing left for them to do, and
  // leaving them able to sign in would be a gap that no admin screen could close.
  for (const person of directory.values()) {
    if (person.isStaff || !person.approvesFor.length) continue;
    person.active = person.approvesFor.some((email) => directory.get(email)?.active !== false);
  }

  return [...directory.values()];
}

/**
 * An account for someone who appears only as an approver. They carry no transport budget
 * because they are not in the claimant list; submitting is refused rather than left
 * uncapped, and adding them in Admin is what makes them a claimant too.
 */
function derivedManager(email, name) {
  return {
    active: true,
    name: (name || '').trim() || email.split('@')[0],
    email,
    department: '',
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
  if (noManager.length) warnings.push({ issue: 'No approver set — claims above the allowance cannot be approved until one is assigned', emails: noManager });
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
