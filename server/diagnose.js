/**
 * Sheet connection diagnostic.
 *
 *   npm run sheet:check                      -- is the sheet reachable and readable?
 *   npm run sheet:check -- you@oneacrefund.org  -- and can this person sign in?
 *
 * Exists because "why can't I sign in" has several possible causes — no credentials, the
 * sheet not shared, a differently named tab, a shifted header row, a typo in an email —
 * and guessing between them from a login error is slow.
 */
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { readFile } from 'node:fs/promises';
import { APPS_SCRIPT_URL, CLAIMS_TAB, CREDENTIALS_JSON, CREDENTIALS_PATH, SHEET_ID, SHEET_SCOPES, USERS_TAB } from './config.js';
import { normaliseRole } from './googleSheetsService.js';
import { appsScriptStore, isConfigured as appsScriptConfigured } from './appsScriptTransport.js';
import { authorisedClient, hasCredentials as hasOauthCredentials, whoAuthorised } from './oauthClient.js';

const ok = (message) => console.log(`  OK    ${message}`);
const bad = (message) => console.log(`  FAIL  ${message}`);
const info = (message) => console.log(`        ${message}`);

async function main() {
  const wanted = (process.argv[2] || '').trim().toLowerCase();
  console.log(`\nSonga sheet check\n  spreadsheet ${SHEET_ID}\n`);

  // OAuth first: it is the route that works under this organisation's policy.
  const asUser = await authorisedClient();
  if (asUser) {
    console.log('1. Authorisation');
    ok(`signed in as ${await whoAuthorised()} (npm run sheet:auth to change)`);
    return checkWithClient(google.sheets({ version: 'v4', auth: asUser }), wanted);
  }
  if (hasOauthCredentials()) {
    console.log('1. Authorisation');
    bad('OAuth client is configured but nobody has authorised yet');
    info('Run: npm run sheet:auth');
    return undefined;
  }
  if (appsScriptConfigured()) return checkAppsScript(wanted);

  // 1. Credentials
  console.log('1. Service account credentials');
  let credentials = null;
  try {
    if (CREDENTIALS_JSON) {
      credentials = JSON.parse(CREDENTIALS_JSON);
      ok('loaded from SONGA_SERVICE_ACCOUNT_JSON');
    } else if (CREDENTIALS_PATH) {
      credentials = JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'));
      ok(`loaded from ${CREDENTIALS_PATH}`);
    } else {
      bad('nothing is configured');
      info('Authorise as yourself — the route that works under One Acre Fund policy:');
      info('  1. console.cloud.google.com > APIs & Services > Credentials');
      info('     > Create Credentials > OAuth client ID > Desktop app');
      info('  2. Put the client ID and secret in .env as SONGA_OAUTH_CLIENT_ID / _SECRET');
      info('  3. npm run sheet:auth');
      return;
    }
    info(`service account: ${credentials.client_email}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      bad(`no file at ${CREDENTIALS_PATH}`);
      info('GOOGLE_APPLICATION_CREDENTIALS points somewhere that does not exist.');
      info('Check the path in .env, and use forward slashes: C:/secrets/key.json');
    } else if (error instanceof SyntaxError) {
      bad(`${CREDENTIALS_PATH} is not valid JSON`);
      info('Download the key again — choose JSON, not P12.');
    } else {
      bad(`could not be read: ${error.message}`);
    }
    return;
  }

  const auth = new GoogleAuth({ credentials, scopes: SHEET_SCOPES });
  return checkWithClient(google.sheets({ version: 'v4', auth: await auth.getClient() }), wanted, credentials.client_email);
}

/** The Sheets API path, shared by the OAuth and service account transports. */
async function checkWithClient(sheets, wanted, serviceAccountEmail) {
  // 2. Reaching the spreadsheet
  console.log('\n2. Opening the spreadsheet');
  let meta;
  try {
    meta = (await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })).data;
    ok(`opened "${meta.properties?.title}"`);
  } catch (error) {
    bad(error.message);
    if (String(error.message).match(/permission|403|not found|404/i)) {
      if (serviceAccountEmail) {
        info(`Share the spreadsheet with ${serviceAccountEmail} as an Editor.`);
        info('A service account cannot see a sheet just because you can — it needs its own access.');
      } else {
        info('The authorised account cannot open this spreadsheet.');
        info('Run "npm run sheet:auth" again and sign in as someone who can.');
      }
    }
    if (String(error.message).match(/has not been used|disabled/i)) {
      info('Enable the Google Sheets API in APIs & Services > Library for this project.');
    }
    return;
  }

  // 3. Tabs
  console.log('\n3. Tabs');
  const tabs = (meta.sheets || []).map((tab) => tab.properties?.title);
  info(`found: ${tabs.map((tab) => `"${tab}"`).join(', ')}`);
  if (tabs.includes(USERS_TAB)) {
    ok(`users tab "${USERS_TAB}" exists`);
  } else {
    bad(`no tab named "${USERS_TAB}" — this is what SONGA_USERS_TAB is set to`);
    info(`Set SONGA_USERS_TAB in .env to one of the tabs above, exactly as spelled.`);
    return;
  }
  console.log(tabs.includes(CLAIMS_TAB) ? `  OK    claims tab "${CLAIMS_TAB}" exists` : `        claims tab "${CLAIMS_TAB}" will be created on the first claim`);

  // 4. Reading rows
  console.log('\n4. Reading the users tab');
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${USERS_TAB}!A1:P` });
  const rows = data.values || [];
  if (!rows.length) {
    bad('the tab is empty');
    return;
  }
  ok(`${rows.length} rows including the header`);

  // Column C is the email column. Find where real addresses actually start, so a blank or
  // shifted header row shows up as a clear message instead of "user not found".
  const emailCol = 2;
  const firstDataRow = rows.findIndex((row) => String(row[emailCol] || '').includes('@'));
  if (firstDataRow === -1) {
    bad('no cell in column C contains an email address');
    info(`column C of row 1 reads: "${rows[0]?.[emailCol] ?? ''}"`);
    info('Check that Email address really is column C on this tab.');
    return;
  }
  if (firstDataRow === 1) {
    ok('header in row 1, data from row 2 — matches what the app reads');
  } else {
    bad(`data starts at row ${firstDataRow + 1}, but the app reads from row 2`);
    info(`Rows 2 to ${firstDataRow} will be skipped as unparseable, which is harmless but worth knowing.`);
  }

  reportPeople(rows.slice(1), wanted);
}

