import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { ALLOWED_DOMAIN, EXTRA_ALLOWED_EMAILS, SESSION_SECRET } from './config.js';
import {
  clearFailures, codeMatches, getCredential, passwordProblem, recordFailure, setPassword, throttled, verifyPassword,
} from './passwords.js';

// Read when needed, not at import: the value lives in the environment and the tests set it.
const googleClientId = () => process.env.SONGA_GOOGLE_CLIENT_ID || '';
import { findUserByEmail, getUsers } from './directory.js';

export { findUserByEmail };
export const allUsers = getUsers;

/**
 * The single answer to every refused sign-in.
 *
 * One message on purpose. Saying "not in the directory" for an unknown address and
 * "deactivated" for a known one turns the sign-in page into a way to find out who works
 * here and who has left — ask it about an address and it tells you. The two cases are
 * different to us and identical to whoever is asking.
 *
 * It names the next step, because the commonest person to see this is a real new joiner
 * whose access has not been set up yet. Access is requested through Jira, not from HR.
 */
const ACCESS_DENIED = 'Access denied. Raise a Jira ticket to request access.';

// The same for a wrong password, an unknown address, and an address with no password
// yet, for the reason above. It points at the setup code because "I have never set one"
// is the commonest cause in the first weeks.
const NO_MATCH = 'That email and password do not match. If you have not set a password yet, ask HR for a setup code.';
const BAD_CODE = 'That setup code is not valid for this email, or it has expired. Ask HR for a new one.';

const normalise = (email) => String(email || '').trim().toLowerCase();

/**
 * Signs somebody in with their email and password.
 *
 * Every refusal costs the same scrypt check, whether the address exists or not, and every
 * refusal counts towards the lock in passwords.js, so the endpoint cannot be used to find
 * out who has an account or to guess at one.
 *
 * The session carries only the email. Role, region, managers and budgets are re-read from
 * the directory on every request, so they are never frozen into a token — an admin edit
 * takes effect without the person signing out.
 */
export async function signIn(email, password, { ip = '' } = {}) {
  const address = normalise(email);
  if (!address || !password) return { ok: false, status: 400, error: 'Enter your email and password.' };

  const locked = await throttled(address, ip);
  if (locked) return { ok: false, status: 429, error: locked };

  const credential = await getCredential(address);
  if (!(await verifyPassword(password, credential?.password_hash))) {
    await recordFailure(address, ip);
    return { ok: false, status: 401, error: NO_MATCH };
  }

  // force: a login is exactly when a newly added person should be picked up, so do not let
  // a cache entry from before HR added them decide that they do not exist.
  const user = await findUserByEmail(address, { force: true });
  if (!user || user.active === false) return { ok: false, status: 401, error: ACCESS_DENIED };

  await clearFailures(address);
  return { ok: true, user, token: issueToken(user.email) };
}

/**
 * Sets a password from a one-time setup code, then signs the person in.
 *
 * The route for a first password and for every reset. The code is the proof of identity,
 * so a wrong one counts against the same lock as a wrong password does — otherwise eight
 * characters would be the easier thing to guess.
 */
export async function signInWithSetupCode(email, code, password, { ip = '' } = {}) {
  const address = normalise(email);
  if (!address || !code) return { ok: false, status: 400, error: 'Enter your email and the setup code from HR.' };
  const weak = passwordProblem(password, address);
  if (weak) return { ok: false, status: 400, error: weak };

  const locked = await throttled(address, ip);
  if (locked) return { ok: false, status: 429, error: locked };

  const credential = await getCredential(address);
  const user = codeMatches(credential, code) ? await findUserByEmail(address, { force: true }) : null;
  if (!user || user.active === false) {
    await recordFailure(address, ip);
    return { ok: false, status: 401, error: BAD_CODE };
  }

  await setPassword(address, password);
  await clearFailures(address);
  console.log(`[auth] ${address} set a password with a setup code`);
  return { ok: true, user, token: issueToken(user.email) };
}

// Long, because the whole point is that people are not asked to sign in again on the
// phone they always use. It is safe to be long because nothing about access lives in the
// token: deactivating somebody or resetting their password takes effect on their next
// request, not when this runs out.
const SESSION_DAYS = 30;

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
  if (!user || user.active === false) return { ok: false, error: ACCESS_DENIED };

  return { ok: true, user, token: issueToken(user.email) };
}

export function issueToken(email) {
  const now = Date.now();
  const payload = JSON.stringify({ email, iat: now, exp: now + SESSION_DAYS * 24 * 3600_000, nonce: randomUUID() });
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/** The email a valid token was issued for, or null. */
export function readToken(token) {
  return readSession(token)?.email ?? null;
}

/** The email and issue time of a valid, unexpired token, or null. */
function readSession(token) {
  const raw = String(token || '');
  const split = raw.lastIndexOf('.');
  if (split < 1) return null;
  const payload = Buffer.from(raw.slice(0, split), 'base64url').toString('utf8');
  const signature = raw.slice(split + 1);
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const { email, exp, iat } = JSON.parse(payload);
    return exp > Date.now() ? { email, iat: Number(iat) || 0 } : null;
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
  const session = readSession(header.replace(/^Bearer\s+/i, '') || req.get('x-songa-session'));
  if (!session) return res.status(401).json({ error: 'Sign in to continue.' });
  const { email } = session;
  try {
    // A password reset moves sessions_after forward. Anything issued before it belongs to
    // whoever had the old password, which after a reset is not to be assumed to be them.
    const credential = await getCredential(email);
    if (credential?.sessions_after && session.iat < new Date(credential.sessions_after).getTime()) {
      return res.status(401).json({ error: 'Your password was changed. Sign in again.' });
    }
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
