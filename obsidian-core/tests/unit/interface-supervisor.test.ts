/**
 * The node hosts a supervised interface. These tests run the real supervisor against stand-in interface scripts
 * (a directory with dist/server/main.js), so every state is exercised with a real child process.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterfaceSupervisor, interfaceDisabled, interfacePort, locateInterface } from '../../src/cli/interface-supervisor.js';

const roots: string[] = [];
const running: InterfaceSupervisor[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop(500);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obs-ui-sup-'));
  roots.push(dir);
  return dir;
}
function fakeInterface(script: string): string {
  const dir = scratch();
  mkdirSync(join(dir, 'dist', 'server'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'server', 'main.js'), script);
  return dir;
}
const wait = async (until: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (until()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
};
function make(interfaceDir: string | undefined, extra: Partial<ConstructorParameters<typeof InterfaceSupervisor>[0]> = {}) {
  const logs: string[] = [];
  const sup = new InterfaceSupervisor({
    network: 'devnet',
    nodeUrl: 'http://127.0.0.1:38630',
    nodeDataDir: join(scratch(), 'node'),
    interfaceDir,
    env: { PATH: process.env.PATH ?? '' },
    probe: async () => false,
    backoffMs: () => 5,
    log: (level, message) => logs.push(`${level} ${message}`),
    ...extra,
  });
  running.push(sup);
  return { sup, logs };
}

describe('opting out', () => {
  it('does nothing with --no-interface, and with OBSIDIAN_NODE_ONLY', async () => {
    const marker = join(scratch(), 'started');
    const dir = fakeInterface(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setInterval(() => {}, 1000);`);
    const a = make(dir);
    expect((await a.sup.start(true)).state).toBe('disabled');
    const b = make(dir, { env: { PATH: process.env.PATH ?? '', OBSIDIAN_NODE_ONLY: '1' } });
    expect((await b.sup.start(false)).state).toBe('disabled');
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker)).toBe(false);
    expect(interfaceDisabled(false, { OBSIDIAN_NODE_ONLY: 'true' })).toBe(true);
    expect(interfaceDisabled(false, { OBSIDIAN_NODE_ONLY: '0' })).toBe(false);
    expect(interfaceDisabled(false, {})).toBe(false);
  });
});

describe('finding the interface', () => {
  it('runs the node alone, and says so, when no built interface exists', async () => {
    const { sup, logs } = make(undefined, { coreRoot: join(scratch(), 'core'), env: { PATH: process.env.PATH ?? '', OBSIDIAN_INTERFACE_DIR: join(scratch(), 'nowhere') } });
    const status = await sup.start(false);
    expect(status.state).toBe('not-found');
    expect(status.detail).toMatch(/OBSIDIAN_INTERFACE_DIR.*--no-interface/);
    expect(logs.join('\n')).toMatch(/running the node alone/);
  });

  it('finds it through OBSIDIAN_INTERFACE_DIR, and only when dist/server/main.js is there', () => {
    const good = fakeInterface('');
    const empty = scratch();
    expect(locateInterface({ OBSIDIAN_INTERFACE_DIR: good }, join(scratch(), 'core'))).toBe(good);
    expect(locateInterface({ OBSIDIAN_INTERFACE_DIR: empty }, join(scratch(), 'core'))).toBeUndefined();
  });

  it('finds the interface beside the core', () => {
    const parent = scratch();
    mkdirSync(join(parent, 'obsidian-core'), { recursive: true });
    mkdirSync(join(parent, 'obsidian-interface', 'dist', 'server'), { recursive: true });
    writeFileSync(join(parent, 'obsidian-interface', 'dist', 'server', 'main.js'), '');
    expect(locateInterface({}, join(parent, 'obsidian-core'))).toBe(join(parent, 'obsidian-interface'));
  });
});

describe('ports', () => {
  it('follows the network, the port offset and an explicit override, and refuses a bad override', () => {
    expect(interfacePort('mainnet', 0, {})).toBe(8788);
    expect(interfacePort('testnet', 0, {})).toBe(18788);
    expect(interfacePort('devnet', 4, {})).toBe(38792);
    expect(interfacePort('devnet', 4, { OBSIDIAN_INTERFACE_PORT: '9000' })).toBe(9000);
    expect(() => interfacePort('devnet', 0, { OBSIDIAN_INTERFACE_PORT: 'abc' })).toThrow();
    expect(() => interfacePort('devnet', 0, { OBSIDIAN_INTERFACE_PORT: '70000' })).toThrow();
    expect(() => interfacePort('nowhere', 0, {})).toThrow();
  });
});

describe('running and supervising', () => {
  it('does not start a second interface when one already answers on the port', async () => {
    const marker = join(scratch(), 'started');
    const dir = fakeInterface(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
    const { sup } = make(dir, { probe: async () => true });
    const status = await sup.start(false);
    expect(status.state).toBe('already-running');
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker)).toBe(false);
  });

  it('starts it with the node network, port, node URL and a data directory beside the node data', async () => {
    const out = join(scratch(), 'argv.json');
    const dir = fakeInterface(
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), net: process.env.OBSIDIAN_INTERFACE_NETWORK, legacy: process.env.OBSIDIAN_NETWORK ?? null, gate: process.env.OBSIDIAN_GATE_KEYSTORE ?? null, cwd: process.cwd() })); setInterval(() => {}, 1000);`,
    );
    const nodeData = join(scratch(), 'mainnet', 'node');
    const { sup } = make(dir, {
      nodeDataDir: nodeData,
      env: { PATH: process.env.PATH ?? '', OBSIDIAN_NETWORK: 'mainnet', OBSIDIAN_GATE_KEYSTORE: '/keys/gate.json' },
    });
    expect((await sup.start(false)).state).toBe('running');
    await wait(() => existsSync(out));
    const seen = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; net: string; legacy: string | null; gate: string; cwd: string };
    expect(seen.argv).toEqual(['--network', 'devnet', '--port', '38788', '--nodes', 'http://127.0.0.1:38630', '--data-dir', join(nodeData, '..', 'interface')].map((v) => v));
    expect(seen.net).toBe('devnet');
    expect(seen.legacy).toBeNull(); // a shell's leftover network must not contradict the node's
    expect(seen.gate).toBe('/keys/gate.json'); // the operator's gate settings reach the interface untouched
  });

  it('restarts it after a crash, and counts the restarts', async () => {
    const counter = join(scratch(), 'count');
    const dir = fakeInterface(
      `const fs = require('fs'); const c = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0; fs.writeFileSync(${JSON.stringify(counter)}, String(c + 1)); if (c < 2) process.exit(1); setInterval(() => {}, 1000);`,
    );
    const { sup, logs } = make(dir);
    await sup.start(false);
    await wait(() => sup.status().restarts >= 2 && sup.status().state === 'running' && Number(readFileSync(counter, 'utf8')) >= 3);
    expect(sup.status().restarts).toBe(2);
    expect(logs.filter((l) => l.includes('interface exited: restarting'))).toHaveLength(2);
  });

  it('gives up after repeated failures, loudly, instead of spinning for ever', async () => {
    const dir = fakeInterface('process.stderr.write("cannot bind port\\n"); process.exit(3);');
    const { sup, logs } = make(dir);
    await sup.start(false);
    await wait(() => sup.status().state === 'gave-up');
    expect(sup.status().detail).toMatch(/not retrying.*node is unaffected/);
    expect(logs.join('\n')).toMatch(/\[interface\] cannot bind port/);
    const restarts = sup.status().restarts;
    await new Promise((r) => setTimeout(r, 200));
    expect(sup.status().restarts).toBe(restarts); // really stopped
  });

  it('stops the child on stop(), and does not bring it back', async () => {
    const pidFile = join(scratch(), 'pid');
    const dir = fakeInterface(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const { sup } = make(dir);
    await sup.start(false);
    await wait(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await sup.stop();
    expect(() => process.kill(pid, 0)).toThrow(); // gone
    expect(sup.status().state).toBe('stopped');
    await new Promise((r) => setTimeout(r, 200));
    expect(sup.status().restarts).toBe(0);
  });

  it('kills a child that ignores SIGTERM after the grace period', async () => {
    const pidFile = join(scratch(), 'pid');
    const dir = fakeInterface(`process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const { sup } = make(dir);
    await sup.start(false);
    await wait(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const began = Date.now();
    await sup.stop(300);
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('stop() during the restart delay cancels the restart', async () => {
    const counter = join(scratch(), 'count');
    const dir = fakeInterface(`const fs = require('fs'); const f = ${JSON.stringify(counter)}; fs.writeFileSync(f, String((fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1)); process.exit(1);`);
    const { sup } = make(dir, { backoffMs: () => 400 });
    await sup.start(false);
    await wait(() => sup.status().state === 'restarting');
    await sup.stop();
    await new Promise((r) => setTimeout(r, 700));
    expect(readFileSync(counter, 'utf8')).toBe('1');
  });
});
