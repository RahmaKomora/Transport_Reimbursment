import { all, get, run, tx } from './db.js';

/**
 * Songa's data store: people and claims.
 *
 * This is the source of truth for both. Every read and write to them lives here, which is
 * what made it possible to change the storage underneath — first from a spreadsheet, and
 * next to Postgres — without the rest of the app noticing.
 */

// Swapped out by the integration tests. Test-only: nothing in the running app sets it.
let testStore = null;
export function setStoreForTests(store) { testStore = store; }

export const SYSTEM_ROLE = {
  field_agent: 'ke_asili_requester',
  manager: 'ke_asili_approver',
  hr: 'ke_asili_hr',
  admin: 'ke_asili_admin',
};

// Job titles are free text — "Field Officer", "Zone Supervisor", "HR". Normalise them to
// the four roles the app actually branches on.
export function normaliseRole(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('admin')) return 'admin';
  if (value.includes('hr') || value.includes('people')) return 'hr';
  if (value.includes('manager') || value.includes('lead') || value.includes('supervisor')) return 'manager';
  return 'field_agent';
}

export const ROLES = ['field_agent', 'manager', 'hr', 'admin'];

/** True for a role an admin may actually assign. Anything else is rejected, not coerced. */
export const isRole = (value) => ROLES.includes(value);

/**
 * What a person may do, and why.
 *
 * The job title decides by default, which is what keeps 1,400 people working without
 * anybody assigning roles by hand. But the title is free text typed by HR, and a new one
 * Songa has never seen falls through to requester — so "Zone Coordinator" would quietly
 * lose the ability to approve, with nothing on screen to explain it.
 *
 * An admin can therefore set the role outright, and that answer wins. Blank means nobody
 * has, and the title still decides. Reporting which of the two applied is what lets the
 * admin screen show whether a role was read or chosen.
 */
export function resolveRole(jobTitle, override) {
  if (isRole(override)) return { role: override, roleSource: 'manual' };
  return { role: normaliseRole(jobTitle), roleSource: 'title' };
}

const toUser = (row) => ({
  name: row.name,
  email: row.email,
  department: row.department,
  zone: row.zone,
  roleLabel: row.job_title,
  ...resolveRole(row.job_title, row.system_role),
  roleOverride: isRole(row.system_role) ? row.system_role : '',
  region: row.region,
  manager1Name: row.manager1_name,
  manager1Email: row.manager1_email,
  manager2Name: row.manager2_name,
  manager2Email: row.manager2_email,
  transportMonth: row.transport_month,
  transportPerCycle: row.transport_per_cycle,
  extraAllowancePerCycle: row.extra_allowance,
  maxPerCycle: row.max_per_cycle,
  manager1OutOfOffice: row.out_of_office === 1,
  active: row.active === 1,
});

export async function readUsers() {
  if (testStore) return testStore.readUsers();
  return (await all('SELECT * FROM users ORDER BY region, name')).map(toUser);
}

const UPSERT_USER = [
  'INSERT INTO users (email, name, department, zone, job_title, region,',
  '  manager1_name, manager1_email, manager2_name, manager2_email,',
  '  transport_month, transport_per_cycle, extra_allowance, max_per_cycle,',
  '  out_of_office, active, system_role, created_at, updated_at)',
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  'ON CONFLICT(email) DO UPDATE SET',
  '  name = excluded.name, department = excluded.department, zone = excluded.zone,',
  '  job_title = excluded.job_title, region = excluded.region,',
  '  manager1_name = excluded.manager1_name, manager1_email = excluded.manager1_email,',
  '  manager2_name = excluded.manager2_name, manager2_email = excluded.manager2_email,',
  '  transport_month = excluded.transport_month, transport_per_cycle = excluded.transport_per_cycle,',
  '  extra_allowance = excluded.extra_allowance, max_per_cycle = excluded.max_per_cycle,',
  '  out_of_office = excluded.out_of_office, active = excluded.active,',
  // A blank incoming role means the caller has no opinion, not "clear it". Keep whatever
  // an admin set rather than letting a bulk write undo a deliberate choice.
  "  system_role = CASE WHEN excluded.system_role = '' THEN users.system_role ELSE excluded.system_role END,",
  '  updated_at = excluded.updated_at',
].join('\n');

