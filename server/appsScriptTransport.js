import { APPS_SCRIPT_SECRET, APPS_SCRIPT_URL, CLAIMS_TAB, USERS_TAB } from './config.js';

/**
 * Talks to the Apps Script web app bound to the spreadsheet (see appsScript/Code.gs).
 *
 * This exists because Workspace domain policy can forbid sharing a sheet with a service
 * account. The script runs as the sheet's own owner inside the organisation, so no
 * outside identity is ever granted access.
 *
 * It returns raw rows. Parsing them into users and claims stays in googleSheetsService, so
 * the column mapping has exactly one definition regardless of which transport is in use.
 */
const TIMEOUT_MS = Number(process.env.SONGA_APPS_SCRIPT_TIMEOUT_MS || 20_000);

export function isConfigured() {
  return Boolean(APPS_SCRIPT_URL && APPS_SCRIPT_SECRET);
}

async function callScript(action, payload = {}) {
  if (!isConfigured()) {
    throw Object.assign(new Error('Apps Script bridge is not configured. Set SONGA_APPS_SCRIPT_URL and SONGA_APPS_SCRIPT_SECRET.'), { status: 503 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      // Apps Script rejects a preflight on application/json; text/plain avoids it and the
      // script parses the body itself.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action, usersTab: USERS_TAB, claimsTab: CLAIMS_TAB, ...payload }),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? `The Apps Script bridge did not respond within ${TIMEOUT_MS}ms.`
      : `Could not reach the Apps Script bridge: ${error.message}`;
    throw Object.assign(new Error(message), { status: 503 });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // An HTML response means Google served a sign-in or error page rather than the script,
    // which nearly always means the deployment's access setting is too narrow.
    const hint = text.includes('<!DOCTYPE') || text.includes('<html')
      ? 'Google returned a sign-in page instead of the script. Redeploy the web app with "Who has access: Anyone with the link".'
      : `Unexpected response: ${text.slice(0, 200)}`;
    throw Object.assign(new Error(hint), { status: 503 });
  }

  if (body.error) throw Object.assign(new Error(`Apps Script: ${body.error}`), { status: 503 });
  return body;
}

export const appsScriptStore = {
  ping: () => callScript('ping'),
  readUserRows: async () => (await callScript('readUsers')).rows || [],
  readClaimRows: async () => (await callScript('readClaims')).rows || [],
  appendClaimRow: (row) => callScript('appendClaim', { row }),
  updateClaimRow: (id, row) => callScript('updateClaim', { id, row }),
};
