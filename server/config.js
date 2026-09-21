import 'dotenv/config';

// The spreadsheet that holds staff profiles, regions, managers and budget ceilings.
export const SHEET_ID = process.env.SONGA_SHEET_ID || '1hcLnhUcH7kLUCCeC5Lai4D9VnNnnhBd_7v3W3Y7gOBs';

// Tab names are configurable because the claims tab is created by this app, not by the
// people who own the staff sheet.
export const USERS_TAB = process.env.SONGA_USERS_TAB || 'Users';
export const CLAIMS_TAB = process.env.SONGA_CLAIMS_TAB || 'Claims';

export const PORT = Number(process.env.SONGA_API_PORT || 5175);

// OAuth as a real person. The server acts as whoever authorised it, so the sheet needs no
// sharing at all — they already have access. This is the route that works when domain
// policy blocks both service-account sharing and anonymous Apps Script deployments.
export const OAUTH_CLIENT_ID = process.env.SONGA_OAUTH_CLIENT_ID || '';
export const OAUTH_CLIENT_SECRET = process.env.SONGA_OAUTH_CLIENT_SECRET || '';
export const OAUTH_TOKEN_PATH = process.env.SONGA_OAUTH_TOKEN_PATH || '.songa-token.json';

// The Apps Script bridge: the script runs inside the spreadsheet, so nothing is shared
// outward. Needs a deployment reachable without a Google session.
export const APPS_SCRIPT_URL = process.env.SONGA_APPS_SCRIPT_URL || '';
export const APPS_SCRIPT_SECRET = process.env.SONGA_APPS_SCRIPT_SECRET || '';

// Service account credentials, supplied either as a path to a key file or as the raw JSON
// blob (handy for a single-line .env).
export const CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SONGA_CREDENTIALS_PATH || '';
export const CREDENTIALS_JSON = process.env.SONGA_SERVICE_ACCOUNT_JSON || '';

// Writing claims needs the read/write scope; drop to readonly if you only ever read.
export const SHEET_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export const SESSION_SECRET = process.env.SONGA_SESSION_SECRET || 'songa-local-development-secret';
