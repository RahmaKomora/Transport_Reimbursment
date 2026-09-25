import express from 'express';
import { randomUUID } from 'node:crypto';
import { ALLOWED_DOMAIN, PORT } from './config.js';
import { allUsers, findUserByEmail, googleSignInEnabled, requireRole, requireUser, signIn, signInWithGoogle } from './auth.js';
import { appendClaim, backend as storeBackend, isLive, readClaims, updateClaim } from './store.js';
import { COMPLETED_STATUSES, STATUS, applyDecision, canAct, routeClaim, statusCounts, visibleToManager } from './routing.js';
import { cycleOf, groupByRegion, savingsByRegion, savingsForUser, savingsTotals } from './savings.js';
import { cycleFromKey, getCycleDetails } from './cycles.js';
import { catchUpMissedBatches, runBatch, startScheduler } from './cycleScheduler.js';
import { reloadDirectory, invalidate, syncStatus } from './directory.js';
import { readProof, saveProof } from './proofStore.js';
import { buildAlerts } from './alerts.js';
import { cycleLedger, indexClaimsByPerson } from './budget.js';
import { regionalSummary } from './regions.js';
import { VEHICLES, getRates, hasRates, historyFor, lastChanged, rateFrom, saveRates } from './rates.js';
import { ROLES, SYSTEM_ROLE, deleteUsers, insertUser, isRole, normaliseRole, resolveRole, updateUser } from './store.js';
import { duplicateNote, findDuplicates, fingerprintImage } from './duplicates.js';

const app = express();
app.use(express.json({ limit: '8mb' }));

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// An M-Pesa confirmation code is exactly ten alphanumeric characters. It is what Finance
// reconciles against and what catches a claim submitted twice, so it is validated here
// and not only in the form.
const MPESA_CODE_LENGTH = 10;

app.get('/api/health', wrap(async (_req, res) => {
  const cycle = getCycleDetails();
  const ready = await isLive();
  res.json({
    ok: ready,
    store: await storeBackend(),
    sync: syncStatus(),
    cycle: { key: cycle.key, label: cycle.label, range: cycle.range, closesAt: cycle.batchAt.toISOString() },
  });
}));

// Forces a rebuild of the directory. Behind the "Reload directory" button, and worth
// calling after a bulk edit rather than waiting for the cache to age out.
app.post('/api/admin/refresh', requireUser, requireRole('hr', 'admin'), wrap(async (_req, res) => {
  const result = await reloadDirectory();
  res.status(result.ok ? 200 : 503).json(result);
}));

/**
 * The directory as Songa understands it, for the admin screen.
 *
 * Each person carries their raw job title alongside the role Songa read it as, because
 * the two have drifted apart before — a job title that did not read as a manager left
 * somebody unable to approve, and nothing on screen explained why.
 */
app.get('/api/admin/users', requireUser, requireRole('hr', 'admin'), wrap(async (_req, res) => {
  const [users, claims] = await Promise.all([allUsers(), readClaims()]);

  // How many claims each person has ever filed. Carried here because it is what decides
  // whether removing them is tidy-up or the loss of a record, and the admin should be
  // able to see that before choosing, not after the attempt is refused.
  const claimCount = {};
  for (const claim of claims) claimCount[claim.submittedBy] = (claimCount[claim.submittedBy] || 0) + 1;

  const people = users.map((person) => ({
    claims: claimCount[person.email] || 0,
    name: person.name,
    email: person.email,
    role: person.role,
    roleLabel: person.roleLabel,
    region: person.region,
    zone: person.zone,
    manager1Name: person.manager1Name,
    manager1Email: person.manager1Email,
    manager2Name: person.manager2Name,
    manager2Email: person.manager2Email,
    transportMonth: person.transportMonth,
    transportPerCycle: person.transportPerCycle,
    extraAllowancePerCycle: person.extraAllowancePerCycle,
    maxPerCycle: person.maxPerCycle,
    outOfOffice: person.manager1OutOfOffice,
    // Where this account came from: a record of their own, or somebody else naming them
    // as their approver.
    systemRole: SYSTEM_ROLE[person.role] || person.role,
    // Whether that role was read from the job title or set by an admin. The screen shows
    // the difference, because "Songa guessed this" and "somebody decided this" are not
    // the same claim and only one of them is worth revisiting.
    roleSource: person.roleSource || 'title',
    roleOverride: person.roleOverride || '',
    active: person.active !== false,
    source: person.isStaff ? 'staff' : 'approver',
    isApprover: Boolean(person.isApprover),
    approvesFor: person.approvesFor || [],
    regionsCovered: person.regions || [],
  })).sort((a, b) => (a.region || '').localeCompare(b.region || '') || (a.name || '').localeCompare(b.name || ''));

  res.json({
    people,
    regions: [...new Set(people.map((p) => p.region).filter(Boolean))].sort(),
    counts: people.reduce((acc, p) => ({ ...acc, [p.role]: (acc[p.role] || 0) + 1 }), {}),
    sync: syncStatus(),
  });
}));

