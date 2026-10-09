#!/usr/bin/env node
/**
 * Generate a mining gate issuer key (protocol 1.7.0).
 *
 * A MINING_CLAIM is valid only with a certificate signed by an issuer key committed in genesis (see
 * obsidian-core/src/mining/gate.ts). The PUBLIC key goes to every node; the PRIVATE key goes only to the account
 * platform that issues the certificates, and is stored here ENCRYPTED (AES-256-GCM, scrypt) — never as plain text.
 *
 *   OBSIDIAN_GATE_KEYSTORE_PASSPHRASE='<at least 12 characters>' \
 *     node scripts/generate-mining-gate-key.mjs [--network mainnet] [--out gate-keys]
 *
 *   --print-only   generate and print the public key only; nothing is written (the private key is discarded)
 *
 * Output:
 *   <out>/<network>-mining-gate.keystore.json   (0600; encrypted private key — keep it off the repository)
 *   stdout: the public key to publish, and where to put it
 *
 * Next steps (mainnet/testnet):
 *   1. Give every node the key:  OBSIDIAN_MINING_GATE_PUBLIC_KEYS=<publicKey>   (or commit it to
 *      obsidian-core/src/genesis/gate-keys.ts and rebuild). Every node must use the same list: it is hashed into the
 *      genesis id, so a different list is a different chain.
 *   2. Give the platform the keystore:  OBSIDIAN_GATE_KEYSTORE=<path>  and  OBSIDIAN_GATE_KEYSTORE_PASSPHRASE(_FILE).
 *   3. For redundancy and rotation run the script again and give the nodes BOTH public keys (up to 8).
 *
 * Key generation and the keystore are the protocol's own code (obsidian-core/dist), not a re-implementation.
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORKS = { mainnet: 'obs', testnet: 'tobs', staging: 'tobs', devnet: 'tobs' };

function parse(argv) {
  const out = { network: 'mainnet', out: resolve(ROOT, 'gate-keys'), printOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--print-only') { out.printOnly = true; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (!['--network', '--out'].includes(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`flag ${arg} needs a value`);
    i += 1;
    if (arg === '--network') out.network = value;
    else out.out = resolve(process.cwd(), value);
  }
  return out;
}

function passphrase() {
  const file = process.env.OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE;
  const value = process.env.OBSIDIAN_GATE_KEYSTORE_PASSPHRASE ?? (file && existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined);
  if (!value || value.length < 12) {
    throw new Error('set OBSIDIAN_GATE_KEYSTORE_PASSPHRASE (or _FILE) to a passphrase of at least 12 characters');
  }
  return value;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.help) { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?\n?/, '') + '\n'); return; }
  if (!(args.network in NETWORKS)) throw new Error(`unknown network: ${args.network}`);
  const dist = (name) => resolve(ROOT, 'obsidian-core', 'dist', ...name);
  if (!existsSync(dist(['crypto', 'keystore.js']))) throw new Error('obsidian-core/dist is missing: run `npm --prefix obsidian-core run build` first');
  const { generateKeyPair } = await import(pathToFileURL(dist(['crypto', 'keys.js'])).href);
  const { Keystore } = await import(pathToFileURL(dist(['crypto', 'keystore.js'])).href);
  const pair = generateKeyPair(NETWORKS[args.network]);

  process.stdout.write(`\nmining gate issuer — obsidian-${args.network}\n  public key: ${pair.publicKey}\n  key id:     ${pair.address}\n\n`);
  if (args.printOnly) {
    process.stdout.write('--print-only: nothing was written and the private key was discarded.\n');
    return;
  }
  const phrase = passphrase();
  mkdirSync(args.out, { recursive: true, mode: 0o700 });
  const target = resolve(args.out, `${args.network}-mining-gate.keystore.json`);
  if (existsSync(target)) throw new Error(`${target} already exists; move it aside first (never overwrite an issuer key)`);
  Keystore.write(target, pair.privateKey, phrase);
  // Prove it round-trips before anyone relies on it.
  if (Keystore.read(target, phrase).publicKey !== pair.publicKey) throw new Error('keystore round-trip mismatch');
  process.stdout.write(
    `encrypted private key written to ${target} (mode 0600)\n` +
      `give every node:      OBSIDIAN_MINING_GATE_PUBLIC_KEYS=${pair.publicKey}\n` +
      `give the platform:    OBSIDIAN_GATE_KEYSTORE=${target}  +  OBSIDIAN_GATE_KEYSTORE_PASSPHRASE(_FILE)\n` +
      `never commit the keystore: git check-ignore -v ${target}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
