#!/usr/bin/env node
/**
 * Scan the files git tracks for credentials that must never be committed.
 *
 *   node scripts/scan-secrets.mjs            # scans `git ls-files`; exit 1 on a finding
 *   node scripts/scan-secrets.mjs --json     # machine-readable
 *   node scripts/scan-secrets.mjs --staged   # only what is staged (a pre-commit hook)
 *
 * It is a tripwire, not a guarantee: it finds well-known token shapes, private-key armour, and an assignment of a literal
 * to a name that says it is a secret. It does not know your secrets, and a base64'd or split secret will pass.
 *
 * Findings print the file, line and RULE only, never the matched text, so the scanner's own output cannot leak what it finds.
 * A reviewed false positive is silenced on that line with the comment  scan-secrets:allow  and a reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const root = resolve(new URL('..', import.meta.url).pathname);

export const RULES = [
  { id: 'private-key-armour', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // name = "literal": a secret-sounding name bound to a long literal that is not obviously a placeholder
  {
    id: 'secret-assignment',
    re: /\b(?:private[_-]?key|secret[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|passphrase|password|mnemonic|recovery[_-]?phrase)\b["']?\s*[:=]\s*["'`]([A-Za-z0-9+/=_-]{24,})["'`]/i,
    accept: (m) => !/^(?:x+|0+|1+|a+|\*+|changeme|placeholder|example|your[_-].*|<.*>)$/i.test(m[1]) && new Set(m[1]).size > 8,
  },
];

// Fixtures that hold deliberately public or throw-away values. Everything else is scanned.
const SKIP_PATH = [
  /(^|\/)node_modules\//, /^releases\//, /(^|\/)package-lock\.json$/, /\.(?:png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|wasm)$/i,
  /^audit\/evidence\//,
];

const tracked = args.has('--staged')
  ? git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
  : git(['ls-files', '-z']);

function git(argv) {
  const out = execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split(argv.includes('-z') ? '\0' : '\n').filter(Boolean);
}

export function scanText(text) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 4000 || line.includes('scan-secrets:allow')) continue;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m && (!rule.accept || rule.accept(m))) findings.push({ line: i + 1, rule: rule.id });
    }
  }
  return findings;
}

function main() {
  const all = [];
  let scanned = 0;
  for (const file of tracked) {
    if (SKIP_PATH.some((re) => re.test(file))) continue;
    let text;
    try {
      if (statSync(resolve(root, file)).size > 2 * 1024 * 1024) continue;
      text = readFileSync(resolve(root, file), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    scanned += 1;
    for (const f of scanText(text)) all.push({ file, ...f });
  }
  if (args.has('--json')) console.log(JSON.stringify({ scanned, findings: all }, null, 2));
  else {
    for (const f of all) console.log(`${f.file}:${f.line}  ${f.rule}`);
    console.log(`${all.length === 0 ? 'OK' : 'FOUND'}: ${scanned} files scanned, ${all.length} finding(s)`);
  }
  process.exit(all.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
