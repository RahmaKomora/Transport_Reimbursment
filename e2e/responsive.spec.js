import { expect, test } from '@playwright/test';
import { PASSWORD, PEOPLE } from './people.js';

/**
 * Every screen, on every device in playwright.config.js.
 *
 * Three things are checked, because they are the three ways a layout fails on a phone:
 *
 *   overflow   the page itself scrolls sideways. Tables may scroll inside their own box;
 *              the page may not, or every screen wobbles under a thumb.
 *   targets    a control is too small to hit. 44px is the size Apple and Google both give.
 *   reach      the thing you came to the screen for is on it and visible, not pushed off
 *              the edge or under something else.
 *
 * Each also saves a full-page screenshot, because "it passes" is not the same as "it looks
 * right", and a person looking over the set is the check for the second.
 */

const PHONE_WIDTH = 900; // at or below this the side panel becomes the menu (see styles.css)
const MIN_TARGET = 44;

const isNarrow = (page) => page.viewportSize().width <= PHONE_WIDTH;

/** Signs in through the API and hands the browser the session, skipping the form. */
async function signInAs(page, who) {
  const response = await page.request.post('/api/auth/login', { data: { email: PEOPLE[who].email, password: PASSWORD } });
  expect(response.ok(), `sign-in as ${who}`).toBeTruthy();
  const { token } = await response.json();
  await page.addInitScript((value) => { window.localStorage.setItem('songa.session', value); }, token);
  await page.goto('/songa/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.app-shell')).toBeVisible();
}

/** Goes to a view the way a person would: through the menu on a phone, the side panel otherwise. */
async function open(page, view) {
  if (isNarrow(page)) {
    await page.getByRole('button', { name: 'Open menu' }).click();
  }
  const link = page.locator(`.side-panel [data-view="${view}"]`);
  if (!(await link.isVisible())) await page.locator('.side-panel .admin-toggle').click();
  await link.click();
  if (isNarrow(page)) await expect(page.locator('.side-panel')).not.toHaveClass(/open/);
}

async function noSidewaysScroll(page, screen) {
  const { scrollWidth, innerWidth, culprits } = await page.evaluate(() => {
    const width = window.innerWidth;
    // Name the widest offenders, so a failure says what to fix rather than only that
    // something is too wide. Anything inside a scrolling box is allowed to be wide.
    const scrolls = (element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|hidden)/.test(style.overflowX) && node !== document.body && node !== document.documentElement) return true;
      }
      return false;
    };
    const wide = [...document.querySelectorAll('body *')]
      .filter((element) => element.getBoundingClientRect().right > width + 1 && !scrolls(element))
      .map((element) => `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).join('.')}` : ''} (${Math.round(element.getBoundingClientRect().right)}px)`);
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: width, culprits: [...new Set(wide)].slice(0, 6) };
  });
  expect(scrollWidth, `${screen}: page is ${scrollWidth}px wide on a ${innerWidth}px screen. Widest: ${culprits.join(', ')}`).toBeLessThanOrEqual(innerWidth + 1);
}

async function tapTargets(page, screen) {
  if (!isNarrow(page) && page.viewportSize().width > 1024) return; // a mouse, not a thumb
  const small = await page.evaluate((min) => {
    const controls = document.querySelectorAll('button, a[href], select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea');
    return [...controls]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height) return false; // not on screen
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || element.closest('[aria-hidden="true"]')) return false;
        // The map's credit line is a legal notice, not a control anybody needs to hit.
        if (element.closest('.leaflet-control-attribution')) return false;
        return box.height < min - 0.5;
      })
      .map((element) => `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') || element.textContent || element.name || '').trim().slice(0, 30)}" ${Math.round(element.getBoundingClientRect().height)}px`);
  }, MIN_TARGET);
  expect(small, `${screen}: controls shorter than ${MIN_TARGET}px are hard to tap`).toEqual([]);
}

/**
 * Tables squeezed instead of scrolled. A table that cannot fit should scroll inside its
 * box; one that shrinks instead breaks every word a letter per line, which is unreadable
 * and still passes the overflow check above.
 */
async function readableTables(page, screen) {
  const squeezed = await page.evaluate(() => [...document.querySelectorAll('table td, table th')]
    .filter((cell) => cell.textContent.trim().length > 3 && cell.getBoundingClientRect().width > 0 && cell.getBoundingClientRect().width < 56)
    .map((cell) => `"${cell.textContent.trim().slice(0, 20)}" ${Math.round(cell.getBoundingClientRect().width)}px`)
    .slice(0, 6));
  expect(squeezed, `${screen}: table cells too narrow to read — the table should scroll, not shrink`).toEqual([]);
}

