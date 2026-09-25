import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';
import { rmSync } from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'server', 'data', 'store-test.db');
process.env.SONGA_DB_PATH = FILE;

const store = await import('./store.js');
const { closeDb } = await import('./db.js');

const person = (over) => ({
  name: 'Test Person', email: 'test@oneacrefund.org', zone: 'Kikoneni', roleLabel: 'Tupande Agent',
  region: 'Coast', manager1Name: 'Boss', manager1Email: 'boss@oneacrefund.org',
  manager2Name: '', manager2Email: '', transportMonth: 6000, transportPerCycle: 3000,
  extraAllowancePerCycle: 0, maxPerCycle: 4000, manager1OutOfOffice: false, active: true, ...over,
});

const claim = (over) => ({
  id: 'C1', submittedAt: new Date().toISOString(), submittedBy: 'test@oneacrefund.org',
  staffName: 'Test Person', region: 'Coast', zone: 'Kikoneni', tripDate: '2026-09-24',
  purpose: 'Farmer visits', vehicle: 'Piki', km: 12, rate: 30, estimate: 360, amount: 400,
  status: 'PENDING_MANAGER', assignedTo: 'boss@oneacrefund.org', decisionLog: [], route: '',
  cycleKey: '2026-09-C2', approvalSource: '', ceiling: 4000, ...over,
});

