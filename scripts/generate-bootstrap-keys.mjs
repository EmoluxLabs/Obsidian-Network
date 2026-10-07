#!/usr/bin/env node
/**
 * Generate a finality bootstrap validator key set.
 *
 * The Obsidian v1.6 finality bootstrap committee is a *public, genesis-committed*
 * list of validator public keys. The private keys never belong in the repository;
 * the public keys are what the protocol commits and what every node must agree
 * on (they are hashed into the genesis id — see obsidian-core/src/genesis/).
 *
 * Two different jobs, so the script does two different things:
 *
 *   1. mainnet / testnet: the set is a protocol constant and lives in
 *      obsidian-core/src/genesis/bootstrap-keys.ts. Run this script, paste the
 *      printed `publicKeys` array into that file, rebuild, and confirm the new
 *      genesis id in the release notes/docs. The private keys stay with the
 *      operators who will actually bond 20,000 OBS each.
 *
 *   2. staging / devnet / a private chain: no set is committed. Each operator
 *      generates their own and configures it with
 *      OBSIDIAN_BOOTSTRAP_VALIDATOR_PUBLIC_KEYS (comma-separated) or the
 *      `bootstrapValidatorPublicKeys` config field. An empty list is valid and
 *      means "no finality bootstrap", which fails closed.
 *
 * Usage:
 *   node scripts/generate-bootstrap-keys.mjs [--network mainnet] [--count 5] [--out bootstrap-keys]
 *   node scripts/generate-bootstrap-keys.mjs --print-only
 *
 * Output:
 *   <out>/<network>-bootstrap-validators.json   (mode 0600; PRIVATE KEYS — never commit)
 *   stdout: the public keys and addresses, plus a ready-to-paste TS array
 *
 * The generated file is 0600 and the repository ignores `bootstrap-keys/*` by
 * default (see .gitignore). Verify that with `git check-ignore -v <file>` before
 * you ever `git add -A`.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const NETWORK_SIZES = { mainnet: 5, testnet: 3, staging: 3, devnet: 3 };

function parseArgs(argv) {
  const out = { network: 'mainnet', count: undefined, out: resolve(ROOT, 'bootstrap-keys'), printOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--print-only') { out.printOnly = true; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    const value = argv[i + 1];
    if (!['--network', '--count', '--out'].includes(arg)) throw new Error(`unknown argument: ${arg}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`flag ${arg} needs a value`);
    i += 1;
    if (arg === '--network') out.network = value;
    if (arg === '--count') out.count = Number.parseInt(value, 10);
    if (arg === '--out') out.out = resolve(process.cwd(), value);
  }
  return out;
}

const USAGE = `Generate an Obsidian finality bootstrap validator key set.

  --network <name>   mainnet | testnet | staging | devnet   (default mainnet)
  --count <n>        keys in the set                        (default: network-specific)
  --out <dir>        where the private key file is written  (default ./bootstrap-keys)
  --print-only       do not write any file; print keys to stdout

Private keys are written to <out>/<network>-bootstrap-validators.json with mode
0600 and are never committed. Public keys are the only material the protocol
commits: paste them into obsidian-core/src/genesis/bootstrap-keys.ts for
mainnet/testnet, or pass them via OBSIDIAN_BOOTSTRAP_VALIDATOR_PUBLIC_KEYS for an
operator-specific network.
`;

/**
 * Key generation and address derivation must be the protocol's own code, not a
 * re-implementation here: a bootstrap key that maps to a different address than
 * a node computes would make the committed committee unregisterable.
 */
async function loadCoreKeys() {
  const dist = resolve(ROOT, 'obsidian-core', 'dist', 'crypto', 'keys.js');
  if (!existsSync(dist)) {
    throw new Error('obsidian-core/dist is missing: run `npm --prefix obsidian-core run build` first');
  }
  const module = await import(pathToFileURL(dist).href);
  return { generateKeyPair: module.generateKeyPair, addressFromPublicKey: module.addressFromPublicKey };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return; }
  if (!(args.network in NETWORK_SIZES)) throw new Error(`unknown network: ${args.network}`);
  const count = args.count ?? NETWORK_SIZES[args.network];
  if (!Number.isSafeInteger(count) || count < 1 || count > 21) throw new Error('--count must be between 1 and 21');

  void (async () => {
    const { generateKeyPair, addressFromPublicKey } = await loadCoreKeys();
    const hrp = args.network === 'mainnet' ? 'obs' : 'tobs';

    const keys = [];
    const seen = new Set();
    while (keys.length < count) {
      const pair = generateKeyPair(hrp);
      if (seen.has(pair.publicKey)) continue; // impossible in practice; cheap to prove
      seen.add(pair.publicKey);
      keys.push({ index: keys.length + 1, address: pair.address, publicKey: pair.publicKey, privateKey: pair.privateKey });
    }
    // `addressFromPublicKey` is asserted here so a future refactor of the keys
    // module cannot silently produce a set whose addresses disagree.
    for (const key of keys) {
      if (addressFromPublicKey(key.publicKey, hrp) !== key.address) throw new Error('address derivation mismatch');
    }
    keys.sort((a, b) => a.publicKey.localeCompare(b.publicKey));

    // The sort above is what the protocol does with the committed list; renumber
    // so the printed index is the canonical order, not generation order.
    keys.forEach((key, position) => { key.index = position + 1; });

    const publicKeys = keys.map((key) => key.publicKey);
    const header = `bootstrap validator set — obsidian-${args.network}`;
    process.stdout.write(`\n${header}\n${'-'.repeat(header.length)}\n`);
    for (const key of keys) process.stdout.write(`  ${key.index}. ${key.publicKey}\n     ${key.address}\n`);
    process.stdout.write(
      `\n${count} keys. Quorum is floor(2N/3)+1 = ${Math.floor((2 * count) / 3) + 1} signatures, so ` +
      `${count - (Math.floor((2 * count) / 3) + 1)} of them may be offline at once.\n` +
      `Each must register with exactly 20,000 OBS bonded from the address above.\n\n` +
      `Paste into obsidian-core/src/genesis/bootstrap-keys.ts as ${args.network}:\n\n` +
      `${JSON.stringify(publicKeys, null, 2)}\n\n`,
    );

    if (args.printOnly) return;
    mkdirSync(args.out, { recursive: true, mode: 0o700 });
    const target = resolve(args.out, `${args.network}-bootstrap-validators.json`);
    if (existsSync(target)) {
      const existing = JSON.parse(readFileSync(target, 'utf8'));
      if (JSON.stringify(existing.publicKeys) !== JSON.stringify(publicKeys)) {
        throw new Error(`${target} already exists with a different key set; move it aside first`);
      }
    }
    writeFileSync(
      target,
      `${JSON.stringify({ network: args.network, createdAt: new Date().toISOString(), quorum: Math.floor((2 * count) / 3) + 1, publicKeys, validators: keys }, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(`private keys written to ${target} (mode 0600) — never commit this file\n`);
    process.stdout.write('confirm with: git check-ignore -v ' + target + '\n');
  })().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

main();