async function check(page, testInfo, screen) {
  // Settled: data loaded (no "Loading..." placeholders left) and web fonts in, since a
  // font swap changes line heights and so the sizes being measured.
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  // Bounded: a web font that never arrives on a bad connection must not hang the run.
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]));
  await noSidewaysScroll(page, screen);
  await tapTargets(page, screen);
  await readableTables(page, screen);
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/${screen}.png`, fullPage: true });
}

test.describe('signed out', () => {
  test('sign in', async ({ page }, testInfo) => {
    await page.goto('/songa/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeInViewport();
    await check(page, testInfo, '01-sign-in');
  });

  test('set a password with a setup code', async ({ page }, testInfo) => {
    await page.goto('/songa/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Use a setup code/ }).click();
    await expect(page.getByLabel('Setup code')).toBeVisible();
    await expect(page.getByLabel('Confirm password')).toBeVisible();
    await check(page, testInfo, '02-setup-code');
  });

  test('signing in through the form reaches the app', async ({ page }) => {
    await page.goto('/songa/', { waitUntil: 'domcontentloaded' });
    await page.locator('#login-email').fill(PEOPLE.agent.email);
    await page.locator('#login-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.app-shell')).toBeVisible();
  });
});

test.describe('field officer', () => {
  test.beforeEach(async ({ page }) => signInAs(page, 'agent'));

  test('overview', async ({ page }, testInfo) => {
    await expect(page.getByRole('button', { name: 'Log new field trip' })).toBeVisible();
    await check(page, testInfo, '10-agent-overview');
  });

  test('log a trip', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: 'Log new field trip' }).click();
    await expect(page.getByRole('heading', { name: 'Log a field trip' })).toBeVisible();
    await check(page, testInfo, '11-agent-log-trip');
  });

  test('my trips', async ({ page }, testInfo) => {
    await open(page, 'trips');
    await check(page, testInfo, '12-agent-trips');
  });

  test('the menu reaches sign out', async ({ page }) => {
    // On a phone the side panel is hidden behind the menu. Everything in it, including
    // signing out, has to be reachable from there.
    if (isNarrow(page)) await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('.side-panel .side-user').click();
    await page.getByRole('button', { name: /Sign Out/ }).click();
    await expect(page.locator('#login-email')).toBeVisible();
  });
});

test.describe('manager', () => {
  test.beforeEach(async ({ page }) => signInAs(page, 'manager'));

  test('dashboard', async ({ page }, testInfo) => {
    await open(page, 'review');
    await check(page, testInfo, '20-manager-dashboard');
  });

  test("team's claims", async ({ page }, testInfo) => {
    await open(page, 'team');
    await check(page, testInfo, '21-manager-team-claims');
  });

  test('team budgets', async ({ page }, testInfo) => {
    await open(page, 'budgets');
    await check(page, testInfo, '22-manager-budgets');
  });

  test('a definition opens on tap and stays on screen', async ({ page }) => {
    // Definitions live behind an ⓘ rather than in paragraphs under the table. On a phone
    // there is no hover, so a tap has to open it, and it must not run off the screen edge.
    await open(page, 'budgets');
    await page.getByRole('button', { name: 'What is unspent?' }).click();
    const pop = page.getByRole('tooltip');
    await expect(pop).toContainText('Pending claims count as spent');
    const box = await pop.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
    await page.locator('h1').click();
    await expect(pop).toHaveCount(0);
  });
});

test.describe('HR and admin', () => {
  test.beforeEach(async ({ page }) => signInAs(page, 'admin'));

  test('HR overview', async ({ page }, testInfo) => {
    await open(page, 'hr-overview');
    await check(page, testInfo, '30-hr-overview');
  });

  test('reimbursements', async ({ page }, testInfo) => {
    await open(page, 'hr');
    await check(page, testInfo, '31-hr-reimbursements');
  });

  test('regional budgets', async ({ page }, testInfo) => {
    await open(page, 'admin-regions');
    await check(page, testInfo, '32-admin-regions');
  });

  test('transport rates', async ({ page }, testInfo) => {
    await open(page, 'admin-rates');
    await check(page, testInfo, '33-admin-rates');
  });

  test('user roles', async ({ page }, testInfo) => {
    await open(page, 'admin-users');
    await check(page, testInfo, '34-admin-users');
  });

  test('an attention chip shows exactly those people', async ({ page }) => {
    // The manager in the seed has no approver of their own, so the chip names one person.
    await open(page, 'admin-users');
    await page.getByRole('button', { name: /1 without an approver/ }).click();
    await expect(page.locator('.person-row')).toHaveCount(1);
    await expect(page.locator('.person-row')).toContainText(PEOPLE.manager.name);
    await page.getByRole('button', { name: /1 without an approver/ }).click();
    await expect(page.locator('.person-row')).toHaveCount(Object.keys(PEOPLE).length);
  });

  // A test of its own rather than a second check in the one above: a full-page screenshot
  // drops Chromium's touch emulation for the rest of the page's life, so anything measured
  // after one is measured as if on a desktop.
  test('a person, with the sign-in section', async ({ page }, testInfo) => {
    await open(page, 'admin-users');
    await page.getByRole('button', { name: `Open ${PEOPLE.agent.name}` }).click();
    await expect(page.getByRole('heading', { name: 'Sign-in' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reset password|Issue setup code/ })).toBeVisible();
    await check(page, testInfo, '35-admin-person');
  });
});