app.get('/api/admin/rates', requireUser, requireRole('hr', 'admin'), wrap(async (_req, res) => {
  const [table, users] = await Promise.all([getRates(), allUsers()]);

  // Only regions with active staff need rates. Listing every historical spelling would
  // bury the ones that actually matter.
  const staffRegions = [...new Set(users
    .filter((user) => user.isStaff && user.active !== false)
    .map((user) => user.region)
    .filter(Boolean))].sort();

  // A region with staff but no rates is a gap, not a default. It appears with blank
  // figures so somebody fills it in.
  for (const region of staffRegions) if (!table[region]) table[region] = Object.fromEntries(VEHICLES.map((v) => [v, 0]));

  res.json({
    vehicles: VEHICLES,
    table,
    staffRegions,
    lastChanged: await lastChanged(),
    missing: staffRegions.filter((region) => !hasRates(table, region)),
  });
}));

app.put('/api/admin/rates', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const table = req.body?.table;
  if (!table || typeof table !== 'object') return res.status(400).json({ error: 'No rates were supplied.' });

  const bad = Object.entries(table).flatMap(([region, rates]) =>
    VEHICLES.filter((vehicle) => !(Number(rates?.[vehicle]) >= 0)).map((vehicle) => `${region} / ${vehicle}`));
  if (bad.length) return res.status(400).json({ error: `These need a number of zero or more: ${bad.slice(0, 3).join(', ')}.` });

  const saved = await saveRates(table, req.user.name || req.user.email);
  console.log(`[admin] ${req.user.email} updated transport rates for ${Object.keys(saved).length} regions`);
  return res.json({ vehicles: VEHICLES, table: saved });
}));

/**
 * Activates or deactivates an account.
 *
 * Two guards, both about not locking everyone out: nobody can deactivate themselves, and
 * the last active HR or admin cannot be deactivated. Recovering from either would mean
 * editing the database by hand, which is exactly what this screen exists to avoid.
 */
app.patch('/api/admin/users/:email/status', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const email = String(req.params.email || '').toLowerCase();
  const active = Boolean(req.body?.active);

  if (email === req.user.email) return res.status(400).json({ error: 'You cannot change your own status.' });

  const users = await allUsers();
  const target = users.find((user) => user.email === email);
  if (!target) return res.status(404).json({ error: 'That person is not in the directory.' });
  if (target.source === 'approver' || !target.isStaff) return res.status(400).json({ error: 'This account comes from the manager fields on other people and has no record of its own to deactivate.' });

  if (!active && ['hr', 'admin'].includes(target.role)) {
    const remaining = users.filter((user) => ['hr', 'admin'].includes(user.role) && user.active !== false && user.email !== email);
    if (!remaining.length) return res.status(400).json({ error: 'This is the last active HR or admin account. Give someone else the role first.' });
  }

  const changed = await updateUser(email, { active });
  if (!changed) return res.status(404).json({ error: 'That record could not be found.' });

  invalidate();
  console.log(`[admin] ${req.user.email} set ${email} to ${active ? 'active' : 'inactive'}`);
  return res.json({ email, active });
}));

/**
 * Activates or deactivates several accounts at once.
 *
 * The same two guards as the single version, applied across the whole set rather than one
 * at a time: deactivating a hundred people one request each would let the last HR account
 * slip out halfway through, because each call only knows about itself. Here the survivors
 * are counted once against the entire selection.
 *
 * Anyone who cannot be changed is skipped with a reason rather than failing the batch —
 * one derived approver in a selection of fifty should not stop the other forty-nine.
 *
 * This must stay above PATCH /api/admin/users/:email, or Express matches that first and
 * reads "status" as somebody's email address.
 */
