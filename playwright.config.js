import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests: does the app lay out and work on the screens people actually use?
 *
 *   npm run test:e2e              every device
 *   npm run test:e2e -- --project=android
 *
 * It starts its own API and its own Vite on ports beside the development ones, against a
 * throwaway database that e2e/seed.js fills, so it never touches your data or your
 * running dev server. Screenshots of every screen on every device land in
 * test-results/screens/, for a person to look over.
 */

// Vite serves HTTPS when the phone-testing certificates exist (see vite.config.js), and
// plain HTTP otherwise, which is what CI has.
const https = existsSync('certs/dev-key.pem') && existsSync('certs/dev-cert.pem');
const WEB = `${https ? 'https' : 'http'}://localhost:5274`;
const API = 'http://localhost:5275';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/output',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // One database behind every device, and sign-in is rate limited per address, so a
  // modest number of workers keeps the run from tripping the lock it is not testing.
  workers: process.env.CI ? 2 : 4,
  reporter: [['list'], ['html', { outputFolder: 'test-results/report', open: 'never' }]],

  use: {
    baseURL: WEB,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // The devices that matter here, by who holds them.
  projects: [
    // Field officers: a low-cost Android phone, narrower than any iPhone.
    { name: 'android', use: { ...devices['Pixel 5'], viewport: { width: 360, height: 740 } } },
    // Safari behaves differently from Chrome in exactly the places this app leans on:
    // saved passwords, location permission, and the file picker.
    { name: 'iphone', use: { ...devices['iPhone 13'] } },
    // Managers and HR on a tablet, portrait.
    { name: 'tablet', use: { ...devices['iPad Mini'] } },
    { name: 'laptop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],

  webServer: [
    {
      command: 'node e2e/seed.js && node server/index.js',
      url: `${API}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        SONGA_DB_PATH: 'server/data/e2e.db',
        SONGA_DB_FORCE_SQLITE: 'true',
        SONGA_API_PORT: '5275',
        SONGA_DISABLE_SCHEDULER: 'true',
        SONGA_SESSION_SECRET: 'e2e-only-secret-not-used-anywhere-else',
        SONGA_GOOGLE_CLIENT_ID: '',
      },
    },
    {
      // The production build, served by Vite's preview server (which uses the same /api
      // proxy). It is the bundle that ships, and it has no live-reload socket to keep the
      // network busy while a test waits for the page to settle.
      command: 'npx vite build && npx vite preview --port 5274 --strictPort',
      url: `${WEB}/songa/`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { SONGA_API_PROXY_TARGET: API },
    },
  ],
});
