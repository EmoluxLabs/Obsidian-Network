/**
 * A disposable devnet for the end-to-end test: the repository's own launcher (scripts/obsidian-network.sh) starts a real
 * node and a real platform on shifted ports with a throwaway data directory, and the wallet server is started in front.
 *
 * The test holds the mining-gate issuer key. Protocol 1.7.0 refuses a mining claim without a certificate from it, and
 * the claim is how a brand-new devnet wallet gets its first coins, so only the PUBLIC half goes to the node and the
 * private half stays here, to sign the funding claim like a platform operator would. Nothing here touches another network.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, '..', '..', '..');
const imp = (p) => import(pathToFileURL(join(repo, p)).href);

export async function startDevnet({ offset = 400, walletPort = 39191 } = {}) {
  const { generateKeyPair } = await imp('obsidian-core/dist/crypto/keys.js');
  const gate = generateKeyPair('dobs');
  const home = mkdtempSync(join(tmpdir(), 'obswallet-e2e-'));
  const env = {
    ...process.env,
    OBSIDIAN_HOME: home,
    OBSIDIAN_PORT_OFFSET: String(offset),
    OBSIDIAN_NO_GATE_KEY: '1',
    OBSIDIAN_MINING_GATE_PUBLIC_KEYS: gate.publicKey,
    OBSIDIAN_KEYSTORE_PASSPHRASE: 'e2e disposable node key passphrase',
    OBSIDIAN_START_TIMEOUT: '240',
  };
  const script = join(repo, 'scripts', 'obsidian-network.sh');
  const run = spawnSync('bash', [script, 'devnet', 'start'], { env, encoding: 'utf8', timeout: 280_000 });
  if (run.status !== 0) throw new Error(`devnet did not start:\n${run.stdout}\n${run.stderr}`);
  const rpc = 38630 + offset;
  const platform = 38788 + offset;

  const wallet = spawn(process.execPath, [join(repo, 'obsidian-wallet-web', 'scripts', 'start.mjs'), 'devnet'], {
    env: { ...env, APP_PORT: String(walletPort), APP_HOST: '127.0.0.1', OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  wallet.stdout.on('data', (d) => (log += d));
  wallet.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${walletPort}`;
  for (let i = 0; i < 200; i += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not yet */ }
    if (wallet.exitCode !== null) throw new Error(`the wallet server exited:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    rpcUrl: `http://127.0.0.1:${rpc}`,
    gate,
    log: () => log,
    async stop() {
      wallet.kill('SIGTERM');
      spawnSync('bash', [script, 'devnet', 'stop'], { env, encoding: 'utf8', timeout: 60_000 });
      rmSync(home, { recursive: true, force: true });
    },
  };
}
