import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { all, get, run } from './db.js';

/**
 * Songa's own passwords.
 *
 * Staff sign in with their work email and a password they chose, and the sign-in form is
 * built so the browser offers to save it — after the first time, signing in is a tap on
 * the autofilled form. There is no mail transport, so nobody can be emailed a reset link:
 * a first password, and every reset, starts from a one-time setup code that an admin
 * issues and hands over in person or on Slack.
 *
 * Passwords live in `credentials`, never in `users`, so the directory — which is read
 * whole and cached — has no way to carry a hash anywhere.
 */

const scrypt = promisify(scryptCallback);

// scrypt at N=2^15 costs about 32 MB and a tenth of a second per attempt: unnoticeable at
// sign-in, ruinous for anyone guessing against a stolen table. The parameters are written
// into each hash, so raising them later leaves existing passwords working.
const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

export const MIN_PASSWORD = 8;
// A ceiling because scrypt's cost grows with the input, and an unbounded field is a way
// to make the server do a lot of work for one request.
export const MAX_PASSWORD = 200;

/** Why this password cannot be used, or '' when it can. */
export function passwordProblem(password, email = '') {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (value.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  const local = String(email).split('@')[0].toLowerCase();
  if (local && value.toLowerCase().includes(local)) return 'Do not use your email address in your password.';
  return '';
}

// NFKC so a password typed on a phone keyboard and on a laptop compares equal even where
// the two produce different code points for the same character.
const prepare = (password) => String(password).normalize('NFKC');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(prepare(password), salt, KEY_LENGTH, { ...COST, maxmem: MAX_MEMORY });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

// Checked against when an account has no password, so a sign-in for an address that has
// none takes as long as one that does. Otherwise the timing alone says who has an account.
let decoy = null;
const decoyHash = () => (decoy ||= hashPassword(randomBytes(24).toString('base64url')));

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  const usable = parts.length === 6 && parts[0] === 'scrypt';
  const [, N, r, p, salt, key] = usable ? parts : (await decoyHash()).split('$');
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(prepare(password), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: MAX_MEMORY,
  });
  return usable && timingSafeEqual(actual, expected);
}

/* --------------------------------------------------------------- setup codes ----- */

// No I, L, O, 0 or 1: a code is read off one screen and typed into another, often a
// phone, and those are the characters people misread.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const SETUP_CODE_DAYS = 7;

/** Uppercased, with the dash and any stray spaces from a paste removed. */
const normaliseCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const digest = (code) => createHash('sha256').update(normaliseCode(code)).digest('hex');

function newCode() {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

export async function getCredential(email) {
  return get('SELECT * FROM credentials WHERE email = ?', [normaliseEmail(email)]);
}

/**
 * A fresh one-time code for this address, replacing any earlier one.
 *
 * Only the hash is kept, so the code is shown once — to the admin who asked for it — and
 * cannot be read back later by anybody, including them. An existing password keeps
 * working until the code is used, so issuing a code to the wrong person locks nobody out.
 */
export async function issueSetupCode(email, issuedBy) {
  const address = normaliseEmail(email);
  const code = newCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SETUP_CODE_DAYS * 24 * 3600_000).toISOString();
  await run([
    'INSERT INTO credentials (email, setup_code_hash, setup_code_expires_at, setup_code_issued_by, updated_at)',
    'VALUES (?, ?, ?, ?, ?)',
    'ON CONFLICT(email) DO UPDATE SET setup_code_hash = excluded.setup_code_hash,',
    '  setup_code_expires_at = excluded.setup_code_expires_at,',
    '  setup_code_issued_by = excluded.setup_code_issued_by, updated_at = excluded.updated_at',
  ].join('\n'), [address, digest(code), expiresAt, String(issuedBy || ''), now.toISOString()]);
  return { email: address, code, expiresAt };
}

