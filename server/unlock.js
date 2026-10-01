import 'dotenv/config';
import { readUsers, updateUser } from './store.js';
import { closeDb, dbPath } from './db.js';

/**
 * Break glass: give an account admin and switch it back on, writing straight to the
 * database.
 *
 *   npm run admin:unlock rahma.komora@oneacrefund.org
 *
 * This exists for the case where nobody can sign in — a misconfigured Google client, an
 * administrator deactivated by mistake, a role that resolved to something without the
 * admin screens. Every one of those is normally fixed in Admin > User roles, which is
 * exactly what is unreachable when it happens.
 *
 * It needs no server running and no session. Anyone who can run this already has the
 * database file, so it grants nothing they could not have taken with a SQL client; the
 * point is to make the recovery obvious rather than to guard it.
 *
 * If the Google configuration itself is the problem, this is not the fix — comment out
 * SONGA_GOOGLE_CLIENT_ID in .env and restart, and email sign-in comes back.
 */
async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();

  if (!email) {
    console.error('');
    console.error('Usage: npm run admin:unlock <email>');
    console.error('');
    console.error('Gives that account the admin role and makes it active again.');
    console.error('');
    const users = await readUsers();
    const admins = users.filter((user) => user.role === 'admin');
    if (admins.length) {
      console.error('Current admins:');
      for (const user of admins) console.error(`  ${user.email}${user.active === false ? '  (INACTIVE)' : ''}`);
      console.error('');
    }
    closeDb();
    process.exitCode = 1;
    return;
  }

  const users = await readUsers();
  const person = users.find((user) => user.email === email);

  if (!person) {
    console.error('');
    console.error(`No record for ${email}.`);
    console.error('');
    console.error('This only repairs an account that already exists. Close matches:');
    const stem = email.split('@')[0].slice(0, 5);
    const near = users.filter((user) => user.email.includes(stem)).slice(0, 5);
    for (const user of near) console.error(`  ${user.email}`);
    if (!near.length) console.error('  (none)');
    console.error('');
    closeDb();
    process.exitCode = 1;
    return;
  }

  const was = { role: person.role, roleSource: person.roleSource, active: person.active };
  await updateUser(email, { roleOverride: 'admin', active: true });

  console.log('');
  console.log(`Unlocked ${email}`);
  console.log(`  role    ${was.role} (${was.roleSource})  ->  admin (manual)`);
  console.log(`  active  ${was.active}  ->  true`);
  console.log(`  in      ${dbPath()}`);
  console.log('');
  console.log('The role is now set explicitly, so it no longer depends on the job title.');
  console.log('Clear that override in Admin > User roles once you are back in, if you want');
  console.log('the title to decide again.');
  console.log('');
  console.log('Restart the API so it re-reads the directory:  npm run server');
  console.log('');

  closeDb();
}

main().catch((error) => { console.error(error); process.exit(1); });
