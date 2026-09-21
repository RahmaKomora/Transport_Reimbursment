/**
 * Songa sheet bridge — Google Apps Script.
 *
 * Paste this into the spreadsheet's own script project (Extensions > Apps Script) and
 * deploy it as a Web app. It runs as you, inside your own Workspace account, so the sheet
 * is never shared with an outside identity — which is what makes it work where a service
 * account is blocked by domain policy.
 *
 * It is deliberately dumb: it reads and writes raw rows and knows nothing about roles,
 * budgets or approval rules. All of that stays in the Node server, so there is one copy of
 * the column mapping and business logic, not two that can drift apart.
 *
 * SETUP
 *   1. Extensions > Apps Script, delete the placeholder, paste this file, Save.
 *   2. Project Settings > Script properties > Add script property:
 *        SONGA_SECRET = <a long random string>
 *      Put the same value in your .env as SONGA_APPS_SCRIPT_SECRET.
 *   3. Deploy > New deployment > type Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone with the link   (or "Anyone within One Acre Fund")
 *      Copy the /exec URL into .env as SONGA_APPS_SCRIPT_URL.
 *   4. Authorise when prompted. The warning screen is expected for an unverified script
 *      you wrote yourself: Advanced > Go to project.
 *
 * Every request must carry the shared secret. "Anyone with the link" means the URL is
 * reachable by anyone who has it, so the secret is what actually protects the sheet.
 * Treat both the URL and the secret as credentials.
 */

var USERS_TAB = 'Users';
var CLAIMS_TAB = 'Claims';
var CLAIM_HEADERS = ['Claim ID', 'Submitted At', 'Submitted By', 'Staff Name', 'Region', 'Zone', 'Trip Date', 'Purpose', 'Vehicle', 'Distance KM', 'Rate', 'System Estimate', 'Amount Claimed', 'Status', 'Assigned To', 'Decision Log', 'Route', 'Cycle', 'Approved By'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!secretOk(body.secret)) return json({ error: 'Unauthorised' });

    switch (body.action) {
      case 'ping':        return json({ ok: true, title: book().getName(), tabs: tabNames() });
      case 'readUsers':   return json({ rows: rowsOf(body.usersTab || USERS_TAB) });
      case 'readClaims':  return json({ rows: rowsOf(body.claimsTab || CLAIMS_TAB, true) });
      case 'appendClaim': return json(appendClaim(body));
      case 'updateClaim': return json(updateClaim(body));
      default:            return json({ error: 'Unknown action: ' + body.action });
    }
  } catch (error) {
    return json({ error: String(error) });
  }
}

// A GET is only ever a liveness check; everything that touches data goes through POST.
function doGet() {
  return json({ ok: true, service: 'songa-sheet-bridge' });
}

function secretOk(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('SONGA_SECRET');
  if (!expected) return false;
  if (!given || given.length !== expected.length) return false;
  // Constant-time-ish compare: always walk the whole string.
  var diff = 0;
  for (var i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function book() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function tabNames() {
  return book().getSheets().map(function (sheet) { return sheet.getName(); });
}

/** Raw values below the header row. Returns [] for a tab that does not exist yet. */
function rowsOf(name, createIfMissing) {
  var sheet = book().getSheetByName(name);
  if (!sheet) {
    if (!createIfMissing) throw new Error('No tab named "' + name + '". Tabs: ' + tabNames().join(', '));
    return [];
  }
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getDisplayValues();
}

function claimsSheet() {
  var sheet = book().getSheetByName(CLAIMS_TAB);
  if (!sheet) {
    sheet = book().insertSheet(CLAIMS_TAB);
    sheet.appendRow(CLAIM_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendClaim(body) {
  var sheet = claimsSheet();
  // Two people submitting at once would otherwise race for the same row.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet.appendRow(body.row);
    return { ok: true, row: sheet.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

function updateClaim(body) {
  var sheet = claimsSheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ids = sheet.getRange(2, 1, Math.max(0, sheet.getLastRow() - 1), 1).getDisplayValues();
    for (var i = 0; i < ids.length; i += 1) {
      if (ids[i][0] === body.id) {
        sheet.getRange(i + 2, 1, 1, body.row.length).setValues([body.row]);
        return { ok: true, row: i + 2 };
      }
    }
    return { ok: false, error: 'No claim with id ' + body.id };
  } finally {
    lock.releaseLock();
  }
}

function json(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