/**
 * Adds somebody who is not already here, and refuses if they are.
 *
 * Separate from upsertUser because "add a person" and "overwrite a person" are different
 * intentions and only one of them belongs behind an Add button. The admin screen checks
 * for a duplicate first, but that check reads a directory cache up to a minute old, so it
 * cannot be the only thing standing between a mistyped address and somebody's record
 * being replaced with a blank form. This makes the database itself refuse.
 */
export async function insertUser(person) {
  if (testStore) return testStore.insertUser ? testStore.insertUser(person) : null;
  const email = String(person.email).trim().toLowerCase();
  const existing = await get('SELECT email FROM users WHERE email = ?', [email]);
  if (existing) {
    const error = new Error('Somebody with that email is already in the directory.');
    error.status = 409;
    throw error;
  }
  return upsertUser({ ...person, email });
}

export async function upsertUser(person) {
  if (testStore) return testStore.upsertUser ? testStore.upsertUser(person) : null;
  const now = new Date().toISOString();
  await run(UPSERT_USER, [
    String(person.email).trim().toLowerCase(), person.name || '', person.department || '',
    person.zone || '', person.roleLabel || '', person.region || '',
    person.manager1Name || '', String(person.manager1Email || '').trim().toLowerCase(),
    person.manager2Name || '', String(person.manager2Email || '').trim().toLowerCase(),
    Number(person.transportMonth) || 0, Number(person.transportPerCycle) || 0,
    Number(person.extraAllowancePerCycle) || 0, Number(person.maxPerCycle) || 0,
    person.manager1OutOfOffice ? 1 : 0, person.active === false ? 0 : 1,
    isRole(person.roleOverride) ? person.roleOverride : '', now, now,
  ]);
  return person.email;
}

const USER_COLUMNS = {
  name: 'name',
  zone: 'zone',
  roleLabel: 'job_title',
  region: 'region',
  manager1Name: 'manager1_name',
  manager1Email: 'manager1_email',
  manager2Name: 'manager2_name',
  manager2Email: 'manager2_email',
  transportMonth: 'transport_month',
  transportPerCycle: 'transport_per_cycle',
  extraAllowancePerCycle: 'extra_allowance',
  maxPerCycle: 'max_per_cycle',
  active: 'active',
  manager1OutOfOffice: 'out_of_office',
  roleOverride: 'system_role',
};

const NUMERIC = ['transport_month', 'transport_per_cycle', 'extra_allowance', 'max_per_cycle'];
const BOOLEAN = ['active', 'out_of_office'];

/** Updates only the fields supplied, so a partial edit cannot blank the rest of a record. */
export async function updateUser(email, fields) {
  if (testStore) return testStore.updateUser ? testStore.updateUser(email, fields) : null;

  const sets = [];
  const values = [];
  for (const [field, column] of Object.entries(USER_COLUMNS)) {
    if (fields[field] === undefined) continue;
    sets.push(`${column} = ?`);
    if (BOOLEAN.includes(column)) values.push(fields[field] ? 1 : 0);
    // A role that is not one of the four is stored as blank rather than as itself: a
    // typo must fall back to the job title, never sit in the column granting nothing.
    else if (column === 'system_role') values.push(isRole(fields[field]) ? fields[field] : '');
    else if (NUMERIC.includes(column)) values.push(Number(fields[field]) || 0);
    else if (column.endsWith('_email')) values.push(String(fields[field] || '').trim().toLowerCase());
    else values.push(String(fields[field] ?? ''));
  }
  if (!sets.length) return 0;

  sets.push('updated_at = ?');
  values.push(new Date().toISOString(), String(email).trim().toLowerCase());
  return (await run(`UPDATE users SET ${sets.join(', ')} WHERE email = ?`, values)).changes;
}

