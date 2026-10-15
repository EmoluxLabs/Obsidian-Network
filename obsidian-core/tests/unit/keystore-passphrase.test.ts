/**
 * Where the node key's passphrase may come from (protocol 1.9.0): the environment, a file the environment names, or a
 * hidden prompt on a real terminal. Never a generated value, never a file kept beside the keystore, on ANY network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keystore, keystorePassphraseFromEnv, promptKeystorePassphrase, resolveKeystorePassphrase } from '../../src/crypto/keystore.js';
import { startNode } from '../../src/node.js';
import { loadConfig } from '../../src/config/config.js';

const saved = { ...process.env };
let dir: string;

beforeEach(() => {
  delete process.env.OBSIDIAN_KEYSTORE_PASSPHRASE;
  delete process.env.OBSIDIAN_KEYSTORE_PASSPHRASE_FILE;
  dir = mkdtempSync(join(tmpdir(), 'obsidian-pass-'));
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

describe('the keystore passphrase has exactly the sources the operator controls', () => {
  it('reads the environment, and a file the environment names', async () => {
    process.env.OBSIDIAN_KEYSTORE_PASSPHRASE = 'an-operator-chosen-passphrase';
    expect(keystorePassphraseFromEnv()).toBe('an-operator-chosen-passphrase');
    expect(await resolveKeystorePassphrase({ creating: true })).toBe('an-operator-chosen-passphrase');
    delete process.env.OBSIDIAN_KEYSTORE_PASSPHRASE;
    const file = join(dir, 'mine.pass');
    writeFileSync(file, 'a-passphrase-from-a-file-i-made\n', { mode: 0o600 });
    process.env.OBSIDIAN_KEYSTORE_PASSPHRASE_FILE = file;
    expect(await resolveKeystorePassphrase({ creating: false })).toBe('a-passphrase-from-a-file-i-made');
  });

  it('refuses a short passphrase and never echoes it', () => {
    process.env.OBSIDIAN_KEYSTORE_PASSPHRASE = 'short-one';
    try {
      keystorePassphraseFromEnv();
      throw new Error('a short passphrase was accepted');
    } catch (error) {
      expect((error as Error).message).toMatch(/at least 12 characters/);
      expect((error as Error).message).not.toContain('short-one');
    }
  });

  it('with nothing given and no terminal, it refuses: nothing is generated, nothing is written', async () => {
    // vitest has no TTY on stdin, exactly like a service or a container.
    expect(await promptKeystorePassphrase('x')).toBeUndefined();
    await expect(resolveKeystorePassphrase({ creating: true })).rejects.toThrow(/never generates a passphrase/);
    await expect(resolveKeystorePassphrase({ creating: false })).rejects.toThrow(/No terminal is attached/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(['devnet', 'testnet', 'staging', 'mainnet'])('a node on %s will not start without a passphrase, and leaves no .pass file', async (network) => {
    const dataDir = join(dir, network);
    const loaded = loadConfig({ env: {}, overrides: { network, dataDir, rpcEnabled: false, logLevel: 'error' } as never });
    await expect(startNode({ ...loaded, offline: true })).rejects.toThrow(/passphrase/);
    expect(existsSync(`${loaded.config.keystorePath}.pass`)).toBe(false);
    expect(existsSync(loaded.config.keystorePath)).toBe(false);
    const everything = existsSync(dataDir) ? readdirSync(dataDir, { recursive: true }).map(String) : [];
    expect(everything.filter((name) => name.endsWith('.pass'))).toEqual([]);
  });

  it('a keystore made with one passphrase opens only with that one', () => {
    const path = join(dir, 'node-key.json');
    Keystore.create(path, 'the-right-passphrase-1');
    expect(() => Keystore.read(path, 'the-wrong-passphrase-2')).toThrow();
    expect(() => Keystore.read(path, 'the-right-passphrase-1')).not.toThrow();
  });
});