app.patch('/api/admin/users/status', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const emails = (Array.isArray(req.body?.emails) ? req.body.emails : [])
    .map((email) => String(email).trim().toLowerCase())
    .filter(Boolean);
  if (!emails.length) return res.status(400).json({ error: 'No people were selected.' });
  const active = Boolean(req.body?.active);

  const users = await allUsers();
  const byEmail = new Map(users.map((user) => [user.email, user]));

  const changing = [];
  const skipped = [];
  for (const email of emails) {
    const person = byEmail.get(email);
    if (!person) { skipped.push({ email, reason: 'Not in the directory.' }); continue; }
    if (email === req.user.email) { skipped.push({ email, reason: 'You cannot change your own status.' }); continue; }
    if (!person.isStaff) { skipped.push({ email, reason: 'Named as an approver, so there is no record to change.' }); continue; }
    if ((person.active !== false) === active) { skipped.push({ email, reason: `Already ${active ? 'active' : 'inactive'}.` }); continue; }
    changing.push(person);
  }

  if (!active) {
    const losing = new Set(changing.filter((person) => ['hr', 'admin'].includes(person.role)).map((person) => person.email));
    const remaining = users.filter((user) => ['hr', 'admin'].includes(user.role) && user.active !== false && !losing.has(user.email));
    if (losing.size && !remaining.length) {
      return res.status(400).json({ error: 'That would deactivate every HR and admin account. Leave at least one able to sign in.' });
    }
  }

  let changed = 0;
  for (const person of changing) changed += (await updateUser(person.email, { active })) ? 1 : 0;

  if (changed) {
    invalidate();
    console.log(`[admin] ${req.user.email} set ${changed} account(s) to ${active ? 'active' : 'inactive'}`);
  }
  return res.json({ changed, active, skipped });
}));

/** Adds somebody to the directory. This screen is how staff get into Songa. */
app.post('/api/admin/users', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();

  if (!email.includes('@')) return res.status(400).json({ error: 'Enter a valid work email address.' });
  if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Enter the name.' });

  const users = await allUsers();
  if (users.some((user) => user.email === email && user.isStaff)) {
    return res.status(409).json({ error: 'Somebody with that email is already in the directory.' });
  }

  // Blank means "read it from the job title", which is the normal case. Anything that is
  // neither blank nor one of the four is refused rather than quietly ignored — a role
  // silently dropped would look granted on the form and be absent in the app.
  const roleOverride = String(body.roleOverride || '');
  if (roleOverride && !isRole(roleOverride)) {
    return res.status(400).json({ error: `Choose one of: ${ROLES.join(', ')}, or leave it to the job title.` });
  }

  await insertUser({
    roleOverride,
    email,
    name: String(body.name).trim(),
    department: body.department || 'Asili',
    zone: body.zone || '',
    roleLabel: body.jobTitle || '',
    region: body.region || '',
    manager1Name: body.manager1Name || '',
    manager1Email: body.manager1Email || '',
    manager2Name: body.manager2Name || '',
    manager2Email: body.manager2Email || '',
    transportMonth: body.transportMonth,
    transportPerCycle: body.transportPerCycle,
    extraAllowancePerCycle: body.extraAllowancePerCycle,
    maxPerCycle: body.maxPerCycle,
    active: true,
  });
  invalidate();
  const { role, roleSource } = resolveRole(body.jobTitle, roleOverride);
  console.log(`[admin] ${req.user.email} added ${email} as "${body.jobTitle}" -> ${role} (${roleSource})`);
  return res.status(201).json({ email, role, roleSource, systemRole: SYSTEM_ROLE[role] });
}));

app.get('/api/admin/rates/history', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const region = String(req.query.region || '').trim();
  if (!region) return res.status(400).json({ error: 'Name a region.' });
  return res.json({ region, changes: await historyFor(region) });
}));

/**
 * Removes people from the directory.
 *
 * Anyone who has ever submitted a claim is refused by default: their email is what ties
 * those claims to a person, and deleting the record leaves nothing in the directory to
 * look up. Deactivating keeps the record and closes the access, which is what somebody
 * leaving the company usually calls for.
 *
 * "Usually" is not "always", though — a duplicate account, a wrong address, somebody
 * added to the wrong region and re-entered correctly. So the refusal can be overridden
 * with force, which the admin screen only offers after saying plainly what is lost. The
 * claims themselves survive either way: each one stores the claimant's name, region and
 * zone at the time it was filed, so the money trail stays readable.
 */
