import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { ALLOWED_DOMAIN, EXTRA_ALLOWED_EMAILS, SESSION_SECRET } from './config.js';

// Read when needed, not at import: the value lives in the environment and the tests set it.
const googleClientId = () => process.env.SONGA_GOOGLE_CLIENT_ID || '';
import { findUserByEmail, getUsers } from './directory.js';

export { findUserByEmail };
export const allUsers = getUsers;

/**
 * Local development authentication.
 *
 * There is no password store and no identity provider: a login succeeds if the email
 * matches somebody in the directory. This is a stand-in so roles and routing can be built
 * and demoed now, and MUST be replaced with real authentication (Google Workspace SSO is
 * the obvious fit, since every staff email is already a Workspace account) before this
 * handles real reimbursements. It is deliberately confined to this file.
 *
 * The session carries only the email. Role, region, managers and budgets are re-read from
 * the directory on every request, so they are never frozen into a token — an admin edit
 * takes effect without the person signing out.
 */
export async function signIn(email) {
  if (googleClientId()) return { ok: false, error: 'Sign in with Google.' };
  // force: a login is exactly when a newly added person should be picked up, so do not let
  // a cache entry from before HR added them decide that they do not exist.
  const user = await findUserByEmail(email, { force: true });
  if (!user) return { ok: false, error: 'That email is not in the Songa directory. Ask HR to add you.' };
  if (user.active === false) return { ok: false, error: 'This account has been deactivated. Speak to HR if that is wrong.' };
  return { ok: true, user, token: issueToken(user.email) };
}

const SESSION_HOURS = 12;

// The payload is JSON rather than a delimited string because staff emails contain dots,
// which silently truncated the email when the token was split on them.
export const googleSignInEnabled = () => Boolean(googleClientId());

let verifier = null;
/** Swapped in by tests, which cannot mint a real Google token. */
export function setTokenVerifierForTests(fake) { verifier = fake; }

/**
 * Signs someone in from a Google ID token.
 *
 * The token is verified against Google's keys and this app's client ID, so a token minted
 * for another application will not work here. Three checks follow, in order of how badly
 * each would fail: the address must be verified by Google, it must belong to the allowed
 * Workspace domain, and it must already exist in the directory. Songa never creates an
 * account from a sign-in — an unknown address is turned away.
 */
export async function signInWithGoogle(credential) {
  if (!googleClientId()) return { ok: false, error: 'Google sign-in is not configured on this server.' };
  if (!credential) return { ok: false, error: 'No sign-in token was supplied.' };

  let payload;
  try {
    if (verifier) {
      payload = await verifier(credential);
    } else {
      const client = new OAuth2Client(googleClientId());
      const ticket = await client.verifyIdToken({ idToken: credential, audience: googleClientId() });
      payload = ticket.getPayload();
    }
  } catch (error) {
    return { ok: false, error: 'That sign-in could not be verified. Try again.' };
  }

  const email = String(payload?.email || '').trim().toLowerCase();
  if (!email || payload.email_verified === false) {
    return { ok: false, error: 'Google did not confirm that address.' };
  }
  // hd is the Workspace domain. A personal gmail account has no hd at all. The allowlist
  // exists so a test account can be stood up without handing it a staff mailbox; it lifts
  // the domain rule only, never the Google verification or the directory check.
  const inDomain = payload.hd === ALLOWED_DOMAIN || email.endsWith(`@${ALLOWED_DOMAIN}`);
  if (ALLOWED_DOMAIN && !inDomain && !EXTRA_ALLOWED_EMAILS.includes(email)) {
    return { ok: false, error: `Sign in with your ${ALLOWED_DOMAIN} account.` };
  }

  const user = await findUserByEmail(email, { force: true });
  if (!user) return { ok: false, error: 'That address is not set up in Songa. Ask an administrator to add you.' };
  if (user.active === false) return { ok: false, error: 'This account has been deactivated.' };

  return { ok: true, user, token: issueToken(user.email) };
}

export function issueToken(email) {
  const payload = JSON.stringify({ email, exp: Date.now() + SESSION_HOURS * 3600_000, nonce: randomUUID() });
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function readToken(token) {
  const raw = String(token || '');
  const split = raw.lastIndexOf('.');
  if (split < 1) return null;
  const payload = Buffer.from(raw.slice(0, split), 'base64url').toString('utf8');
  const signature = raw.slice(split + 1);
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const { email, exp } = JSON.parse(payload);
    return exp > Date.now() ? email : null;
  } catch {
    return null;
  }
}

/**
 * Express middleware: resolves the session token to the staff record as it stands right
 * now. Binding happens per request rather than at login, so revoking a role or changing a
 * budget takes effect without the person signing out.
 */
export async function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const email = readToken(header.replace(/^Bearer\s+/i, '') || req.get('x-songa-session'));
  if (!email) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Your staff record is no longer in the directory.' });
    if (user.active === false) return res.status(401).json({ error: 'This account has been deactivated.' });
    req.user = user;
    return next();
  } catch (error) {
    // The directory is unreadable. Refuse rather than fall back to a remembered role.
    return res.status(error.status || 503).json({ error: error.message });
  }
}

/** Express middleware factory: gates a route to a set of roles. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this view.' });
    return next();
  };
}

function sign(payload) {
  return createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
