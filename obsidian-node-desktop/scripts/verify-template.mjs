#!/usr/bin/env node
/**
 * Template integrity: the design ZIP shipped in the repository must be untouched, and the
 * renderer must still carry the template's logo byte-for-byte.
 *
 *  1. sha256(obsidian-node-design.zip) equals renderer/TEMPLATE.sha256 (recorded when the app was built from it)
 *  2. the ZIP is identical to the committed version (git), when run inside the repository
 *  3. renderer/assets/obsidian-logo.png equals the logo inside the ZIP
 *  4. the template's colour tokens (:root variables) are all present in renderer/styles.css
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zip = join(root, 'obsidian-node-design.zip');
const problems = [];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

if (!existsSync(zip)) {
  process.stderr.write('verify-template: obsidian-node-design.zip is missing\n');
  process.exit(1);
}
const zipBytes = readFileSync(zip);
const recorded = readFileSync(join(root, 'renderer', 'TEMPLATE.sha256'), 'utf8').trim();
if (sha(zipBytes) !== recorded) problems.push(`ZIP sha256 ${sha(zipBytes)} differs from the recorded ${recorded}`);

try {
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'obsidian-node-design.zip'], { cwd: root, stdio: 'ignore' });
} catch (error) {
  if (error.status === 1) problems.push('the template ZIP differs from the committed version');
}

const unzipOne = (entry) => {
  try {
    return execFileSync('unzip', ['-p', zip, entry], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};
const logoZip = unzipOne('obsidian-node-design/assets/images/obsidian-logo.png');
if (logoZip === null) process.stdout.write('verify-template: note: `unzip` not available, logo and token checks skipped\n');
else {
  if (sha(readFileSync(join(root, 'renderer', 'assets', 'obsidian-logo.png'))) !== sha(logoZip)) problems.push('renderer logo differs from the template logo');
  const tpl = unzipOne('obsidian-node-design/index.html')?.toString('utf8') ?? '';
  const tokens = [...(/:root\{([^}]*)\}/.exec(tpl)?.[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
  const css = readFileSync(join(root, 'renderer', 'styles.css'), 'utf8').replace(/\s+/g, '');
  if (tokens.length === 0) problems.push('could not read the template colour tokens');
  for (const [, name, value] of tokens) if (!css.includes(`${name}:${value.replace(/\s+/g, '')}`)) problems.push(`style token ${name}:${value.trim()} is not in styles.css`);
  process.stdout.write(`verify-template: ${tokens.length} colour tokens compared\n`);
}

if (problems.length > 0) {
  process.stderr.write(`verify-template: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`verify-template: ok (template sha256 ${recorded.slice(0, 12)}…)\n`);
