import { expect, test } from '@playwright/test';
import { PASSWORD, PEOPLE } from './people.js';

/**
 * A whole claim, the way a field officer makes one: start a trip, move, stop, attach the
 * M-Pesa proof, submit, and see it in My Trips.
 *
 * The GPS is simulated: the browser's geolocation is replaced with a stand-in the test moves
 * by hand, because emulated browsers only report the first position to watchPosition. The
 * distance still comes from the app's own tracking code rather than being typed in.
 *
 * This is the test that would have caught Submit silently doing nothing after the
 * account-name field was removed from the form.
 */

// A 1x1 PNG: small, but a real image the form's compressor can decode.
const PROOF = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// Kisumu, then a few hundred metres east in steps, as a piki ride would report it.
const ROUTE = [
  { latitude: -0.0917, longitude: 34.7680 },
  { latitude: -0.0917, longitude: 34.7710 },
  { latitude: -0.0915, longitude: 34.7745 },
  { latitude: -0.0912, longitude: 34.7790 },
];

// M-Pesa codes are checked for duplicates across every claim, and every device runs this
// test against the same database, so each run needs a code of its own.
const uniqueCode = () => `E2E${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2)}`.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10).padEnd(10, '7');

async function signInWithGps(page, context) {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(ROUTE[0]);
  await page.addInitScript((start) => {
    const watchers = new Map();
    let position = start;
    let next = 1;
    const report = (coords) => ({ coords: { ...coords, accuracy: 5 }, timestamp: Date.now() });
    const fake = {
      getCurrentPosition: (ok) => setTimeout(() => ok(report(position)), 10),
      watchPosition: (ok) => { const id = next++; watchers.set(id, ok); setTimeout(() => ok(report(position)), 10); return id; },
      clearWatch: (id) => watchers.delete(id),
    };
    Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => fake });
    window.__moveTo = (coords) => { position = coords; watchers.forEach((ok) => ok(report(coords))); };
  }, ROUTE[0]);

  const response = await page.request.post('/api/auth/login', { data: { email: PEOPLE.agent.email, password: PASSWORD } });
  const { token } = await response.json();
  await page.addInitScript((value) => { window.localStorage.setItem('songa.session', value); }, token);
  await page.goto('/songa/', { waitUntil: 'domcontentloaded' });
}

test('a field officer tracks a trip and submits a claim', async ({ page, context }) => {
  test.setTimeout(60_000);
  await signInWithGps(page, context);

  await page.getByRole('button', { name: 'Log new field trip' }).click();
  await page.getByText('Farmer Visit', { exact: true }).click();
  // TT-008 and TT-009: what the claimant writes has to survive the submission.
  await page.getByText('Other', { exact: true }).click();
  await page.getByPlaceholder('Enter the reason').fill('Collecting soil samples');
  await page.getByPlaceholder('Add useful context').fill('Road to Kondele flooded, went round by Nyamasaria');
  await page.locator('.transport-options').getByText('Piki', { exact: true }).click();

  await page.getByRole('button', { name: 'Start Tracking Journey' }).click();
  await expect(page.getByText(/Live tracking is active/)).toBeVisible();
  for (const point of ROUTE.slice(1)) {
    await page.evaluate((coords) => window.__moveTo(coords), point);
    await page.waitForTimeout(200);
  }
  await expect(page.locator('.live-counter strong').first()).not.toHaveText('0.0 km');

  // Stopping takes two taps, so a bump in a pocket does not end the trip.
  await page.getByRole('button', { name: 'Stop & Submit' }).click();
  await page.getByRole('button', { name: 'Tap again to stop' }).click();

  await expect(page.getByRole('heading', { name: 'M-Pesa submission' })).toBeVisible();
  const code = uniqueCode();
  await page.getByPlaceholder('e.g. QWE123ABC1').fill(code);
  await page.getByPlaceholder('Enter amount').fill('150');
  // TT-025: what was paid is set against what the distance was worth.
  await expect(page.locator('.total-card').getByText('Expected cost', { exact: true })).toBeVisible();
  await expect(page.locator('.cost-compare')).toBeVisible();
  // TT-033: the payment date is asked for, and starts as the trip date.
  await expect(page.getByLabel('Date paid')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.locator('input[type=file]').setInputFiles({ name: 'mpesa.png', mimeType: 'image/png', buffer: PROOF });
  await expect(page.getByText(/ready \(/)).toBeVisible();

  const submit = page.getByRole('button', { name: 'Submit reimbursement' });
  await expect(submit).toBeEnabled();
  await page.screenshot({ path: `test-results/screens/${test.info().project.name}/40-claim-form.png`, fullPage: true });
  const saved = page.waitForResponse((reply) => reply.url().endsWith('/api/claims') && reply.request().method() === 'POST');
  await submit.click();
  const reply = await saved;
  expect(reply.status(), 'the claim reaches the server and is stored').toBe(201);
  const body = await reply.json();
  expect(body.claim.mpesaCode).toBe(code);
  expect(body.claim.km).toBeGreaterThan(0);
  expect(body.claim.proofFile).not.toBe('');
  expect(body.claim.otherReason).toBe('Collecting soil samples');
  expect(body.claim.comment).toBe('Road to Kondele flooded, went round by Nyamasaria');

  // And the claimant sees both again when they reopen their trips.
  if (page.viewportSize().width <= 900) await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.side-panel [data-view="trips"]').click();
  const row = page.locator('.trip-row', { hasText: body.claim.id });
  await expect(row).toContainText('Other: Collecting soil samples');
  await expect(row).toContainText('Road to Kondele flooded');
});

test('a trip with no distance cannot be submitted (TT-024)', async ({ page, context }) => {
  test.setTimeout(60_000);
  await signInWithGps(page, context);
  await page.getByRole('button', { name: 'Log new field trip' }).click();
  await page.getByText('Farmer Visit', { exact: true }).click();
  await page.locator('.transport-options').getByText('Piki', { exact: true }).click();
  await page.getByRole('button', { name: 'Start Tracking Journey' }).click();
  await expect(page.getByText(/Live tracking is active/)).toBeVisible();

  // Stopped without moving: the start and end are the same place.
  await page.getByRole('button', { name: 'Stop & Submit' }).click();
  await page.getByRole('button', { name: 'Tap again to stop' }).click();
  await page.getByPlaceholder('e.g. QWE123ABC1').fill('ZER0DIST11');
  await page.getByPlaceholder('Enter amount').fill('100');
  await page.locator('input[type=file]').setInputFiles({ name: 'mpesa.png', mimeType: 'image/png', buffer: PROOF });

  await expect(page.getByText('No distance was tracked, so this trip cannot be claimed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit reimbursement' })).toBeDisabled();
});
