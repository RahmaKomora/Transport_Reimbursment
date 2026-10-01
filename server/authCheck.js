import 'dotenv/config';
import { ALLOWED_DOMAIN, EXTRA_ALLOWED_EMAILS, GOOGLE_CLIENT_ID, TEST_SIGNIN_EMAILS } from './config.js';
// The directory, not the raw store: sign-in resolves against getUsers(), which also
// contains the approvers who have no record of their own. Checking the store instead
// reported every one of them as missing.
import { getUsers } from './directory.js';
import { closeDb } from './db.js';

/**
 * Preflight for switching Google sign-in on.
 *
 * Turning it on disables the email fallback outright, so if nothing can get through the
 * Google path nobody can sign in at all. Everything that decides that is checkable in
 * advance except Google's own configuration, so this checks the rest and says plainly
 * whether an administrator would still be able to get in.
 *
 *   npm run auth:check
 *
 * Read-only. It changes nothing.
 */
const tick = (ok) => (ok ? '  ok  ' : ' FAIL ');
const line = () => console.log('─'.repeat(68));

async function main() {
  console.log('');
  console.log('Google sign-in preflight');
  line();

  const problems = [];
  const notes = [];

  // 1. Is the switch on, and does the value look like a client ID at all?
  const configured = Boolean(GOOGLE_CLIENT_ID);
  const shaped = GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com');
  if (!configured) {
    console.log(`${tick(true)} Google sign-in is OFF. Email sign-in is active.`);
    notes.push('Nothing here can lock you out yet. Set SONGA_GOOGLE_CLIENT_ID to switch over.');
  } else {
    console.log(`${tick(shaped)} Client ID ${shaped ? 'looks right' : 'does NOT end in .apps.googleusercontent.com'}`);
    console.log(`        ${GOOGLE_CLIENT_ID}`);
    if (!shaped) problems.push('SONGA_GOOGLE_CLIENT_ID does not look like a Google client ID.');
    notes.push('With this set, email sign-in is refused. Comment it out and restart to undo.');
  }

  console.log(`${tick(true)} Allowed domain: ${ALLOWED_DOMAIN || '(none — any verified Google account)'}`);
  if (EXTRA_ALLOWED_EMAILS.length) {
    console.log(`${tick(true)} Also allowed from outside the domain: ${EXTRA_ALLOWED_EMAILS.join(', ')}`);
  }

  // A bypass has to be impossible to forget about, so it is reported whether or not
  // anything else is wrong.
  if (TEST_SIGNIN_EMAILS.length) {
    console.log(`${tick(false)} ${TEST_SIGNIN_EMAILS.length} address(es) can sign in by EMAIL ALONE, bypassing Google:`);
    for (const email of TEST_SIGNIN_EMAILS) console.log(`        ${email}`);
    notes.push('SONGA_TEST_SIGNIN_EMAILS must be empty before this handles real claims.');
  }

  // 2. Who would actually get through? This is the question that matters.
  line();
  const users = await getUsers({ force: true });
  const admissible = (email) => !ALLOWED_DOMAIN
    || email.endsWith(`@${ALLOWED_DOMAIN}`)
    || EXTRA_ALLOWED_EMAILS.includes(email);

  const keyholders = users
    .filter((user) => user.active !== false)
    .filter((user) => ['admin', 'hr'].includes(user.role));

  const canGetIn = keyholders.filter((user) => admissible(user.email));

  console.log(`Accounts that could administer Songa after the switch: ${canGetIn.length}`);
  for (const user of keyholders) {
    const ok = admissible(user.email);
    console.log(`${tick(ok)} ${user.email.padEnd(38)} ${user.role.padEnd(6)} ${ok ? '' : '← domain rule would refuse this one'}`);
  }

  if (!canGetIn.length) {
    problems.push('No active admin or HR account would pass the domain rule. Switching on would lock everyone out.');
  }

  // 3. Specific addresses named on the command line — "will my test accounts work?"
  const asked = process.argv.slice(2).map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (asked.length) {
    line();
    console.log(`Checking ${asked.length} named address${asked.length === 1 ? '' : 'es'}:`);
    const byEmail = new Map(users.map((user) => [user.email, user]));
    for (const email of asked) {
      const user = byEmail.get(email);
      if (!user) {
        console.log(`${tick(false)} ${email.padEnd(34)} not in the directory — cannot sign in`);
        problems.push(`${email} is not in the directory.`);
        continue;
      }
      const active = user.active !== false;
      const allowed = admissible(email);
      const how = user.isStaff ? 'own record' : 'derived approver';
      const role = user.role;
      console.log(`${tick(active && allowed)} ${email.padEnd(34)} ${role.padEnd(11)} ${how.padEnd(17)}${active ? '' : 'INACTIVE '}${allowed ? '' : 'domain rule refuses'}`);
      if (!active) problems.push(`${email} is deactivated.`);
      if (!allowed) problems.push(`${email} is outside ${ALLOWED_DOMAIN} and not in SONGA_EXTRA_ALLOWED_EMAILS.`);
    }
    const derived = asked.map((email) => byEmail.get(email)).filter((user) => user && user.isStaff === false);
    if (derived.length) {
      notes.push(`${derived.length} of those exist only because others name them as approver. They can sign in and approve, but carry no allowance and cannot submit claims — and their access ends if every person they approve for is deactivated.`);
    }
  }

  // 4. Active accounts that would lose access. Not a blocker, but a surprise if unsaid.
  const blocked = users.filter((user) => user.active !== false && user.isStaff !== false && !admissible(user.email));
  if (blocked.length) {
    line();
    console.log(`${blocked.length} other active account(s) would be refused by the domain rule:`);
    for (const user of blocked.slice(0, 10)) console.log(`        ${user.email}`);
    if (blocked.length > 10) console.log(`        ...and ${blocked.length - 10} more`);
    notes.push('Add any of those to SONGA_EXTRA_ALLOWED_EMAILS if they still need to sign in.');
  }

  // 5. The one thing this cannot check.
  line();
  console.log('Not checkable from here — confirm in the Google Cloud console:');
  console.log('        Authorised JavaScript origins must include  http://localhost:5174');
  console.log('        (the page origin, not the API port)');

  line();
  if (problems.length) {
    console.log('DO NOT switch on yet:');
    for (const problem of problems) console.log(`  · ${problem}`);
  } else {
    console.log('No blockers found.');
  }
  for (const note of notes) console.log(`  · ${note}`);
  console.log('');
  console.log('If sign-in fails after the switch:  npm run admin:unlock <your-email>');
  console.log('');

  closeDb();
  process.exitCode = problems.length ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exit(1); });