/** The Apps Script path: the bridge answers for the sheet, so probe it instead. */
async function checkAppsScript(wanted) {
  console.log('1. Apps Script bridge');
  ok(`URL configured: ${APPS_SCRIPT_URL.slice(0, 60)}...`);

  let pong;
  try {
    pong = await appsScriptStore.ping();
    ok(`reached the script — spreadsheet "${pong.title}"`);
  } catch (error) {
    bad(error.message);
    if (error.message.includes('sign-in page')) {
      info('Deploy > Manage deployments > edit > Who has access: Anyone with the link.');
    } else if (error.message.includes('Unauthorised')) {
      info('SONGA_APPS_SCRIPT_SECRET does not match the SONGA_SECRET script property.');
      info('Apps Script > Project Settings > Script properties.');
    } else {
      info('Check that the URL ends in /exec (not /dev) and that the deployment is active.');
    }
    return;
  }

  console.log('\n2. Tabs');
  info(`found: ${(pong.tabs || []).map((tab) => `"${tab}"`).join(', ')}`);
  if ((pong.tabs || []).includes(USERS_TAB)) {
    ok(`users tab "${USERS_TAB}" exists`);
  } else {
    bad(`no tab named "${USERS_TAB}" — set SONGA_USERS_TAB in .env to one of the above`);
    return;
  }

  console.log('\n3. Reading the users tab');
  const rows = await appsScriptStore.readUserRows();
  ok(`${rows.length} data rows below the header`);
  reportPeople(rows, wanted);
}