/** Whether this code is the outstanding one for this address and has not expired. */
export function codeMatches(credential, code) {
  if (!credential?.setup_code_hash || !credential.setup_code_expires_at) return false;
  if (new Date(credential.setup_code_expires_at).getTime() <= Date.now()) return false;
  const expected = Buffer.from(credential.setup_code_hash, 'hex');
  const actual = Buffer.from(digest(code), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Stores a new password and spends the setup code.
 *
 * Also moves sessions_after forward, which signs out every device still holding a session
 * from before — the point of a reset is usually that somebody else might have the old one.
 */
export async function setPassword(email, password) {
  const address = normaliseEmail(email);
  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  await run([
    'INSERT INTO credentials (email, password_hash, password_set_at, sessions_after, updated_at)',
    'VALUES (?, ?, ?, ?, ?)',
    'ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash,',
    "  password_set_at = excluded.password_set_at, setup_code_hash = '', setup_code_expires_at = NULL,",
    '  sessions_after = excluded.sessions_after, updated_at = excluded.updated_at',
  ].join('\n'), [address, hash, now, now, now]);
}

/** For the admin screen: who has a password, and who has a code waiting. Never a hash. */
export async function signInStatus() {
  const rows = await all('SELECT email, password_hash, password_set_at, setup_code_hash, setup_code_expires_at FROM credentials');
  const now = Date.now();
  return Object.fromEntries(rows.map((row) => [row.email, {
    hasPassword: Boolean(row.password_hash),
    passwordSetAt: row.password_set_at || null,
    codeExpiresAt: row.setup_code_hash && row.setup_code_expires_at && new Date(row.setup_code_expires_at).getTime() > now
      ? row.setup_code_expires_at : null,
  }]));
}

/* ---------------------------------------------------------------- throttling ----- */

// Five wrong answers for one address locks it for fifteen minutes. Counted per address
// whether or not the address exists, so the lock message gives nothing away either.
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

// And per network address, in memory, so one machine cannot work through a list of
// addresses five guesses at a time. Generous, because an office NATs a whole team
// behind one address. Per pod: with two replicas the effective ceiling doubles, which
// is acceptable when the per-address limit above holds across all of them.
const MAX_FAILURES_PER_IP = 30;
const failuresByIp = new Map();

export const LOCKED_MESSAGE = `Too many attempts. Wait ${LOCK_MINUTES} minutes and try again.`;

/** A refusal message when this attempt should not even be checked, or ''. */
export async function throttled(email, ip) {
  const byIp = failuresByIp.get(ip);
  if (byIp && byIp.resetAt > Date.now() && byIp.count >= MAX_FAILURES_PER_IP) return LOCKED_MESSAGE;
  const row = await get('SELECT locked_until FROM login_attempts WHERE email = ?', [normaliseEmail(email)]);
  if (row?.locked_until && new Date(row.locked_until).getTime() > Date.now()) return LOCKED_MESSAGE;
  return '';
}

export async function recordFailure(email, ip) {
  const now = Date.now();
  if (ip) {
    const current = failuresByIp.get(ip);
    const fresh = !current || current.resetAt <= now;
    failuresByIp.set(ip, { count: fresh ? 1 : current.count + 1, resetAt: fresh ? now + LOCK_MINUTES * 60_000 : current.resetAt });
    // Bounded, so a flood of distinct addresses cannot grow this without limit.
    if (failuresByIp.size > 10_000) {
      for (const [key, value] of failuresByIp) if (value.resetAt <= now) failuresByIp.delete(key);
    }
  }

  const address = normaliseEmail(email);
  const row = await get('SELECT failures, locked_until FROM login_attempts WHERE email = ?', [address]);
  // A lock that has run out starts the count again, rather than relocking on the next slip.
  const expired = row?.locked_until && new Date(row.locked_until).getTime() <= now;
  const failures = (expired ? 0 : Number(row?.failures) || 0) + 1;
  const lockedUntil = failures >= MAX_FAILURES ? new Date(now + LOCK_MINUTES * 60_000).toISOString() : null;
  await run([
    'INSERT INTO login_attempts (email, failures, locked_until) VALUES (?, ?, ?)',
    'ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until',
  ].join('\n'), [address, lockedUntil ? 0 : failures, lockedUntil]);
}

export async function clearFailures(email) {
  await run('DELETE FROM login_attempts WHERE email = ?', [normaliseEmail(email)]);
}

/** Test-only: forget the in-memory per-IP counts between cases. */
export function resetThrottleForTests() { failuresByIp.clear(); }
