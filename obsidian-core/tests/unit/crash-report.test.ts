/**
 * When the node dies from an error nobody handled, the operator is told why, once, in one line, with a distinct exit
 * status. These tests use an injected `exit`, so they never end the test process.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { describeCrash, EXIT_UNHANDLED, installCrashReporting } from '../../src/crash-report.js';

function harness() {
  const target = new EventEmitter();
  const written: string[] = [];
  const exits: number[] = [];
  const remove = installCrashReporting({
    target: target as never,
    write: (line) => void written.push(line),
    exit: (code) => void exits.push(code),
    now: () => Date.UTC(2026, 9, 19, 12, 0, 0),
    uptime: () => 3_725.4,
    memory: () => ({ rss: 300 * 1_048_576, heapUsed: 120 * 1_048_576 }),
  });
  return { target, written, exits, remove };
}

describe('crash reporting', () => {
  it('names an unhandled rejection, with its stack, and exits 70', () => {
    const { target, written, exits } = harness();
    target.emit('unhandledRejection', Object.assign(new Error('sync exploded'), { code: 'ERR_X' }));
    expect(exits).toEqual([70]);
    expect(EXIT_UNHANDLED).toBe(70);
    expect(written).toHaveLength(1);
    const line = JSON.parse(written[0]!);
    expect(line).toMatchObject({ level: 'fatal', kind: 'unhandledRejection', error: 'sync exploded', code: 'ERR_X', uptimeSeconds: 3725, rssMb: 300, heapMb: 120, exitCode: 70 });
    expect(line.message).toContain('unhandled promise rejection');
    expect(line.stack).toContain('crash-report.test');
    expect(line.time).toBe('2026-10-19T12:00:00.000Z');
  });

  it('names an uncaught exception and exits 70', () => {
    const { target, written, exits } = harness();
    target.emit('uncaughtException', new TypeError('boom'));
    expect(exits).toEqual([70]);
    expect(JSON.parse(written[0]!).kind).toBe('uncaughtException');
  });

  it('copes with a rejection that is not an Error, and reports a second error only once', () => {
    const { target, written, exits } = harness();
    target.emit('unhandledRejection', 'a bare string');
    target.emit('unhandledRejection', undefined);
    expect(JSON.parse(written[0]!).error).toBe('a bare string');
    expect(written).toHaveLength(1);
    expect(exits).toEqual([70]);
  });

  it('bounds the line it writes and leaves no key or environment value in it', () => {
    const line = describeCrash('uncaughtException', new Error('x'.repeat(5_000)), { at: 0, uptimeSeconds: 1, rssMb: 1, heapMb: 1 });
    expect(line.length).toBeLessThan(2_600);
    expect(line).not.toMatch(/OBSIDIAN_KEYSTORE_PASSPHRASE|privateKey/);
  });

  it('can be removed', () => {
    const { target, written, remove } = harness();
    remove();
    expect(target.listenerCount('unhandledRejection')).toBe(0);
    expect(target.listenerCount('uncaughtException')).toBe(0);
    expect(written).toEqual([]);
  });
});
