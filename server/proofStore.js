import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Storage for proof-of-payment images.
 *
 * Until now the claim form compressed the M-Pesa screenshot and then discarded it: an
 * approver was asked to sign off a payment whose evidence existed only in the claimant's
 * browser for a few seconds. This keeps the file so it can be looked at.
 *
 * Files live beside the server rather than in the spreadsheet, because a sheet cell holds
 * about 50,000 characters and a 500 KB image is an order of magnitude past that. The
 * sheet records the filename; the bytes live here and are served through an authenticated
 * endpoint, never as a public link.
 *
 * For a pilot on one machine that is fine. Before this carries real payments the files
 * belong in Drive alongside the sheet, so they survive the laptop — the interface here is
 * deliberately small so that swap is contained.
 */
const UPLOAD_DIR = process.env.SONGA_UPLOAD_DIR || path.join(process.cwd(), 'server', 'uploads');

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

  await mkdir(UPLOAD_DIR, { recursive: true });
  // Named after the claim so a file can never be attached to the wrong one, and a
  // re-submission of the same claim overwrites rather than accumulating orphans.
  const filename = `${sanitise(claimId)}.${parsed.extension}`;
  await writeFile(path.join(UPLOAD_DIR, filename), parsed.bytes);
  return filename;
}

/** Reads a stored proof. Returns null when the record names a file that is not there. */
export async function readProof(filename) {
  const safe = sanitise(filename);
  if (!safe) return null;
  try {
    const bytes = await readFile(path.join(UPLOAD_DIR, safe));
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

// The filename reaches this module from a sheet cell, which a person can edit by hand.
// Stripping everything but the basename keeps "../../.env" from ever being a valid name.
function sanitise(value) {
  return path.basename(String(value || '')).replace(/[^a-zA-Z0-9._-]/g, '');
}

function typeOf(filename) {
  if (filename.endsWith('.webp')) return 'image/webp';
  if (filename.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}
