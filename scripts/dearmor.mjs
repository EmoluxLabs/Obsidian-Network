#!/usr/bin/env node
/**
 * Strip PGP ASCII armour, so `gpgv` can use a shipped public key without a
 * full gnupg install. Armour is base64 with a header block, optional
 * key:value lines, and a trailing `=CRC24` checksum line.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: dearmor.mjs <armoured-key> <output-keyring>');
  process.exit(2);
}

const text = readFileSync(input, 'utf8');
if (!/-----BEGIN PGP PUBLIC KEY BLOCK-----/.test(text)) {
  console.error(`${input} is not an armoured PGP public key`);
  process.exit(1);
}

const body = text
  .replace(/-----BEGIN [^-]+-----/, '')
  .replace(/-----END [^-]+-----/, '')
  .split('\n')
  .filter((line) => line.trim() && !line.includes(': ') && !line.startsWith('='))
  .join('');

const bytes = Buffer.from(body, 'base64');
if (bytes.length === 0) {
  console.error(`${input} contained no key data`);
  process.exit(1);
}
writeFileSync(output, bytes);
