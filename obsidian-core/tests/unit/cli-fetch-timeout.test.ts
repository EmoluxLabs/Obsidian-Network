/**
 * The CLI's reads of a node are bounded: a node that accepts the connection and never answers (hung, or something else
 * listening on the port) must make `health` and `finality` fail, not hang the terminal (audit finding #7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { httpGetJson } from '../../src/cli/ops.js';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
let server: Server;
let port: number;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer(() => {
    /* accept the request and never answer */
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((done) => server.close(() => done()));
});

function cli(args: string[], timeoutMs: number): Promise<{ code: number | null; ms: number; stderr: string; killed: boolean }> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, OBSIDIAN_NODE_ONLY: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let killed = false;
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, ms: Date.now() - started, stderr, killed });
    });
  });
}

describe('bounded CLI reads', () => {
  it('httpGetJson gives up on a server that never answers', async () => {
    const started = Date.now();
    await expect(httpGetJson(`http://127.0.0.1:${port}/health`, { timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  for (const command of ['health', 'finality']) {
    it(`\`${command}\` fails after its own timeout instead of hanging`, async () => {
      if (!existsSync(CLI)) return;
      const result = await cli([command, '--network', 'devnet', '--rpc-port', String(port)], 25_000);
      expect(result.killed, 'the command had to be killed: it did not time out by itself').toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.ms).toBeLessThan(20_000);
    }, 40_000);
  }
});