app.delete('/api/admin/users', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const emails = (Array.isArray(req.body?.emails) ? req.body.emails : [])
    .map((email) => String(email).trim().toLowerCase())
    .filter(Boolean);
  if (!emails.length) return res.status(400).json({ error: 'No people were selected.' });
  const force = req.body?.force === true;

  const [users, claims] = await Promise.all([allUsers(), readClaims()]);
  const claimants = new Set(claims.map((claim) => claim.submittedBy));
  const survivingAdmins = users.filter((user) => ['hr', 'admin'].includes(user.role) && user.active !== false && !emails.includes(user.email));

  const removable = [];
  const skipped = [];
  for (const email of emails) {
    const person = users.find((user) => user.email === email);
    if (!person) { skipped.push({ email, reason: 'Not in the directory.' }); continue; }
    if (email === req.user.email) { skipped.push({ email, reason: 'You cannot delete your own account.' }); continue; }
    if (!person.isStaff) { skipped.push({ email, reason: 'Named as an approver, so there is no record to delete. Clear them from their reports’ manager fields instead.' }); continue; }
    if (claimants.has(email) && !force) { skipped.push({ email, reason: 'Has submitted claims. Deactivate instead, so the claim history keeps its owner.', hasClaims: true }); continue; }
    if (['hr', 'admin'].includes(person.role) && !survivingAdmins.length) { skipped.push({ email, reason: 'This is the last HR or admin account.' }); continue; }
    removable.push(email);
  }

  const deleted = removable.length ? await deleteUsers(removable) : 0;
  if (deleted) {
    invalidate();
    // Logged with the claim count because a forced delete is the one that somebody may
    // have to account for later.
    const withClaims = removable.filter((email) => claimants.has(email));
    console.log(`[admin] ${req.user.email} deleted ${deleted} user(s): ${removable.join(', ')}`
      + (withClaims.length ? ` — ${withClaims.length} had claims, removed with force` : ''));
  }
  return res.json({ deleted, removed: removable, skipped });
}));

/** Edits one person's details. The email is their identity, so it is not editable here. */
app.patch('/api/admin/users/:email', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const email = String(req.params.email || '').toLowerCase();
  const body = req.body || {};

  const users = await allUsers();
  const person = users.find((user) => user.email === email);
  if (!person) return res.status(404).json({ error: 'That person is not in the directory.' });
  if (!person.isStaff) return res.status(400).json({ error: 'This account comes from the manager fields on other people and has no record to edit.' });

  const roleOverride = body.roleOverride === undefined ? undefined : String(body.roleOverride || '');
  if (roleOverride && !isRole(roleOverride)) {
    return res.status(400).json({ error: `Choose one of: ${ROLES.join(', ')}, or leave it to the job title.` });
  }

  // Changing your own role is how an admin locks themselves out of the screen they are
  // standing on. Checked against what the record would actually resolve to, since the
  // role can now move either by retitling the person or by setting it outright, and
  // guarding only one of those would leave the other as the way to do it by accident.
  if (email === req.user.email) {
    const wouldBe = resolveRole(
      body.roleLabel === undefined ? person.roleLabel : body.roleLabel,
      roleOverride === undefined ? person.roleOverride : roleOverride,
    ).role;
    if (wouldBe !== person.role) {
      return res.status(400).json({ error: 'You cannot change your own role. Ask another admin.' });
    }
  }

  const approvers = new Map(users.map((user) => [user.email, user.name]));
  const fields = {};
  for (const key of ['name', 'zone', 'roleLabel', 'region', 'transportMonth', 'transportPerCycle', 'extraAllowancePerCycle', 'maxPerCycle', 'roleOverride']) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  for (const slot of ['manager1', 'manager2']) {
    if (body[`${slot}Email`] === undefined) continue;
    const chosen = String(body[`${slot}Email`] || '').trim().toLowerCase();
    if (chosen === email) return res.status(400).json({ error: 'Somebody cannot be their own approver.' });
    fields[`${slot}Email`] = chosen;
    // Keep the name column in step with the email, or the two disagree on screen.
    fields[`${slot}Name`] = chosen ? (approvers.get(chosen) || '') : '';
  }

  const changed = await updateUser(email, fields);
  if (!changed) return res.status(404).json({ error: 'That record could not be found.' });

  invalidate();
  console.log(`[admin] ${req.user.email} edited ${email}: ${Object.keys(fields).join(', ')}`);
  const updated = await findUserByEmail(email, { force: true });
  return res.json({ email, role: updated?.role, systemRole: SYSTEM_ROLE[updated?.role], roleSource: updated?.roleSource });
}));

app.get('/api/admin/config', requireUser, requireRole('hr', 'admin'), wrap(async (_req, res) => {
  res.json({ sync: syncStatus(), store: await storeBackend() });
}));

app.get('/api/auth/config', (_req, res) => {
  res.json({ googleClientId: process.env.SONGA_GOOGLE_CLIENT_ID || '', domain: ALLOWED_DOMAIN, googleOnly: googleSignInEnabled() });
});

