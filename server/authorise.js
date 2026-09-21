/**
 * One-time Google authorisation: `npm run sheet:auth`
 *
 * Opens a consent screen in the browser, catches the redirect on a temporary local
 * server, and stores the resulting refresh token. Run once; after that the server keeps
 * itself signed in.
 *
 * Re-run it to switch which account Songa acts as, or if the authorisation is revoked.
 */
import http from 'node:http';
import { exec } from 'node:child_process';
import { google } from 'googleapis';
import { hasCredentials, consentUrl, newClient, saveToken, tokenPath } from './oauthClient.js';
import { SHEET_ID } from './config.js';

const PORT = Number(process.env.SONGA_OAUTH_PORT || 5179);
const REDIRECT = `http://localhost:${PORT}`;

if (!hasCredentials()) {
  console.error(`
Missing OAuth client credentials.

  1. console.cloud.google.com > APIs & Services > Credentials
  2. Create Credentials > OAuth client ID > Application type: Desktop app
     (If asked to configure the consent screen first: User type "Internal",
      any app name, your own email for support and developer contact.)
  3. Put the client ID and secret in .env:

       SONGA_OAUTH_CLIENT_ID=...apps.googleusercontent.com
       SONGA_OAUTH_CLIENT_SECRET=GOCSPX-...

  4. Run this again.
`);
  process.exit(1);
}

const client = newClient(REDIRECT);
const url = consentUrl(client);

const server = http.createServer(async (req, res) => {
  const requested = new URL(req.url, REDIRECT);
  const code = requested.searchParams.get('code');
  const error = requested.searchParams.get('error');

  if (!code && !error) { res.writeHead(404).end(); return; }

  if (error) {
    respond(res, 'Authorisation was declined', `Google returned: ${error}`);
    console.error(`\nAuthorisation declined: ${error}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token. Revoke Songa at myaccount.google.com/permissions and run this again.');
    }
    client.setCredentials(tokens);

    // Confirm the token actually opens the sheet before declaring success, so a wrong
    // account or a missing API is caught here rather than at the first login attempt.
    const sheets = google.sheets({ version: 'v4', auth: client });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const email = await emailOf(client);

    const saved = await saveToken(tokens, email);
    respond(res, 'Songa is connected', `Authorised as ${email}. You can close this tab.`);
    console.log(`\n  OK    authorised as ${email}`);
    console.log(`  OK    opened "${meta.data.properties?.title}"`);
    console.log(`  OK    token saved to ${saved}`);
    console.log('\nNext: npm run sheet:check\n');
  } catch (caught) {
    respond(res, 'Something went wrong', caught.message);
    console.error(`\nFailed: ${caught.message}`);
    if (String(caught.message).match(/403|has not been used|disabled/i)) {
      console.error('Enable the Google Sheets API for this project in APIs & Services > Library.');
    }
    if (String(caught.message).match(/404|not found/i)) {
      console.error(`The account you signed in as cannot see spreadsheet ${SHEET_ID}. Sign in as someone who can.`);
    }
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('\nSonga authorisation');
  console.log(`  Sign in as someone who can already open the spreadsheet.\n`);
  console.log(`  If a browser does not open, paste this:\n\n  ${url}\n`);
  open(url);
});

function respond(res, title, detail) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px/1.6 system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#f5faf7;color:#123">
<div style="max-width:30rem;padding:2rem;background:#fff;border-radius:1rem;box-shadow:0 1rem 3rem rgba(27,71,50,.1)">
<h1 style="margin:0 0 .5rem;font-size:1.3rem">${title}</h1><p style="margin:0;color:#5d7084">${detail}</p></div>`);
}

async function emailOf(auth) {
  try {
    const { data } = await google.oauth2({ version: 'v2', auth }).userinfo.get();
    return data.email || '(unknown)';
  } catch {
    return '(unknown)';
  }
}

function open(target) {
  const command = process.platform === 'win32' ? `start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"`
      : `xdg-open "${target}"`;
  exec(command, () => {});
}
