import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkWebBundle, webFingerprint } from '../server/web-bundle.js';
// @ts-expect-error a plain ES module without types
import { webFingerprint as scriptFingerprint } from '../scripts/web-fingerprint.mjs';

const made: string[] = [];
function site(): { root: string; publicDir: string; src: string } {
  const root = mkdtempSync(join(tmpdir(), 'web-bundle-'));
  made.push(root);
  const publicDir = join(root, 'public');
  const src = join(root, 'web', 'src');
  mkdirSync(join(publicDir, 'js'), { recursive: true });
  mkdirSync(join(src, 'pages'), { recursive: true });
  writeFileSync(join(src, 'pages', 'landing.ts'), 'export {};\n');
  return { root, publicDir, src };
}
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('the server knows when the pages it serves are older than the code beside it', () => {
  it('the server and the build script compute the same fingerprint', () => {
    const real = resolve(__dirname, '..', 'web', 'src');
    expect(webFingerprint(real)).toBe(scriptFingerprint(real));
  });

  it('is current when the bundle carries the fingerprint of web/src', () => {
    const { publicDir, src } = site();
    writeFileSync(join(publicDir, 'js', 'build.json'), JSON.stringify({ fingerprint: webFingerprint(src) }));
    expect(checkWebBundle(publicDir).state).toBe('current');
  });

  it('is stale once a source file changes after the build', () => {
    const { publicDir, src } = site();
    writeFileSync(join(publicDir, 'js', 'build.json'), JSON.stringify({ fingerprint: webFingerprint(src) }));
    writeFileSync(join(src, 'pages', 'landing.ts'), 'export const changed = 1;\n');
    expect(checkWebBundle(publicDir, Date.now() + 120_000).state).toBe('stale');
  });

  it('is missing when the bundle has no build.json (built before the check, or not at all)', () => {
    const { publicDir } = site();
    const result = checkWebBundle(publicDir);
    expect(result.state).toBe('missing');
    expect(result.detail).toContain('npm run build');
  });

  it('says nothing when there are no sources to compare with', () => {
    const root = mkdtempSync(join(tmpdir(), 'web-bundle-'));
    made.push(root);
    mkdirSync(join(root, 'public', 'js'), { recursive: true });
    expect(checkWebBundle(join(root, 'public')).state).toBe('unchecked');
  });
});