app.post('/api/auth/google', wrap(async (req, res) => {
  const result = await signInWithGoogle(req.body?.credential);
  if (!result.ok) return res.status(401).json({ error: result.error });
  console.log(`[auth] ${result.user.email} signed in with Google`);
  return res.json({ token: result.token, user: publicUser(result.user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const result = await signIn(req.body?.email);
  if (!result.ok) return res.status(401).json({ error: result.error });
  return res.json({ token: result.token, user: publicUser(result.user) });
}));

app.get('/api/me', requireUser, wrap(async (req, res) => {
  const claims = await readClaims();
  const cycle = getCycleDetails();
  res.json({
    user: publicUser(req.user),
    budget: savingsForUser(req.user, claims, cycle.key),
    ledger: cycleLedger(req.user, claims, cycle.key),
    rates: await ratesForRegion(req.user.region),
    cycle: { key: cycle.key, label: cycle.label, range: cycle.range, closesAt: cycle.batchAt.toISOString() },
  });
}));

// What a claim would do before it is committed, so the form can warn about the cycle
// ceiling while the user is still typing rather than after they hit submit.
app.post('/api/claims/preview', requireUser, wrap(async (req, res) => {
  const ledger = cycleLedger(req.user, await readClaims());
  res.json({ ...routeClaim({ amount: Number(req.body?.amount), user: req.user, ledger }), ledger });
}));

app.post('/api/claims', requireUser, wrap(async (req, res) => {
  const body = req.body || {};
  // Approvers exist in the directory because the manager columns name them, not because
  // they are claimants. They carry no allowance, so a claim from them would be uncapped.
  if (!req.user.isStaff) {
    return res.status(403).json({ error: 'Your account approves claims but does not submit them. To claim transport, ask HR to add you to the directory with a transport allowance.' });
  }

  // Checked here as well as in the form: the code is what Finance reconciles against and
  // what catches a claim submitted twice, so a malformed one breaks both. Normalised the
  // same way the form does, so a pasted code with a stray space is accepted, not refused.
  const mpesaCode = String(body.mpesaCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (mpesaCode.length !== MPESA_CODE_LENGTH) {
    return res.status(400).json({ error: `An M-Pesa code is ${MPESA_CODE_LENGTH} letters and numbers. Copy it from the confirmation message.` });
  }

  // The decision depends on what is already spent this cycle, so read first.
  const existing = await readClaims();
  const ledger = cycleLedger(req.user, existing);
  const outcome = routeClaim({ amount: Number(body.amount), user: req.user, ledger });
  if (outcome.blocked) return res.status(422).json({ error: outcome.reason, outcome });

  const claim = {
    id: `SNG-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4)}`,
    submittedAt: new Date().toISOString(),
    submittedBy: req.user.email,
    staffName: req.user.name,
    region: req.user.region,
    zone: req.user.zone,
    tripDate: body.tripDate || '',
    purpose: Array.isArray(body.purposes) ? body.purposes.join(', ') : (body.purpose || ''),
    vehicle: body.vehicle || '',
    km: Number(body.km) || 0,
    rate: (await ratesForRegion(req.user.region))[body.vehicle] ?? Number(body.rate) ?? 0,
    estimate: Number(body.estimate) || 0,
    amount: Number(body.amount),
    route: body.route || '',
    cycleKey: getCycleDetails().key,
    approvalSource: outcome.approvalSource || '',
    ceiling: outcome.ceiling || req.user.maxPerCycle || 0,
    mpesaCode,
    proofHash: body.proof?.dataUrl ? fingerprintImage(body.proof.dataUrl) : '',
    status: outcome.status,
    assignedTo: outcome.assignedTo,
    decisionLog: [{ actor: 'system', action: 'submitted', note: outcome.reason, at: new Date().toISOString() }],
  };

  // Flagged, never blocked: a duplicate is usually an honest double-tap or a resubmission
  // after a lost connection, and the manager is better placed to judge than a rule is.
  const duplicate = findDuplicates(claim, existing);
  if (duplicate) {
    claim.duplicateFlag = duplicate;
    claim.decisionLog.push({ actor: 'system', action: 'flagged', note: `Possible duplicate: ${duplicate.reason}.`, at: new Date().toISOString() });
  }

  // Store the proof image before the row, so a claim never points at a file that is not
  // there. A failure here is reported rather than silently dropping the evidence.
  if (body.proof?.dataUrl) claim.proofFile = await saveProof(claim.id, body.proof.dataUrl) || '';

  await appendClaim(claim);
  res.status(201).json({ claim, outcome, duplicate: duplicate ? { ...duplicate, suggestedNote: duplicateNote(duplicate) } : null });
}));

/**
 * The proof-of-payment image for a claim.
 *
 * Served through the API rather than as a public link: an M-Pesa receipt shows a phone
 * number and a real payment, so it is only handed to the claimant, the approver it is
 * routed to, a manager whose patch it falls in, or HR.
 */
app.get('/api/claims/:id/proof', requireUser, wrap(async (req, res) => {
  const claims = await readClaims();
  const claim = claims.find((item) => item.id === req.params.id);
  if (!claim) return res.status(404).json({ error: 'Claim not found.' });

  const isOwn = claim.submittedBy === req.user.email;
  const canSee = isOwn || visibleToManager([claim], req.user).length > 0;
  if (!canSee) return res.status(403).json({ error: 'You cannot view this claim.' });
  if (!claim.proofFile) return res.status(404).json({ error: 'No proof of payment was attached to this claim.' });

  const file = await readProof(claim.proofFile);
  if (!file) return res.status(404).json({ error: 'The proof image is no longer on the server.' });

  res.set('Content-Type', file.contentType);
  res.set('Cache-Control', 'private, max-age=300');
  return res.send(file.bytes);
}));

// What needs this person's attention, and how long they have. Shaped by role.
app.get('/api/alerts', requireUser, wrap(async (req, res) => {
  const claims = await readClaims();
  res.json(buildAlerts(req.user, claims, getCycleDetails()));
}));

app.get('/api/claims/mine', requireUser, wrap(async (req, res) => {
  const claims = await readClaims();
  res.json(claims.filter((claim) => claim.submittedBy === req.user.email).sort(newestFirst));
}));

/**
 * The manager dashboard feed: every claim in this approver's patch, whatever its status,
 * so the summary cards can show pending, approved and rejected side by side.
 *
 * Scoping happens here rather than in the browser. A regional manager is never sent
 * another region's claims, so no filter choice in the UI can widen what they see.
 */
app.get('/api/claims/manager', requireUser, requireRole('manager', 'hr', 'admin'), wrap(async (req, res) => {
  const claims = await readClaims();
  const scoped = visibleToManager(claims, req.user).sort(newestFirst);
  const global = req.user.role === 'hr' || req.user.role === 'admin';
  res.json({
    scope: {
      global,
      // The regions this person is answerable for, which drives the default filter.
      regions: global ? [...new Set(claims.map((claim) => claim.region).filter(Boolean))].sort() : (req.user.regions || []).slice().sort(),
      name: req.user.name,
      currentCycle: getCycleDetails().key,
    },
    // Regions actually present in their claims, so the dropdown never offers an empty one.
    regionsInView: [...new Set(scoped.map((claim) => claim.region).filter(Boolean))].sort(),
    counts: statusCounts(scoped),
    claims: scoped,
  });
}));

// Kept for the older accordion view: only what is waiting on this person right now.
app.get('/api/claims/review', requireUser, requireRole('manager', 'hr', 'admin'), wrap(async (req, res) => {
  const claims = await readClaims();
  const pending = claims.filter((claim) => claim.status === STATUS.PENDING_MANAGER && isForReviewer(claim, req.user));
  res.json({ regions: groupByRegion(pending.sort(newestFirst)), count: pending.length });
}));

/**
 * Every claim HR can act on, flat.
 *
 * Splitting these across three tabs meant HR could never answer "what happened in Coast
 * last cycle" without visiting each one. One list with filters answers that, and the
 * statuses become a filter like any other. The cycles actually present in the data are
 * returned alongside, so the filter offers real periods rather than a guess at which
 * months exist.
 */
app.get('/api/claims/all', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const claims = (await readClaims()).sort(newestFirst);
  const current = getCycleDetails();

  const cycleKeys = [...new Set(claims.map((claim) => claim.cycleKey || cycleOf(claim.submittedAt)).filter(Boolean))];
  if (!cycleKeys.includes(current.key)) cycleKeys.push(current.key);

  const cycles = cycleKeys
    .sort((a, b) => b.localeCompare(a))
    .map((key) => {
      const cycle = cycleFromKey(key);
      return cycle
        ? { key, label: cycle.label, range: cycle.range, current: key === current.key }
        : { key, label: key, range: '', current: false };
    });

  res.json({
    claims,
    cycles,
    regions: [...new Set(claims.map((claim) => claim.region).filter(Boolean))].sort(),
    currentCycle: current.key,
  });
}));

// Live Active Queue: approved in the cycle that is still open. Read-only — these are not
// payable until the cycle closes and the scheduler seals them into a batch.
app.get('/api/claims/live', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const cycle = getCycleDetails();
  const claims = await readClaims();
  const live = claims.filter((claim) => claim.status === STATUS.APPROVED && (claim.cycleKey || cycleOf(claim.submittedAt)) === cycle.key);
  res.json({
    cycle: { key: cycle.key, label: cycle.label, range: cycle.range, closesAt: cycle.batchAt.toISOString() },
    regions: groupByRegion(live.sort(newestFirst)),
    count: live.length,
    total: live.reduce((sum, claim) => sum + claim.amount, 0),
  });
}));