before(async () => { await store.upsertUser(person()); });
after(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${FILE}${suffix}`, { force: true }); } catch {} }
});

test('a person survives a reload, which is the whole point of leaving the sheet', async () => {
  const [saved] = await store.readUsers();
  assert.equal(saved.email, 'test@oneacrefund.org');
  assert.equal(saved.region, 'Coast');
  assert.equal(saved.transportPerCycle, 3000);
  assert.equal(saved.active, true);
});

test('a job title becomes a role, so nobody has to keep the two in step by hand', async () => {
  const [saved] = await store.readUsers();
  assert.equal(saved.roleLabel, 'Tupande Agent');
  assert.equal(saved.role, 'field_agent');
  assert.equal(store.normaliseRole('Zone Supervisor'), 'manager');
  assert.equal(store.normaliseRole('People Operations'), 'hr');
});

test('adding somebody twice updates them rather than creating a second account', async () => {
  await store.upsertUser(person({ zone: 'Msambweni' }));
  const people = await store.readUsers();
  assert.equal(people.length, 1, 'email is the identity, so there can only be one');
  assert.equal(people[0].zone, 'Msambweni');
});

test('an email is stored lowercase, because a claim carries it as the owner', async () => {
  await store.upsertUser(person({ email: 'SHOUTY@oneacrefund.org' }));
  const found = (await store.readUsers()).find((p) => p.email === 'shouty@oneacrefund.org');
  assert.ok(found, 'a capitalised sign-in must not create a second person');
  await store.deleteUsers(['shouty@oneacrefund.org']);
});

test('an edit changes only the fields it names', async () => {
  await store.updateUser('test@oneacrefund.org', { maxPerCycle: 9000 });
  const [saved] = await store.readUsers();
  assert.equal(saved.maxPerCycle, 9000);
  assert.equal(saved.name, 'Test Person', 'a partial edit must not blank the rest');
  assert.equal(saved.transportPerCycle, 3000);
});

test('deactivating somebody keeps their record, so their claims keep an owner', async () => {
  await store.updateUser('test@oneacrefund.org', { active: false });
  assert.equal((await store.readUsers())[0].active, false);
  await store.updateUser('test@oneacrefund.org', { active: true });
});

test('editing somebody who is not there changes nothing and says so', async () => {
  assert.equal(await store.updateUser('ghost@oneacrefund.org', { zone: 'Nowhere' }), 0);
  assert.equal((await store.readUsers()).length, 1);
});

test('a claim round-trips with its decision log intact', async () => {
  await store.appendClaim(claim({ decisionLog: [{ at: '2026-09-24T08:00:00Z', by: 'system', action: 'submitted' }] }));
  const [saved] = await store.readClaims();
  assert.equal(saved.id, 'C1');
  assert.equal(saved.amount, 400);
  assert.equal(saved.decisionLog.length, 1);
  assert.equal(saved.decisionLog[0].action, 'submitted');
});

test('a claim update is read-modify-write in one transaction', async () => {
  // The sheet could not do this: two approvers deciding at once both read the same row
  // and the second write discarded the first.
  const updated = await store.updateClaim('C1', (current) => ({
    ...current,
    status: 'APPROVED',
    decisionLog: [...current.decisionLog, { at: '2026-09-24T09:00:00Z', by: 'boss@oneacrefund.org', action: 'approved' }],
  }));
  assert.equal(updated.status, 'APPROVED');
  const [saved] = await store.readClaims();
  assert.equal(saved.status, 'APPROVED');
  assert.equal(saved.decisionLog.length, 2, 'the earlier decision is still there');
});

test('updating a claim that does not exist returns nothing rather than inventing one', async () => {
  assert.equal(await store.updateClaim('NOPE', (c) => c), null);
  assert.equal((await store.readClaims()).length, 1);
});

test('a failed update leaves the claim as it was', async () => {
  await assert.rejects(store.updateClaim('C1', () => { throw new Error('reviewer changed their mind'); }));
  const [saved] = await store.readClaims();
  assert.equal(saved.status, 'APPROVED', 'no half-applied decision');
  assert.equal(saved.decisionLog.length, 2);
});

test('deleting is by email and reports how many went', async () => {
  await store.upsertUser(person({ email: 'temp@oneacrefund.org' }));
  assert.equal(await store.deleteUsers(['temp@oneacrefund.org', 'never@oneacrefund.org']), 1);
  assert.equal((await store.readUsers()).length, 1);
});

test('adding somebody who already exists is refused, not silently merged', async () => {
  // The admin screen checks for a duplicate against a directory cache up to a minute
  // old. If that check is the only guard, a re-submitted Add form overwrites a real
  // person's region, approvers and budgets with whatever the blank form held.
  await store.upsertUser(person({ email: 'incumbent@oneacrefund.org', region: 'Rift', transportPerCycle: 7500 }));

  await assert.rejects(
    () => store.insertUser(person({ email: 'incumbent@oneacrefund.org', region: '', transportPerCycle: 0 })),
    (error) => error.status === 409,
  );

  const kept = (await store.readUsers()).find((p) => p.email === 'incumbent@oneacrefund.org');
  assert.equal(kept.region, 'Rift', 'the existing record is untouched');
  assert.equal(kept.transportPerCycle, 7500);
  await store.deleteUsers(['incumbent@oneacrefund.org']);
});

test('the refusal ignores case, because an address is one identity', async () => {
  await store.upsertUser(person({ email: 'solo@oneacrefund.org' }));
  await assert.rejects(() => store.insertUser(person({ email: 'SOLO@oneacrefund.org' })), (e) => e.status === 409);
  await store.deleteUsers(['solo@oneacrefund.org']);
});

test('adding a genuinely new person still works', async () => {
  await store.insertUser(person({ email: 'newcomer@oneacrefund.org', region: 'Nyanza' }));
  const found = (await store.readUsers()).find((p) => p.email === 'newcomer@oneacrefund.org');
  assert.equal(found.region, 'Nyanza');
  await store.deleteUsers(['newcomer@oneacrefund.org']);
});

test('an unrecognised job title falls through to requester', async () => {
  // The behaviour that makes the override necessary: HR invents a title, and Songa has
  // no rule for it, so the person quietly becomes a requester.
  assert.equal(store.normaliseRole('Zone Coordinator'), 'field_agent');
  assert.equal(store.resolveRole('Zone Coordinator', '').role, 'field_agent');
  assert.equal(store.resolveRole('Zone Coordinator', '').roleSource, 'title');
});

test('an admin can grant a role the job title does not imply', async () => {
  const resolved = store.resolveRole('Zone Coordinator', 'manager');
  assert.equal(resolved.role, 'manager');
  assert.equal(resolved.roleSource, 'manual');
});

test('a role that is not one of the four is ignored, never granted', async () => {
  // A typo must fall back to the job title rather than sit in the column granting
  // something nobody intended, or nothing at all.
  assert.equal(store.resolveRole('HR Officer', 'superuser').role, 'hr');
  assert.equal(store.resolveRole('HR Officer', 'superuser').roleSource, 'title');
  assert.equal(store.isRole('manager'), true);
  assert.equal(store.isRole('Manager'), false, 'the stored form is exact');
});

test('an override survives a reload, and clearing it hands the job title back', async () => {
  await store.upsertUser(person({ email: 'coord@oneacrefund.org', roleLabel: 'Zone Coordinator' }));
  const derived = (await store.readUsers()).find((p) => p.email === 'coord@oneacrefund.org');
  assert.equal(derived.role, 'field_agent');
  assert.equal(derived.roleSource, 'title');

  await store.updateUser('coord@oneacrefund.org', { roleOverride: 'manager' });
  const set = (await store.readUsers()).find((p) => p.email === 'coord@oneacrefund.org');
  assert.equal(set.role, 'manager');
  assert.equal(set.roleSource, 'manual');
  assert.equal(set.roleOverride, 'manager');

  await store.updateUser('coord@oneacrefund.org', { roleOverride: '' });
  const cleared = (await store.readUsers()).find((p) => p.email === 'coord@oneacrefund.org');
  assert.equal(cleared.role, 'field_agent', 'back to whatever the title says');
  assert.equal(cleared.roleSource, 'title');
  await store.deleteUsers(['coord@oneacrefund.org']);
});

test('re-importing the staff sheet does not wipe a role an admin set', async () => {
  // The sheet has no column for this and sends nothing, so a blank incoming role means
  // "no opinion" rather than "clear it". Getting this wrong would silently demote every
  // manually-promoted approver on the next import.
  await store.upsertUser(person({ email: 'keep@oneacrefund.org', roleLabel: 'Zone Coordinator' }));
  await store.updateUser('keep@oneacrefund.org', { roleOverride: 'hr' });

  await store.upsertUser(person({ email: 'keep@oneacrefund.org', roleLabel: 'Zone Coordinator', zone: 'Msambweni' }));

  const after = (await store.readUsers()).find((p) => p.email === 'keep@oneacrefund.org');
  assert.equal(after.zone, 'Msambweni', 'the import still updates what it does know');
  assert.equal(after.role, 'hr', 'and leaves alone what it does not');
  assert.equal(after.roleSource, 'manual');
  await store.deleteUsers(['keep@oneacrefund.org']);
});

test('adding somebody with an explicit role stores it from the start', async () => {
  await store.insertUser(person({ email: 'fresh@oneacrefund.org', roleLabel: 'Zone Coordinator', roleOverride: 'manager' }));
  const added = (await store.readUsers()).find((p) => p.email === 'fresh@oneacrefund.org');
  assert.equal(added.role, 'manager');
  assert.equal(added.roleSource, 'manual');
  await store.deleteUsers(['fresh@oneacrefund.org']);
});
