import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { RpcClient } from '../core/rpc-client.js';
import { AppError } from '../shared/errors.js';
import { freeOffset, makeSupervisor, tempDir } from './helpers.js';

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('supervisor: refuses to create a new chain without confirmation', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { supervisor } = makeSupervisor(dir, 60);
    await assert.rejects(supervisor.start(), (e: unknown) => e instanceof AppError && e.code === 'NEW_CHAIN_CONFIRMATION_REQUIRED');
    assert.equal(supervisor.state().phase, 'failed');
    assert.equal(supervisor.state().chainDataPresent, false);
  } finally {
    cleanup();
  }
});

test('supervisor: refuses a port that is already taken', async () => {
  const { dir, cleanup } = tempDir();
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(38631 + 71, '0.0.0.0', r));
  try {
    const { supervisor } = makeSupervisor(dir, 71);
    await assert.rejects(supervisor.start({ confirmNewChain: true }), (e: unknown) => e instanceof AppError && e.code === 'PORT_IN_USE');
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
    cleanup();
  }
});

test('supervisor: starts a real devnet node, reports running only once /health answers, stops cleanly, leaves no process', { timeout: 120_000 }, async () => {
  const { dir, cleanup } = tempDir();
  const { supervisor, paths, logs } = makeSupervisor(dir, await freeOffset(82));
  try {
    const phases: string[] = [];
    supervisor.on('state', (s: { phase: string }) => phases.push(s.phase));
    const started = await supervisor.start({ confirmNewChain: true });
    assert.equal(started.phase, 'running');
    assert.ok(started.pid);
    const pid = started.pid;
    const client = new RpcClient({ baseUrl: started.rpcUrl });
    const health = await client.health();
    assert.equal(health.network, 'devnet');
    assert.equal(health.chainId, 7780);
    assert.equal(started.rpcPort, 38630 + 82);
    // a second start must be refused while running (no duplicate DB access)
    await assert.rejects(supervisor.start({ confirmNewChain: true }), (e: unknown) => e instanceof AppError && e.code === 'NODE_ACTIVE');
    assert.ok(phases.indexOf('starting') < phases.indexOf('running'));

    const stopped = await supervisor.stop();
    assert.equal(stopped.phase, 'stopped');
    assert.equal(processExists(pid), false, 'node process must be gone');
    assert.equal(existsSync(`${paths.forNetwork('devnet').dataDir}/LOCK`), false, 'data directory lock must be released');
    assert.ok(logs.recent().some((e) => e.message.includes('stopped cleanly')), 'the core logged a clean shutdown');
    await assert.rejects(client.health(), /could not reach/);

    // restart on existing data needs no new-chain confirmation, and keeps the same chain
    const again = await supervisor.start();
    assert.equal(again.phase, 'running');
    assert.equal((await new RpcClient({ baseUrl: again.rpcUrl }).health()).genesisId, health.genesisId);
  } finally {
    await supervisor.dispose();
    cleanup();
  }
});

test('supervisor: an unexpected node exit is reported as failed, not running', { timeout: 120_000 }, async () => {
  const { dir, cleanup } = tempDir();
  const { supervisor } = makeSupervisor(dir, await freeOffset(93));
  try {
    const started = await supervisor.start({ confirmNewChain: true });
    process.kill(started.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 1500));
    const state = supervisor.state();
    assert.equal(state.phase, 'failed');
    assert.equal(state.error?.code, 'NODE_CRASHED');
    assert.equal(state.pid, undefined);
  } finally {
    await supervisor.dispose();
    cleanup();
  }
});