// Ready for Payment: sealed batches from cycles that have closed, grouped by cycle so a
// batch reads as one payment run rather than a flat list.
app.get('/api/claims/approved', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const claims = await readClaims();
  const batched = claims.filter((claim) => claim.status === STATUS.BATCHED_FOR_HR);
  const byCycle = new Map();
  for (const claim of batched) {
    const key = claim.cycleKey || cycleOf(claim.submittedAt);
    if (!byCycle.has(key)) byCycle.set(key, []);
    byCycle.get(key).push(claim);
  }
  const batches = [...byCycle.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, items]) => {
      const cycle = getCycleDetails(items[0].submittedAt);
      return { cycleKey: key, label: cycle.label, range: cycle.range, count: items.length, total: items.reduce((sum, claim) => sum + claim.amount, 0), regions: groupByRegion(items.sort(newestFirst)) };
    });
  res.json({ batches, count: batched.length });
}));

app.get('/api/claims/paid', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const claims = await readClaims();
  const paid = claims.filter((claim) => COMPLETED_STATUSES.includes(claim.status));
  res.json({ regions: groupByRegion(paid.sort(newestFirst)), count: paid.length });
}));

/**
 * Each person's wallet across the manager's team: allocated, drawn down, and left unspent.
 *
 * "Saved" is what the department keeps if the cycle ends here, so pending claims count as
 * spent — the cautious reading. A manager asked to control a budget needs to see the
 * balances, not only the claims that happened to cross their desk.
 */
