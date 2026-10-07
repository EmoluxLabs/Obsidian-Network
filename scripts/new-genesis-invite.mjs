#!/usr/bin/env node
/**
 * Generate the ONE Genesis Invitation for a deployment.
 *
 *   node scripts/new-genesis-invite.mjs
 *   node scripts/new-genesis-invite.mjs --json     # {"code":"…","hash":"…"} for automation
 *
 * Prints the plaintext code once, and the scrypt hash to configure the server
 * with. The plaintext is produced here, shown, and then forgotten — this script
 * writes nothing to disk. If you lose the code, generate a new one; there is no
 * way to recover it from the hash, which is the entire point.
 *
 * The hash is NOT a secret in the way the code is, but it is still not
 * something to publish: treat it as a password hash, because that is what it
 * is. Give it to the server through the environment, never through a file in
 * this repository.
 *
 * Requires obsidian-interface to have been built:
 *   npm --prefix obsidian-interface run build
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  // An explicit location wins: scripts/obsidian-network.sh sets it when the
  // interface is not in one of the places below.
  ...(process.env.OBSIDIAN_INTERFACE_DIR ? [join(process.env.OBSIDIAN_INTERFACE_DIR, 'dist', 'server', 'genesis-invite.js')] : []),
  join(here, '..', 'obsidian-interface', 'dist', 'server', 'genesis-invite.js'),
  join(here, 'obsidian-interface', 'dist', 'server', 'genesis-invite.js'),
  join(process.cwd(), 'obsidian-interface', 'dist', 'server', 'genesis-invite.js'),
];
const built = candidates.find((path) => existsSync(path));

if (!built) {
  console.error('could not find the built interface. Looked in:');
  for (const path of candidates) console.error(`  ${path}`);
  console.error('\nbuild it first:  npm --prefix obsidian-interface run build');
  process.exit(2);
}

const { newGenesisInvitation } = await import(pathToFileURL(built).href);
const { code, hash } = newGenesisInvitation();

// Machine-readable form, for scripts and CI. Same rule as the human form: the
// plaintext is printed once, to the caller, and written nowhere.
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ code, hash }));
  process.exit(0);
}

const line = '═'.repeat(72);
console.log(`\n${line}`);
console.log('  GENESIS INVITATION — SHOWN ONCE, NEVER RECOVERABLE');
console.log(line);
console.log('\n  Write this down on paper, now, before you close this terminal:\n');
console.log(`      ${code}\n`);
console.log(line);
console.log('\n  Configure the server with the HASH (not the code above):\n');
console.log(`      export OBSIDIAN_GENESIS_INVITE_HASH='${hash}'\n`);
console.log(line);
console.log(`
  What this code does:
    - It registers the FIRST account on one interface deployment.
    - It is single use. The moment it is redeemed it is permanently dead.
    - It grants 0 OBS. It is a door key, not money, and confers no authority.
    - It is separate from ordinary member invites, which are unaffected.

  What this code does NOT do:
    - It does not mint, allocate or reserve any OBS.
    - It does not make its holder an administrator.
    - It cannot be recovered. The server only ever stores the scrypt hash
      above, and no code path turns that back into the invitation.

  Storage rules:
    - Write the code on paper or put it in a password manager. Offline.
    - Do not paste it into chat, email, a commit, an issue, or a screenshot.
    - Do not put the code in any file in this repository.
    - Pass the HASH to the server through the environment only.
`);
console.log(`${line}\n`);
