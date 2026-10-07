import 'dotenv/config';
import { readUsers, updateUser } from './store.js';
import { closeDb, dbPath } from './db.js';
import { SETUP_CODE_DAYS, issueSetupCode } from './passwords.js';

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
 * It also prints a one-time setup code for the account, because a forgotten password is
 * the likeliest lock-out of all and there is no email to send a reset link to. It is also
 * how the very first admin gets a password, before anybody exists to issue them one.
 */
async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();

  if (!email) {
    console.error('');
    console.error('Usage: npm run admin:unlock <email>');
    console.error('');
    console.error('Gives that account the admin role, makes it active again and prints a setup code.');
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
  // A forgotten password is the commonest way to be locked out, and there is no email to
  // send a reset to, so the code is printed here for whoever ran this.
  const { code } = await issueSetupCode(email, 'admin:unlock');

  console.log('');
  console.log(`Unlocked ${email}`);
  console.log(`  role    ${was.role} (${was.roleSource})  ->  admin (manual)`);
  console.log(`  active  ${was.active}  ->  true`);
  console.log(`  in      ${dbPath()}`);
  console.log('');
  console.log(`  setup code  ${code}   (valid ${SETUP_CODE_DAYS} days, once)`);
  console.log('  On the sign-in page choose "Use a setup code" and enter it');
  console.log('  with a new password. Your old password keeps working until you do.');
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