// HR's overview: every region's allowance and what has been drawn against it this cycle.
app.get('/api/analytics/regions', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const [users, claims] = await Promise.all([allUsers(), readClaims()]);
  const cycle = getCycleDetails();
  res.json({
    cycle: { key: cycle.key, label: cycle.label, range: cycle.range, closesAt: cycle.batchAt.toISOString() },
    ...regionalSummary(users, claims, cycle.key),
  });
}));

app.get('/api/team/budgets', requireUser, requireRole('manager', 'hr', 'admin'), wrap(async (req, res) => {
  const [users, claims] = await Promise.all([allUsers(), readClaims()]);
  const cycle = getCycleDetails();
  const global = req.user.role === 'hr' || req.user.role === 'admin';
  const regions = new Set(req.user.regions || []);
  const reports = new Set(req.user.approvesFor || []);

  // Only people with something to spend: a zero-allowance row is not a budget.
  const team = users.filter((person) => person.isStaff && person.active !== false && (Number(person.transportPerCycle) || 0) > 0 && (
    global || reports.has(person.email) || (person.region && regions.has(person.region))
  ));

  const byPerson = indexClaimsByPerson(claims);
  const people = team
    .map((person) => ({
      name: person.name,
      email: person.email,
      region: person.region,
      zone: person.zone,
      monthly: person.transportMonth,
      ...cycleLedger(person, claims, cycle.key, byPerson),
    }))
    .sort((a, b) => b.used - a.used);

  const sum = (pick) => people.reduce((total, person) => total + pick(person), 0);
  res.json({
    cycle: { key: cycle.key, label: cycle.label, range: cycle.range, closesAt: cycle.batchAt.toISOString() },
    scope: { global, regions: global ? [] : [...regions].sort() },
    people,
    totals: {
      staff: people.length,
      allocated: sum((p) => p.base),
      used: sum((p) => p.used),
      saved: sum((p) => p.saved),
      awaiting: sum((p) => p.awaiting),
      onTopUp: people.filter((p) => p.usingTopUp).length,
    },
  });
}));

app.get('/api/analytics/savings', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const cycle = req.query.cycle || cycleOf();
  const [users, claims] = await Promise.all([allUsers(), readClaims()]);
  // Only claimants hold an allowance, so approvers would otherwise show as zero-budget staff.
  const regions = savingsByRegion(users.filter((user) => user.isStaff), claims, cycle);
  res.json({ cycle, regions, totals: savingsTotals(regions) });
}));

