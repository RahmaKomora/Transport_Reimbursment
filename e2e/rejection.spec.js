import { expect, test } from '@playwright/test';
import { PASSWORD, PEOPLE } from './people.js';

/**
 * A rejection, end to end (TT-046, TT-047).
 *
 * A rejection is final for the claimant — the trip cannot be tracked again — so what
 * matters is that they hear about it and can see who decided and why, to take it up with
 * their manager. The claim is made and rejected through the API, which is not what this
 * tests; what the claimant then sees is.
 */

const token = async (request, who) => (await (await request.post('/api/auth/login', { data: { email: PEOPLE[who].email, password: PASSWORD } })).json()).token;

test('a rejected claim reaches the claimant with who decided and why', async ({ page, request }, testInfo) => {
  const agent = await token(request, 'agent');
  const manager = await token(request, 'manager');

  // Paid far more than 1 km is worth, so it goes to the manager rather than being approved.
  const code = `REJ${testInfo.project.name.toUpperCase()}${Date.now().toString(36).toUpperCase()}`.replace(/[^A-Z0-9]/g, '').slice(0, 10).padEnd(10, '9');
  const made = await request.post('/api/claims', {
    headers: { Authorization: `Bearer ${agent}` },
    data: { amount: 900, km: 1, vehicle: 'Piki', purposes: ['Farmer Visit'], mpesaCode: code, paidOn: new Date().toISOString().slice(0, 10) },
  });
  expect(made.status()).toBe(201);
  const { claim } = await made.json();
  expect(claim.status).toBe('Pending Manager Review');

  const reason = 'Distance does not support this amount';
  const decided = await request.post(`/api/claims/${claim.id}/decision`, { headers: { Authorization: `Bearer ${manager}` }, data: { action: 'reject', note: reason } });
  expect(decided.ok()).toBeTruthy();

  await page.addInitScript((value) => { window.localStorage.setItem('songa.session', value); }, agent);
  await page.goto('/songa/', { waitUntil: 'domcontentloaded' });

  // The bell lives in the menu on a phone.
  if (page.viewportSize().width <= 900) await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.side-panel .bell').click();
  const notice = page.locator('.bell-item', { hasText: /rejected/ });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('talk to your manager');

  // The notice leads to My Claims, where the claim says who rejected it and why.
  await notice.click();
  const row = page.locator('.trip-row', { hasText: claim.id });
  await expect(row).toContainText(`Rejected by ${PEOPLE.manager.email}: ${reason}`);
});
