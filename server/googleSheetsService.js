import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { CLAIMS_TAB, CREDENTIALS_JSON, CREDENTIALS_PATH, SHEET_ID, SHEET_SCOPES, USERS_TAB } from './config.js';
import { appsScriptStore, isConfigured as appsScriptConfigured } from './appsScriptTransport.js';
import { authorisedClient, whoAuthorised } from './oauthClient.js';

/**
 * Raised when the sheet cannot be reached. Never swallowed into a default: roles, budgets
 * and manager assignments come from the sheet or they do not come at all. Serving assumed
 * permissions because a credential is missing is how someone ends up with an HR view.
 */
export class SheetUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SheetUnavailableError';
    this.status = 503;
  }
}

// Swapped out by the integration tests so they can exercise the API without real
// credentials. Test-only: nothing in the running app sets it.
let testStore = null;
export function setStoreForTests(store) { testStore = store; }

// Column letters from the staff sheet, as documented by the sheet owners. Kept as letters
// rather than bare indexes so a column move is a one-line change that still reads like the
// sheet it mirrors.
const COLUMNS = {
  name: 'B',
  email: 'C',
  zone: 'D',
  role: 'E',
  // F, not G: the original spec said G, but the sheet has "Region name" in F and
  // "Manager 1 name" in G, so G was being read as the region.
  region: 'F',
  manager1Name: 'G',
  manager1Email: 'H',
  manager2Name: 'I',
  manager2Email: 'J',
  transportMonth: 'K',
  transportPerCycle: 'L',
  extraAllowancePerCycle: 'M',
  maxPerCycle: 'N',
  // Not in the original schema. Optional: set to TRUE / OOO / OUT to divert Manager 1's
  // queue to Manager 2. Missing column simply means nobody is ever flagged out of office.
  manager1OutOfOffice: 'P',
};

const USERS_RANGE = `${USERS_TAB}!A2:P`;
const CLAIMS_RANGE = `${CLAIMS_TAB}!A2:S`;

export const CLAIM_HEADERS = ['Claim ID', 'Submitted At', 'Submitted By', 'Staff Name', 'Region', 'Zone', 'Trip Date', 'Purpose', 'Vehicle', 'Distance KM', 'Rate', 'System Estimate', 'Amount Claimed', 'Status', 'Assigned To', 'Decision Log', 'Route', 'Cycle', 'Approved By'];

const columnIndex = (letter) => letter.charCodeAt(0) - 'A'.charCodeAt(0);
const cell = (row, letter) => (row[columnIndex(letter)] ?? '').toString().trim();

// Sheet money cells arrive as "KES 4,500", "4,500.00" or a bare number depending on who
// typed them, so strip everything that is not part of a number before parsing.
function money(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function truthy(value) {
  return ['true', 'yes', 'y', '1', 'ooo', 'out', 'out of office'].includes(String(value ?? '').trim().toLowerCase());
}

// Sheet role strings are free text ("Field Officer", "Manager - Rift Valley", "HR").
// Normalise them to the four roles the app actually branches on.
export function normaliseRole(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('admin')) return 'admin';
  if (value.includes('hr') || value.includes('people')) return 'hr';
  if (value.includes('manager') || value.includes('lead') || value.includes('supervisor')) return 'manager';
  return 'field_agent';
}

function toUser(row) {
  const email = cell(row, COLUMNS.email).toLowerCase();
  // Must look like an address, not merely be non-empty: if the header row shifts, column C
  // reads "Email address", and a row like that must not become a signed-in user.
  if (!email.includes('@')) return null;
  return {
    name: cell(row, COLUMNS.name),
    email,
    zone: cell(row, COLUMNS.zone),
    roleLabel: cell(row, COLUMNS.role),
    role: normaliseRole(cell(row, COLUMNS.role)),
    region: cell(row, COLUMNS.region),
    manager1Name: cell(row, COLUMNS.manager1Name),
    manager1Email: cell(row, COLUMNS.manager1Email).toLowerCase(),
    manager2Name: cell(row, COLUMNS.manager2Name),
    manager2Email: cell(row, COLUMNS.manager2Email).toLowerCase(),
    transportMonth: money(cell(row, COLUMNS.transportMonth)),
    transportPerCycle: money(cell(row, COLUMNS.transportPerCycle)),
    extraAllowancePerCycle: money(cell(row, COLUMNS.extraAllowancePerCycle)),
    maxPerCycle: money(cell(row, COLUMNS.maxPerCycle)),
    manager1OutOfOffice: truthy(cell(row, COLUMNS.manager1OutOfOffice)),
  };
}

function toClaim(row) {
  const [id, submittedAt, submittedBy, staffName, region, zone, tripDate, purpose, vehicle, km, rate, estimate, amount, status, assignedTo, log, route, cycleKey, approvalSource] = row;
  if (!id) return null;
  return {
    id,
    submittedAt,
    submittedBy: (submittedBy || '').toLowerCase(),
    staffName,
    region,
    zone,
    tripDate,
    purpose,
    vehicle,
    km: money(km),
    rate: money(rate),
    estimate: money(estimate),
    amount: money(amount),
    status,
    assignedTo: (assignedTo || '').toLowerCase(),
    decisionLog: safeLog(log),
    route: route || '',
    cycleKey: cycleKey || '',
    approvalSource: approvalSource || '',
  };
}

