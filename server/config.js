import 'dotenv/config';

export const PORT = Number(process.env.SONGA_API_PORT || 5175);

/**
 * Google Sign-In.
 *
 * A Web application OAuth client. The client ID is public by design — it ships to the
 * browser — and the token it produces is verified server side in auth.js.
 *
 * While it is unset, sign-in falls back to matching a typed email against the directory,
 * which is how the app works during the build phase and is not safe for anything real.
 */
export const GOOGLE_CLIENT_ID = process.env.SONGA_GOOGLE_CLIENT_ID || '';

// Only Workspace accounts in this domain may sign in. Verified server side against the
// token's hd claim, because anything the browser sends can be edited.
export const ALLOWED_DOMAIN = process.env.SONGA_ALLOWED_DOMAIN || 'oneacrefund.org';

// Addresses allowed in from outside that domain, comma separated. Still real Google
// accounts, still verified by Google — this only lifts the domain rule, which is what a
// test account needs. Keep the list short and remove it before anyone relies on Songa.
export const EXTRA_ALLOWED_EMAILS = (process.env.SONGA_EXTRA_ALLOWED_EMAILS || '')
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);

export const SESSION_SECRET = process.env.SONGA_SESSION_SECRET || 'songa-local-development-secret';
