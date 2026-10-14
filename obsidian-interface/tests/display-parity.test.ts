// @vitest-environment jsdom
/**
 * The interface's numbers and identifiers, checked against the shared vectors (tests/vectors/display.json) that the
 * core, the Web App and the wallet also run. One list of expectations, four implementations: a page that prints
 * "0.050000000000000000" or "0" for a real amount fails here before it reaches a screen.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { amountEl, count, obs, obsDecimal, obsExact, obsUnit } from '../web/src/lib/ui.js';
import { copyIdentifier, identifier } from '../web/src/lib/identifier.js';
import { describeMiningPool, shortenIdentifier } from '../web/core/protocol/display.js';

const vectors = JSON.parse(readFileSync(resolve(__dirname, '../../tests/vectors/display.json'), 'utf8'));

describe('shared numeric vectors through the interface entry points', () => {
  for (const v of vectors.obs as Array<{ in: string; opts?: { maxDecimals?: number; group?: boolean }; kind?: string; out: string }>) {
    if (v.kind === 'decimal' || (v.opts && 'group' in v.opts)) continue; // ungrouped output is a core option; the interface always groups; `decimal` vectors go through obsDecimal below
    it(`obs(${JSON.stringify(v.in)}, ${JSON.stringify(v.opts ?? {})}) → ${v.out}`, () => {
      expect(obs(v.in, v.opts?.maxDecimals)).toBe(v.out);
    });
  }
  for (const v of vectors.obs as Array<{ in: string; opts?: { maxDecimals?: number; group?: boolean }; kind?: string; out: string }>) {
    if (v.kind !== 'decimal' || (v.opts && 'group' in v.opts)) continue;
    it(`obsDecimal(${JSON.stringify(v.in)}, ${JSON.stringify(v.opts ?? {})}) → ${v.out}`, () => {
      expect(obsDecimal(v.in, v.opts?.maxDecimals)).toBe(v.out);
    });
  }
  it('adds the unit, and never prints a unit next to an unavailable value', () => {
    expect(obsUnit('0')).toBe('0 OBS');
    expect(obsUnit('50000000000000000')).toBe('0.05 OBS');
    expect(obsUnit('0.050000000000000000')).toBe('0.05 OBS');
    expect(obsUnit('21000000000000000000000000')).toBe('21,000,000 OBS');
    expect(obsUnit('100000.000000000000000000')).toBe('100,000 OBS');
    expect(obsUnit('1')).toBe('<0.000001 OBS');
    expect(obsUnit('1', 18)).toBe('0.000000000000000001 OBS');
    expect(obsUnit('99999.820626666666666664')).toBe('99,999.820627 OBS');
    expect(obsUnit(undefined)).toBe('—');
  });
  it('counts with commas and never uses a locale', () => {
    for (const v of vectors.integers as Array<{ in: string | number; out: string }>) expect(count(v.in)).toBe(v.out);
  });
});

describe('identifier component', () => {
  const address = 'obs1ijdnq8k3m5x7v9c2z4b6n8t0w2e4r6y8slvgsi';

  it('shows the short form on narrow and the long form on wide, from one canonical value', () => {
    const node = identifier(address, { kind: 'address' });
    expect(node.querySelector('.idv-s')?.textContent).toBe(shortenIdentifier(address, 'address', 'narrow'));
    expect(node.querySelector('.idv-m')?.textContent).toBe(shortenIdentifier(address, 'address', 'wide'));
    expect(node.querySelector('.idv-s')?.textContent).toMatch(/^obs1ijdn\.\.\.slvgsi$/);
    expect(node.querySelector('.idv-f')?.textContent).toBe(address);
    expect(node.querySelector('.idv-text')?.getAttribute('title')).toBe(address);
  });

  it('is announced in full to screen readers; the visual forms are hidden from them', () => {
    const node = identifier(address, { kind: 'address' });
    expect(node.querySelector('.idv-text')?.getAttribute('aria-label')).toContain(address);
    for (const cls of ['.idv-s', '.idv-m', '.idv-f']) expect(node.querySelector(cls)?.getAttribute('aria-hidden')).toBe('true');
    expect(node.querySelector('button')?.getAttribute('aria-label')).toBe('Copy wallet address');
  });

  it('copies the FULL original value, not the shortened text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const node = identifier(address, { kind: 'address' });
    document.body.append(node);
    (node.querySelector('button.idv-copy') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(address);
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('...'));
    node.remove();
  });

  it('reports a blocked clipboard instead of pretending it copied', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('no')) }, configurable: true });
    expect(await copyIdentifier(address, 'Wallet address')).toBe(false);
  });

  it('taps open to the full value and folds back', () => {
    const node = identifier(address, { kind: 'address' });
    const text = node.querySelector('.idv-text') as HTMLElement;
    expect(text.getAttribute('aria-expanded')).toBe('false');
    text.click();
    expect(node.classList.contains('idv-open')).toBe(true);
    expect(text.getAttribute('aria-expanded')).toBe('true');
    text.click();
    expect(node.classList.contains('idv-open')).toBe(false);
  });

  it('a detail identifier is always the whole value and offers copy', () => {
    const node = identifier(address, { kind: 'address', detail: true });
    expect(node.classList.contains('idv-detail')).toBe(true);
    expect(node.querySelector('button.idv-copy')).not.toBeNull();
  });

  it('leaves a node-masked value as it came and offers no copy of a truncated string', () => {
    const node = identifier('obs1ab…wxyz', { kind: 'address' });
    expect(node.querySelector('.idv-f')?.textContent).toBe('obs1ab…wxyz');
    expect(node.querySelector('button')).toBeNull();
  });

  it('an identifier link keeps the full value in the href and only shortens the text', () => {
    const hash = 'a'.repeat(64);
    const node = identifier(hash, { kind: 'hash', href: `#/block/${hash}`, copy: false });
    const a = node.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(`#/block/${hash}`);
    expect(a.querySelector('.idv-s')?.textContent).not.toBe(hash);
  });

  it('a missing value is the unavailable mark', () => {
    expect(identifier(undefined).textContent).toBe('—');
    expect(identifier('').textContent).toBe('—');
  });
});

describe('amount element and exact view', () => {
  it('shows the 6-decimal text and carries the exact value in the tooltip', () => {
    const node = amountEl('99999.820626666666666664');
    expect(node.textContent).toBe('99,999.820627 OBS');
    expect(node.title).toBe('Exact: 99,999.820626666666666664 OBS');
    expect(obsExact('166666666666666')).toBe('0.000166666666666666 OBS');
  });
  it('has no tooltip when there is nothing more to say, and none for a missing value', () => {
    expect(amountEl('12.340000000000000000').title).toBe('');
    expect(amountEl(undefined).textContent).toBe('—');
    expect(amountEl(undefined).title).toBe('');
  });
});

describe('Mining Pool view through the synced core module (shared vectors)', () => {
  const poolVectors = JSON.parse(readFileSync(resolve(__dirname, '../../tests/vectors/mining-pool.json'), 'utf8'));
  for (const c of poolVectors.cases as Array<{ name: string; input: Parameters<typeof describeMiningPool>[0]; expect: Record<string, unknown> }>) {
    it(c.name, () => {
      const view = describeMiningPool(c.input) as unknown as Record<string, unknown>;
      for (const [key, want] of Object.entries(c.expect)) expect(view[key], key).toEqual(want);
    });
  }
});