export async function deleteUsers(emails) {
  if (testStore) return testStore.deleteUsers ? testStore.deleteUsers(emails) : 0;
  return tx(async ({ run: write }) => {
    let removed = 0;
    for (const email of emails) {
      removed += (await write('DELETE FROM users WHERE email = ?', [String(email).trim().toLowerCase()])).changes;
    }
    return removed;
  });
}

/* --------------------------------------------------------------------- claims ----- */

const json = (raw) => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const toClaim = (row) => ({
  id: row.id,
  submittedAt: row.submitted_at,
  submittedBy: row.submitted_by,
  staffName: row.staff_name,
  region: row.region,
  zone: row.zone,
  tripDate: row.trip_date,
  purpose: row.purpose,
  vehicle: row.vehicle,
  km: row.km,
  rate: row.rate,
  estimate: row.estimate,
  amount: row.amount,
  status: row.status,
  assignedTo: row.assigned_to,
  decisionLog: json(row.decision_log) || [],
  route: row.route,
  cycleKey: row.cycle_key,
  approvalSource: row.approval_source,
  ceiling: row.ceiling,
  proofFile: row.proof_file,
  mpesaCode: row.mpesa_code,
  proofHash: row.proof_hash,
  duplicateFlag: json(row.duplicate_flag),
  reviewFlag: json(row.review_flag),
  completedAt: row.completed_at,
  completedBy: row.completed_by,
});

const claimValues = (claim) => [
  claim.id, claim.submittedAt, String(claim.submittedBy || '').toLowerCase(), claim.staffName || '',
  claim.region || '', claim.zone || '', claim.tripDate || '', claim.purpose || '', claim.vehicle || '',
  Number(claim.km) || 0, Number(claim.rate) || 0, Number(claim.estimate) || 0, Number(claim.amount) || 0,
  claim.status, String(claim.assignedTo || '').toLowerCase(), JSON.stringify(claim.decisionLog || []),
  claim.route || '', claim.cycleKey || '', claim.approvalSource || '', Number(claim.ceiling) || 0,
  claim.proofFile || '', claim.mpesaCode || '', claim.proofHash || '',
  claim.duplicateFlag ? JSON.stringify(claim.duplicateFlag) : null,
  claim.reviewFlag ? JSON.stringify(claim.reviewFlag) : null,
  claim.completedAt || '', claim.completedBy || '',
];

const INSERT_CLAIM = [
  'INSERT INTO claims (id, submitted_at, submitted_by, staff_name, region, zone, trip_date,',
  '  purpose, vehicle, km, rate, estimate, amount, status, assigned_to, decision_log, route,',
  '  cycle_key, approval_source, ceiling, proof_file, mpesa_code, proof_hash, duplicate_flag,',
  '  review_flag, completed_at, completed_by)',
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
].join('\n');

export async function readClaims() {
  if (testStore) return testStore.readClaims();
  return (await all('SELECT * FROM claims ORDER BY submitted_at DESC')).map(toClaim);
}

export async function appendClaim(claim) {
  if (testStore) return testStore.appendClaim(claim);
  await run(INSERT_CLAIM, claimValues(claim));
  return claim;
}

/**
 * Reads a claim, applies a change and writes it back, all inside one transaction.
 *
 * This is the thing a spreadsheet could not do. Two approvers deciding at the same
 * moment used to read the same row and the second write silently discarded the first.
 */
export async function updateClaim(id, mutate) {
  if (testStore) return testStore.updateClaim(id, mutate);
  return tx(async ({ get: read, run: write }) => {
    const row = await read('SELECT * FROM claims WHERE id = ?', [id]);
    if (!row) return null;
    const updated = mutate(toClaim(row));
    await write('DELETE FROM claims WHERE id = ?', [id]);
    await write(INSERT_CLAIM, claimValues(updated));
    return updated;
  });
}

/** The store is local, so there is nothing to be unreachable. */
export async function isLive() { return true; }
export async function backend() { return testStore ? 'test' : 'sqlite'; }