// Manual batch trigger. The scheduler seals cycles on its own; this exists so a batch can
// be re-run after a failure, and so the flow can be demonstrated without waiting for the
// 16th. `force` seals a cycle that has not closed yet and is for testing only.
app.post('/api/batches/run', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const { cycleKey, force } = req.body || {};
  const result = await runBatch(cycleKey || getCycleDetails().key, { force: Boolean(force) });
  res.status(result.ok ? 200 : 422).json(result);
}));

/**
 * Marks claims as completed: Finance has paid them.
 *
 * Takes a list rather than one id, because HR settles a whole payment run at once and
 * ticking forty rows individually is how a status stops being maintained. Each claim is
 * checked on its own, so one ineligible row does not sink the rest — the response says
 * which went through and which did not.
 */
app.post('/api/claims/complete', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'No claims were selected.' });

  const claims = await readClaims();
  const note = req.body?.note || '';
  const completed = [];
  const skipped = [];

  for (const id of ids) {
    const claim = claims.find((item) => item.id === id);
    if (!claim) { skipped.push({ id, reason: 'Not found.' }); continue; }
    const permission = canAct(req.user, claim, 'complete');
    if (!permission.allowed) { skipped.push({ id, reason: permission.reason }); continue; }
    await updateClaim(id, (current) => applyDecision(current, { actor: req.user.email, action: 'complete', note }));
    completed.push(id);
  }

  return res.json({ completed: completed.length, skipped, ids: completed });
}));

app.post('/api/claims/:id/decision', requireUser, wrap(async (req, res) => {
  const { action, note } = req.body || {};
  const claims = await readClaims();
  const claim = claims.find((item) => item.id === req.params.id);
  if (!claim) return res.status(404).json({ error: 'Claim not found.' });

  const permission = canAct(req.user, claim, action);
  if (!permission.allowed) return res.status(403).json({ error: permission.reason });

  const updated = await updateClaim(claim.id, (current) => applyDecision(current, { actor: req.user.email, action, note }));
  return res.json({ claim: updated });
}));

app.use((error, _req, res, _next) => {
  // An unreadable directory is a configuration problem the operator can fix, so say so
  // plainly instead of returning a generic 500.
  if (error.status === 503) return res.status(503).json({ error: error.message });
  console.error('[api]', error);
  return res.status(500).json({ error: 'Something went wrong on the server.' });
});

function isForReviewer(claim, user) {
  if (user.role === 'admin') return true;
  if (claim.assignedTo === user.email) return true;
  return claim.assignedTo === 'hr' && user.role === 'hr';
}

async function ratesForRegion(region) {
  const table = await getRates();
  return Object.fromEntries(VEHICLES.map((vehicle) => [vehicle, rateFrom(table, vehicle, region)]));
}

function newestFirst(a, b) {
  return String(b.submittedAt).localeCompare(String(a.submittedAt));
}

function publicUser(user) {
  const { manager1Email, manager2Email, ...rest } = user;
  return { ...rest, manager1Email, manager2Email, isOwnFirstApprover: user.email === manager1Email };
}

export async function start(port = PORT) {
  const cycle = getCycleDetails();
  const server = app.listen(port, () => {
    console.log(`Songa API on http://localhost:${port}`);
    console.log(`[cycle] ${cycle.label}, ${cycle.range} — closes ${cycle.batchAt.toISOString()}`);
  });

  const config = await reloadDirectory();
  if (!config.ok) {
    console.error(`[directory] could not be read: ${config.error}`);
  } else if (!config.userCount) {
    // An empty directory is the state after a fresh install, and nobody can sign in. Say
    // so plainly rather than letting the first login fail with "not recognised".
    console.warn('\n[directory] EMPTY. Nobody can sign in until somebody exists.');
    console.warn('[directory] Add people in Admin > User roles.\n');
  } else {
    console.log(`[directory] ${config.userCount} staff loaded — roles: ${JSON.stringify(config.roles)}`);
    for (const warning of config.warnings) console.warn(`[directory] ${warning.issue}: ${warning.emails.join(', ')}`);
  }

  if (process.env.SONGA_DISABLE_SCHEDULER === 'true') {
    console.log('[batch] scheduler disabled by SONGA_DISABLE_SCHEDULER');
    return server;
  }
  startScheduler();
  // A locally hosted server is often asleep at 08:00, so recover anything the cron missed.
  catchUpMissedBatches().catch((error) => console.error('[batch] catch-up failed:', error));
  return server;
}

// Only listen when run directly, so tests can import the app and drive it themselves.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  start();
}

export { app };
