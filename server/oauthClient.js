import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_TOKEN_PATH, SHEET_SCOPES } from './config.js';

/**
 * OAuth as a named person rather than a service account.
 *
 * Songa reads the staff sheet using the Google identity of whoever ran `npm run
 * sheet:auth`. That person already has access to the sheet, so nothing is shared with
 * anyone new — which is what makes this work under a Workspace policy that forbids both
 * sharing with an external service account and deploying an anonymous Apps Script.
 *
 * The trade-off is worth stating plainly: every read and write is attributed to that
 * person in the sheet's revision history, and revoking their Google account breaks the
 * server. It is the right answer for a pilot, and should give way to a service account
 * once IT can allowlist one.
 */
const tokenFile = path.isAbsolute(OAUTH_TOKEN_PATH) ? OAUTH_TOKEN_PATH : path.join(process.cwd(), OAUTH_TOKEN_PATH);

export function hasCredentials() {
  return Boolean(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET);
}

export function newClient(redirectUri) {
  return new OAuth2Client({ clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET, redirectUri });
}

export function consentUrl(client) {
  return client.generateAuthUrl({
    access_type: 'offline',   // we need a refresh token, not just an hour of access
    prompt: 'consent',        // force one, even if this account authorised before
    // The email scope is only so the app can record and display *who* authorised it.
    // Without it the token works fine but every status line reads "(unknown)".
    scope: [...SHEET_SCOPES, 'openid', 'https://www.googleapis.com/auth/userinfo.email'],
  });
}

export async function saveToken(tokens, email) {
  await writeFile(tokenFile, JSON.stringify({ ...tokens, authorisedBy: email, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  return tokenFile;
}

export async function readToken() {
  try {
    return JSON.parse(await readFile(tokenFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * An authorised client, or null when this route is not set up. The library refreshes the
 * access token from the refresh token on its own, so this keeps working indefinitely
 * unless the authorisation is revoked.
 */
export async function authorisedClient() {
  if (!hasCredentials()) return null;
  const token = await readToken();
  if (!token?.refresh_token) return null;
  const client = newClient();
  client.setCredentials(token);
  return client;
}

export async function whoAuthorised() {
  return (await readToken())?.authorisedBy || '';
}

export const tokenPath = tokenFile;
