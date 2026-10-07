/**
 * Interface configuration tests.
 *
 * The interface refuses to start when the site shells are missing, which is the
 * right behaviour — but only if it looks for them in the right place. There are
 * two layouts to support and they point in opposite directions:
 *
 *   checkout          obsidian-interface/  → shells live in the parent (repo root)
 *   self-host release obsidian-interface/  → shells live inside the package
 *
 * Getting this wrong means a downloaded release refuses to boot for a reason the
 * operator cannot see. These tests pin both layouts, and the flag override.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSiteRoot, loadInterfaceConfig, validateInterfaceConfig } from '../server/config.js';
import { DEFAULT_INTERFACE_CONFIG } from '../server/index.js';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-interface-config-'));
  dirs.push(dir);
  return dir;
}

/** Write a minimal site shell so `defaultSiteRoot` has something to find. */
function withShells(root: string): void {
  mkdirSync(join(root, 'landing'), { recursive: true });
  writeFileSync(join(root, 'landing', 'index.html'), '<!doctype html><title>landing</title>', 'utf8');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('site root discovery', () => {
  it('uses the parent directory in a checkout layout', () => {
    const root = scratch();
    const pkg = join(root, 'obsidian-interface');
    mkdirSync(pkg, { recursive: true });
    withShells(root);
    expect(defaultSiteRoot(pkg)).toBe(root);
  });

  it('uses the package directory in a self-contained release', () => {
    const pkg = scratch();
    withShells(pkg);
    expect(defaultSiteRoot(pkg)).toBe(pkg);
  });

  it('prefers the parent when both layouts are present', () => {
    const root = scratch();
    const pkg = join(root, 'obsidian-interface');
    mkdirSync(pkg, { recursive: true });
    withShells(root);
    withShells(pkg);
    expect(defaultSiteRoot(pkg)).toBe(root);
  });

  it('falls back to the parent so a missing build is reported, not hidden', () => {
    const root = scratch();
    const pkg = join(root, 'obsidian-interface');
    mkdirSync(pkg, { recursive: true });
    expect(defaultSiteRoot(pkg)).toBe(root);
  });
});

describe('configuration validation', () => {
  const base = {
    ...DEFAULT_INTERFACE_CONFIG,
    nodeUrls: ['http://127.0.0.1:8630'],
  };

  it('reports a missing site root with the directory it looked in', () => {
    const pkg = scratch();
    const siteRoot = join(pkg, '..');
    const problems = validateInterfaceConfig({
      config: {
        ...base,
        siteRoot,
        publicDir: pkg,
        coreDir: pkg,
      },
      source: 'test',
    });
    expect(problems.some((problem) => problem.includes('site shells missing'))).toBe(true);
    expect(problems.some((problem) => problem.includes(siteRoot))).toBe(true);
  });

  it('accepts a package whose public, core and site directories all exist', () => {
    const pkg = scratch();
    withShells(pkg);
    const problems = validateInterfaceConfig({
      config: {
        ...base,
        network: 'devnet',
        siteRoot: pkg,
        publicDir: pkg,
        coreDir: pkg,
      },
      source: 'test',
    });
    expect(problems).toEqual([]);
  });

  it('always refuses to start without a node to read from', () => {
    const pkg = scratch();
    withShells(pkg);
    const problems = validateInterfaceConfig({
      config: { ...base, siteRoot: pkg, publicDir: pkg, coreDir: pkg, nodeUrls: [] },
      source: 'test',
    });
    expect(problems.some((problem) => problem.includes('no Obsidian Core nodes'))).toBe(true);
  });

  it('honours an explicit --site-root over both layouts', () => {
    const explicit = scratch();
    withShells(explicit);
    const { config } = loadInterfaceConfig(['--site-root', explicit, '--public-dir', explicit, '--core-dir', explicit, '--nodes', 'http://127.0.0.1:8630']);
    expect(config.siteRoot).toBe(explicit);
  });
});
