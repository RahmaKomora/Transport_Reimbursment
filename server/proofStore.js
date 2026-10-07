import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { get, run } from './db.js';

/**
 * Storage for proof-of-payment images.
 *
 * An approver is asked to sign off a payment on the strength of this image, so it has to
 * outlive whatever machine happens to be running the server. On the cluster that machine
 * is a pod, whose disk is thrown away on every deploy, restart and reschedule — so the
 * bytes live in the database, in `proofs`, beside the claim that points at them. That
 * also means any number of replicas see the same files without a shared volume.
 *
 * A claim records the filename in claims.proof_file, and the bytes are served only
 * through the authenticated endpoint in index.js, never as a public link.
 *
 * Images saved before this lived on disk under server/uploads. They are still read from
 * there when the database has no copy, and `npm run proofs:import` moves them in.
 */
export const LEGACY_UPLOAD_DIR = process.env.SONGA_UPLOAD_DIR || path.join(process.cwd(), 'server', 'uploads');

const EXTENSIONS = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Stores a data URL against a claim id and returns the stored filename.
 * Returns null when there is nothing usable to store, rather than failing the claim:
 * losing a submitted trip because an image misbehaved would be the worse outcome.
 */
export async function saveProof(claimId, dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  if (parsed.bytes.length > MAX_BYTES) throw Object.assign(new Error('That image is too large. It should be compressed to 500 KB or less before upload.'), { status: 413 });

  // Named after the claim so a file can never be attached to the wrong one, and a
  // re-submission of the same claim overwrites rather than accumulating orphans.
  const filename = `${sanitise(claimId)}.${parsed.extension}`;
  await storeProof(filename, parsed.bytes);
  return filename;
}

/** Writes the bytes under a filename, replacing any earlier copy. */
export async function storeProof(filename, bytes) {
  const safe = sanitise(filename);
  await run([
    'INSERT INTO proofs (filename, content_type, bytes, size, created_at) VALUES (?, ?, ?, ?, ?)',
    'ON CONFLICT(filename) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes,',
    '  size = excluded.size, created_at = excluded.created_at',
  ].join('\n'), [safe, typeOf(safe), bytes, bytes.length, new Date().toISOString()]);
  return safe;
}

/** Reads a stored proof. Returns null when the record names a file that is not there. */
export async function readProof(filename) {
  const safe = sanitise(filename);
  if (!safe) return null;

  const row = await get('SELECT content_type, bytes FROM proofs WHERE filename = ?', [safe]);
  // Postgres hands back a Buffer and SQLite a Uint8Array; Express wants a Buffer.
  if (row) return { bytes: Buffer.from(row.bytes), contentType: row.content_type };

  try {
    const bytes = await readFile(path.join(LEGACY_UPLOAD_DIR, safe));
    return { bytes, contentType: typeOf(safe) };
  } catch {
    return null;
  }
}

function parseDataUrl(value) {
  const match = /^data:(image\/(?:webp|jpeg|png));base64,(.+)$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, mime, base64] = match;
  return { bytes: Buffer.from(base64, 'base64'), extension: EXTENSIONS[mime] };
}

// The filename reaches this module from a database column that could be edited by hand.
// Stripping everything but the basename keeps "../../.env" from ever being a valid name.
export function sanitise(value) {
  return path.basename(String(value || '')).replace(/[^a-zA-Z0-9._-]/g, '');
}

function typeOf(filename) {
  if (filename.endsWith('.webp')) return 'image/webp';
  if (filename.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}