/** Shared between both transports: what the rows actually parse into. */
function reportPeople(rows, wanted) {
  const people = rows
    .filter((row) => String(row[2] || '').includes('@'))
    .map((row) => ({
      name: (row[1] || '').trim(),
      email: (row[2] || '').trim().toLowerCase(),
      roleLabel: (row[4] || '').trim(),
      role: normaliseRole(row[4]),
      region: (row[5] || '').trim(), // F — see COLUMNS in googleSheetsService.js
      manager1: (row[7] || '').trim(),
      perCycle: (row[11] || '').trim(),
      max: (row[13] || '').trim(),
    }));

  console.log('\n4. Parsed staff');
  if (!people.length) {
    bad('no row has an email address in column C');
    info(`column C of the first row reads: "${rows[0]?.[2] ?? ''}"`);
    return;
  }
  ok(`${people.length} rows with an email address`);
  const roles = people.reduce((counts, person) => ({ ...counts, [person.role]: (counts[person.role] || 0) + 1 }), {});
  info(`roles: ${JSON.stringify(roles)}`);
  if (!roles.hr && !roles.admin) {
    bad('nobody parses as HR or admin — the HR dashboard will be unreachable');
    info('Column E needs "HR" or "admin" in it for at least one person.');
    info(`column E currently reads, for the first few: ${people.slice(0, 4).map((person) => `"${person.roleLabel}"`).join(', ')}`);
  }
  const noBudget = people.filter((person) => !person.perCycle);
  if (noBudget.length) info(`${noBudget.length} rows have no "Transport per cycle" (column L) — those claims can never auto-approve`);

  // Approvers are named in the manager columns and usually have no column C row of their
  // own. They can still sign in: Songa builds an account for them from these columns.
  const claimants = new Set(people.map((person) => person.email));
  const approvers = new Map();
  for (const row of rows) {
    for (const [nameIdx, emailIdx] of [[6, 7], [8, 9]]) {
      const email = String(row[emailIdx] || '').trim().toLowerCase();
      if (!email.includes('@')) continue;
      if (!approvers.has(email)) approvers.set(email, String(row[nameIdx] || '').trim() || email.split('@')[0]);
    }
  }
  if (approvers.size) {
    console.log('');
    console.log('   Approvers (from the Manager 1 and Manager 2 columns)');
    ok(`${approvers.size} can sign in and approve`);
    for (const [email, name] of approvers) {
      info(`${name.padEnd(18)} ${email}${claimants.has(email) ? '  (also a claimant)' : ''}`);
    }
  }

  if (!wanted) {
    console.log('\nPass an email to check one person: npm run sheet:check -- you@oneacrefund.org\n');
    return;
  }
  console.log(`\n5. Looking up ${wanted}`);
  const found = people.find((person) => person.email === wanted);
  if (found) {
    ok('found — this email can sign in');
    info(`name    ${found.name}`);
    info(`role    ${found.role} (column E reads "${found.roleLabel}")`);
    info(`region  ${found.region || '(blank)'}`);
    info(`manager ${found.manager1 || '(blank — claims above the allowance go to HR)'}`);
    info(`budget  per cycle ${found.perCycle || '(blank)'}, max ${found.max || '(blank)'}`);
  } else {
    bad('not found in column C');
    const stem = wanted.split('@')[0].slice(0, 4);
    for (const person of people.filter((item) => item.email.startsWith(stem))) info(`  close: "${person.email}"`);
  }
  console.log('');
}

main().catch((error) => {
  console.error('\nDiagnostic failed:', error.message);
  process.exitCode = 1;
});
