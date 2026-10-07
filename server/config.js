import 'dotenv/config';

export const PORT = Number(process.env.SONGA_API_PORT || 5175);

/**
 * Google Sign-In.
 *
 * A Web application OAuth client. The client ID is public by design — it ships to the
 * browser — and the token it produces is verified server side in auth.js.
 *
 * Optional. Sign-in is by email and password either way; when this is set, the sign-in
 * page also offers a Google button for anyone who would rather not keep a password.
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

const DEVELOPMENT_SECRET = 'songa-local-development-secret';
export const SESSION_SECRET = process.env.SONGA_SESSION_SECRET || DEVELOPMENT_SECRET;

/**
 * How many proxies sit between a real user and this process, for Express's `trust proxy`.
 *
 * It is what makes `req.ip` the user's address rather than the last proxy's, and the
 * sign-in rate limit is keyed on it. Too low and every user shares one address, so one
 * person's typos lock out the whole team; too high and a caller can forge the header.
 *
 *   1  local development: the Vite proxy.
 *   2  the cluster: the ingress, then the web pod's nginx.
 */
export const TRUST_PROXY_HOPS = Math.max(0, Number(process.env.SONGA_TRUST_PROXY_HOPS ?? 1) || 0);

/**
 * Settings that are optional on a laptop and dangerous to leave out in production.
 * Checked at startup, so a missing secret stops the pod rather than quietly weakening it.
 */
export function productionProblems() {
  if (process.env.NODE_ENV !== 'production') return [];
  const problems = [];
  const secret = process.env.SONGA_SESSION_SECRET || '';
  // The template's placeholder and the built-in fallback are both public — anybody who has
  // read this repository could sign a session for any address with them.
  if (!secret || secret === DEVELOPMENT_SECRET || secret === 'change-me') {
    problems.push('SONGA_SESSION_SECRET is not set. It signs every session, so it must be a long random value of its own.');
  } else if (secret.length < 32) {
    problems.push('SONGA_SESSION_SECRET is shorter than 32 characters. Use a long random value, e.g. `openssl rand -base64 48`.');
  }
  return problems;
}
