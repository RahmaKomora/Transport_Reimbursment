import { rmSync } from 'node:fs';
import { appendClaim, upsertUser } from '../server/store.js';
import { saveRates } from '../server/rates.js';
import { setPassword } from '../server/passwords.js';
import { closeDb } from '../server/db.js';
import { PASSWORD, PEOPLE } from './people.js';

/**
 * A throwaway database for the browser tests: one person per role, each with a password,
 * rates for their region, and a handful of claims so the tables have rows to lay out.
 *
 * Runs before the test API starts, against SONGA_DB_PATH, which playwright.config.js
 * points at its own file — never the development database.
 */
async function seed() {
  const file = process.env.SONGA_DB_PATH;
  if (!file || !file.includes('e2e')) throw new Error('SONGA_DB_PATH must point at the e2e database.');
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });

  for (const person of Object.values(PEOPLE)) {
    await upsertUser({
      ...person,
      region: 'Nyanza',
      zone: 'Kisumu Central',
      department: 'Operations',
      manager1Name: PEOPLE.manager.name,
      manager1Email: person === PEOPLE.manager ? '' : PEOPLE.manager.email,
      transportPerCycle: 6000,
      maxPerCycle: 8000,
      extraAllowancePerCycle: 2000,
    });
    await setPassword(person.email, PASSWORD);
  }

  await saveRates({ Nyanza: { Piki: 25, Matatu: 15, 'Personal Piki': 20, 'Personal Car': 40 } }, 'e2e');

  // Long names and purposes on purpose: they are what pushes a table wider than a phone.
  const purposes = ['Farmer Visit', 'Group Training, Input Delivery and Field Day Follow-up', 'Repayment Collection'];
  for (let index = 0; index < 6; index += 1) {
    const at = new Date(Date.now() - index * 86_400_000).toISOString();
    await appendClaim({
      id: `SNG-E2E-${index}`,
      submittedAt: at,
      submittedBy: PEOPLE.agent.email,
      staffName: PEOPLE.agent.name,
      region: 'Nyanza',
      zone: 'Kisumu Central',
      tripDate: at.slice(0, 10),
      purpose: purposes[index % purposes.length],
      vehicle: 'Piki',
      km: 12.4 + index,
      rate: 25,
      estimate: 310,
      amount: 300 + index * 150,
      route: 'Kisumu Central → Kondele → Nyamasaria Market',
      status: index % 3 === 0 ? 'Pending Manager Review' : 'Approved',
      assignedTo: index % 3 === 0 ? PEOPLE.manager.email : 'hr',
      mpesaCode: `QWE${String(index).padStart(3, '0')}ABC9`,
      decisionLog: [{ actor: 'system', action: 'submitted', note: 'Seeded for the browser tests.', at }],
    });
  }
  console.log('[e2e] seeded', Object.keys(PEOPLE).length, 'people and 6 claims');
}

seed()
  .catch((error) => { console.error('[e2e] seed failed:', error); process.exitCode = 1; })
  .finally(() => closeDb());
