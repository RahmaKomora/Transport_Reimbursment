import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SESSION_SECRET } from './config.js';
import { findUserByEmail, getUsers } from './sheetConfig.js';

export { findUserByEmail };
export const allUsers = getUsers;

/**
 * Local development authentication.
 *
 * There is no password store and no identity provider: a login succeeds if the email
 * matches a row in the staff sheet. This is a stand-in so roles and routing can be built
 * and demoed now, and MUST be replaced with real authentication (Google Workspace SSO is
 * the obvious fit, since every staff email is already a Workspace account) before this
 * handles real reimbursements. It is deliberately confined to this file.
 *
 * The session carries only the email. Role, region, managers and budgets are re-read from
 * the sheet on every request, so they are never frozen into a token — an edit in the sheet
 * takes effect without the person signing out.
 */
export async function signIn(email) {
  // force: a login is exactly when a newly added row should be picked up, so do not let a
  // cache entry from before HR added them decide that they do not exist.
  const user = await findUserByEmail(email, { force: true });
  if (!user) return { ok: false, error: 'That email is not in the staff sheet. Ask HR to add you.' };
  return { ok: true, user, token: issueToken(user.email) };
}

const SESSION_HOURS = 12;

// The payload is JSON rather than a delimited string because staff emails contain dots,
// which silently truncated the email when the token was split on them.
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
 * Express middleware: resolves the session token to the staff record as the sheet defines
 * it right now. Binding happens per request rather than at login, so revoking a role or
 * changing a budget in the sheet takes effect without the person signing out.
 */
export async function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const email = readToken(header.replace(/^Bearer\s+/i, '') || req.get('x-songa-session'));
  if (!email) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Your staff record is no longer in the sheet.' });
    req.user = user;
    return next();
  } catch (error) {
    // The sheet is unreachable. Refuse rather than fall back to a remembered role.
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
