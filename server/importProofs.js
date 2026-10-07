import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { closeDb, dbPath, ensureSchema, get } from './db.js';
import { LEGACY_UPLOAD_DIR, sanitise, storeProof } from './proofStore.js';

/**
 * Copies proof images from server/uploads into the database.
 *
 *   npm run proofs:import
 *
 * For images saved before proofs moved into the database. Run it once, against the
 * database the deployed app will use, from the machine that has the files — after that
 * the server never needs the folder again. Safe to repeat: an image already in the
 * database is left alone, so nothing newer is overwritten by an old copy.
 */
async function main() {
  await ensureSchema();
  console.log(`[proofs] into ${dbPath()}`);

  let names;
  try {
    names = await readdir(LEGACY_UPLOAD_DIR);
  } catch {
    console.log(`[proofs] nothing to import: ${LEGACY_UPLOAD_DIR} does not exist.`);
    return;
  }

  let copied = 0;
  let present = 0;
  for (const name of names.filter((item) => /\.(webp|jpe?g|png)$/i.test(item))) {
    const safe = sanitise(name);
    if (await get('SELECT filename FROM proofs WHERE filename = ?', [safe])) { present += 1; continue; }
    await storeProof(safe, await readFile(path.join(LEGACY_UPLOAD_DIR, name)));
    copied += 1;
  }
  console.log(`[proofs] copied ${copied}, already there ${present}.`);
}

main()
  .catch((error) => { console.error('[proofs] failed:', error.message); process.exitCode = 1; })
  .finally(() => closeDb());