// A hand-edited decision cell should not take down the whole queue.
function safeLog(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return [{ actor: 'unknown', action: 'unparsed', note: String(raw), at: '' }]; }
}

function claimToRow(claim) {
  return [claim.id, claim.submittedAt, claim.submittedBy, claim.staffName, claim.region, claim.zone, claim.tripDate, claim.purpose, claim.vehicle, claim.km, claim.rate, claim.estimate, claim.amount, claim.status, claim.assignedTo, JSON.stringify(claim.decisionLog || []), claim.route || '', claim.cycleKey || '', claim.approvalSource || ''];
}

async function loadCredentials() {
  if (CREDENTIALS_JSON) return JSON.parse(CREDENTIALS_JSON);
  if (CREDENTIALS_PATH) return JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'));
  return null;
}

let clientPromise = null;

// Resolves to a Sheets client, or null when no credentials are configured. Null is a
// supported state, not an error: it puts the server in fixture mode so the app can be
// developed and demoed without access to the real staff sheet.
async function sheetsClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      // A person's own authorisation takes precedence: where domain policy blocks service
      // accounts, this is the only Sheets API route available.
      const asUser = await authorisedClient();
      if (asUser) return google.sheets({ version: 'v4', auth: asUser });

      const credentials = await loadCredentials();
      if (!credentials) return null;
      const auth = new GoogleAuth({ credentials, scopes: SHEET_SCOPES });
      return google.sheets({ version: 'v4', auth: await auth.getClient() });
    })().catch((error) => {
      console.error('[sheets] could not authenticate:', error.message);
      return null;
    });
  }
  return clientPromise;
}

/** Which transport is in play, for status displays and the diagnostic. */
export async function backend() {
  if (testStore) return 'test';
  if (await authorisedClient()) return `sheets-api as ${await whoAuthorised()}`;
  if (appsScriptConfigured()) return 'apps-script';
  return (await sheetsClient()) ? 'sheets-api (service account)' : null;
}

export async function isLive() {
  return Boolean(await backend());
}

const NOT_CONFIGURED = 'The Google Sheet is not connected. Run "npm run sheet:auth" to authorise Songa with a Google account that can already open the sheet. Songa reads every role, budget and manager assignment from the sheet, so it cannot run without it.';

// The Apps Script bridge is only used when nobody has authorised via OAuth; a person's own
// Google identity is the better route where it is available.
async function useAppsScript() {
  if (!appsScriptConfigured()) return false;
  return !(await authorisedClient());
}

async function requireSheets() {
  const sheets = await sheetsClient();
  if (!sheets) throw new SheetUnavailableError(NOT_CONFIGURED);
  return sheets;
}

export async function readUsers() {
  if (testStore) return testStore.readUsers();
  if (await useAppsScript()) return (await appsScriptStore.readUserRows()).map(toUser).filter(Boolean);
  const sheets = await requireSheets();
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: USERS_RANGE });
  return (data.values || []).map(toUser).filter(Boolean);
}

export async function readClaims() {
  if (testStore) return testStore.readClaims();
  if (await useAppsScript()) return (await appsScriptStore.readClaimRows()).map(toClaim).filter(Boolean);
  const sheets = await requireSheets();
  try {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: CLAIMS_RANGE });
    return (data.values || []).map(toClaim).filter(Boolean);
  } catch (error) {
    // A missing Claims tab is the expected state on a fresh sheet, not a failure.
    if (error.code === 400) return [];
    throw error;
  }
}

export async function appendClaim(claim) {
  if (testStore) return testStore.appendClaim(claim);
  if (await useAppsScript()) { await appsScriptStore.appendClaimRow(claimToRow(claim)); return claim; }
  const sheets = await requireSheets();
  await ensureClaimsTab(sheets);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CLAIMS_TAB}!A:S`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [claimToRow(claim)] },
  });
  return claim;
}

// Sheets has no update-by-key, so find the claim's row and overwrite it. Rows are read
// fresh each time because another reviewer may have appended since this process started.
export async function updateClaim(id, mutate) {
  if (testStore) return testStore.updateClaim(id, mutate);
  if (await useAppsScript()) {
    // Read-modify-write: the script locates the row by claim id and overwrites it, so the
    // row number never has to travel back and forth.
    const current = (await appsScriptStore.readClaimRows()).map(toClaim).find((claim) => claim?.id === id);
    if (!current) return null;
    const updated = mutate(current);
    await appsScriptStore.updateClaimRow(id, claimToRow(updated));
    return updated;
  }
  const sheets = await requireSheets();
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: CLAIMS_RANGE });
  const rows = data.values || [];
  const index = rows.findIndex((row) => row[0] === id);
  if (index === -1) return null;
  const updated = mutate(toClaim(rows[index]));
  const rowNumber = index + 2; // +1 for the header row, +1 because sheets rows are 1-based.
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${CLAIMS_TAB}!A${rowNumber}:S${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [claimToRow(updated)] },
  });
  return updated;
}

async function ensureClaimsTab(sheets) {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  if (data.sheets?.some((tab) => tab.properties?.title === CLAIMS_TAB)) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: CLAIMS_TAB } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${CLAIMS_TAB}!A1:S1`,
    valueInputOption: 'RAW',
    requestBody: { values: [CLAIM_HEADERS] },
  });
}
