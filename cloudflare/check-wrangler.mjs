#!/usr/bin/env node
/**
 * Refuse to deploy a worker that is still wearing its placeholders.
 *
 *   node check-wrangler.mjs [wrangler.toml]
 *
 * A Cloudflare deploy with `account_id = "CHANGE-ME-account-id"` fails with a
 * provider error, but a deploy that merely points at the wrong *origin*
 * succeeds and serves a broken site from a real domain. That is the case this
 * catches: every placeholder must be gone before anything ships.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? resolve(here, 'wrangler.toml');

if (!existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(2);
}

const text = readFileSync(file, 'utf8');
const problems = [];

text.split('\n').forEach((line, index) => {
  if (line.trim().startsWith('#')) return;
  if (/CHANGE-ME/.test(line)) problems.push(`${index + 1}: ${line.trim()}`);
  if (/\.example\b|example\.invalid|example\.org|example\.com/.test(line) && !line.trim().startsWith('#')) {
    if (!problems.some((p) => p.startsWith(`${index + 1}:`))) problems.push(`${index + 1}: ${line.trim()}`);
  }
});

// Required keys that have no sensible default.
for (const key of ['account_id', 'main', 'name']) {
  if (!new RegExp(`^\\s*${key}\\s*=`, 'm').test(text)) problems.push(`missing required key: ${key}`);
}

if (problems.length) {
  console.error(`${file} is not ready to deploy — ${problems.length} placeholder(s):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`
Fill these in first:
  account_id            npx wrangler whoami
  kv_namespaces.id      npx wrangler kv namespace create OBSIDIAN_CACHE
  OBSIDIAN_ORIGIN       the interface instance that reads your nodes
  routes.pattern/zone   the zone this worker serves
`);
  process.exit(1);
}

console.log(`${file}: no placeholders left — ready to deploy.`);
