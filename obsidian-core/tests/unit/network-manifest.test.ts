/**
 * The network manifest, `init` and `join`.
 *
 * What these pin down:
 *   - init is deterministic and idempotent, and never replaces an existing identity or a gate authority key;
 *   - a directory keeps the identity it was created with: a different gate list, network or protocol is refused
 *     by name, and a missing setting is filled from the manifest instead of silently creating a different chain;
 *   - a corrupt manifest is an error, never "no manifest";
 *   - `join` accepts a peer's keys ONLY if they reproduce the genesis id the operator pinned out of band, and
 *     writes nothing on any failure.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type LoadedConfig } from '../../src/config/config.js';
import {
  NetworkIdentityError,
  buildManifest,
  deriveGenesis,
  initNetwork,
  joinNetwork,
  manifestPath,
  readManifest,
  resolveIdentity,
  verifyPeerGenesis,
  writeManifest,
} from '../../src/config/network-manifest.js';
import { generateKeyPair } from '../../src/crypto/keys.js';
import { getNetwork } from '../../src/protocol/networks.js';

const NET = getNetwork('devnet');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'obs-manifest-'));
  roots.push(root);
  return root;
}

function loadedFor(root: string, overrides: Partial<LoadedConfig['config']> = {}): LoadedConfig {
  const dataDir = join(root, 'data', 'devnet');
  return {
    config: { ...DEFAULT_CONFIG, network: 'devnet', dataDir, keystorePath: join(dataDir, 'node-key.json'), ...overrides },
    net: NET,
    source: 'test',
    warnings: [],
  };
}

const pub = (): string => generateKeyPair().publicKey;
const PASS = 'a-long-enough-test-passphrase';

describe('init', () => {
  it('creates the manifest once and is a no-op the second time', () => {
    const loaded = loadedFor(scratch(), { miningGatePublicKeys: [pub()] });
    const first = initNetwork(loaded);
    expect(first.state).toBe('created');
    const bytes = readFileSync(manifestPath(loaded.config.dataDir), 'utf8');
    const second = initNetwork(loaded);
    expect(second.state).toBe('existing');
    expect(second.genesisId).toBe(first.genesisId);
    expect(readFileSync(manifestPath(loaded.config.dataDir), 'utf8')).toBe(bytes);
  });

  it('is deterministic: the same inputs give the same genesis id on any machine', () => {
    const gate = pub();
    const a = initNetwork(loadedFor(scratch(), { miningGatePublicKeys: [gate] }));
    const b = initNetwork(loadedFor(scratch(), { miningGatePublicKeys: [gate] }));
    expect(a.genesisId).toBe(b.genesisId);
    expect(a.genesisHash).toBe(b.genesisHash);
    expect(a.genesisId).toBe(deriveGenesis(NET, [], [gate]).genesisId);
  });

  it('refuses a different gate list on a directory that already has an identity, and changes nothing', () => {
    const root = scratch();
    const loaded = loadedFor(root, { miningGatePublicKeys: [pub()] });
    const created = initNetwork(loaded);
    const before = readFileSync(manifestPath(loaded.config.dataDir), 'utf8');
    const other = loadedFor(root, { miningGatePublicKeys: [pub()] });
    expect(() => initNetwork(other)).toThrow(NetworkIdentityError);
    expect(() => initNetwork(other)).toThrow(/differ from the ones this data directory was created with/);
    expect(() => initNetwork(other)).toThrow(new RegExp(created.genesisId));
    expect(readFileSync(manifestPath(loaded.config.dataDir), 'utf8')).toBe(before);
  });

  it('refuses a data directory that belongs to another network', () => {
    const root = scratch();
    const loaded = loadedFor(root);
    initNetwork(loaded);
    const testnet: LoadedConfig = { ...loaded, net: getNetwork('testnet'), config: { ...loaded.config, network: 'testnet' } };
    expect(() => initNetwork(testnet)).toThrow(/Networks never share a data directory/);
  });

  it('refuses to create a corrupt-manifest directory over, and names the file', () => {
    const loaded = loadedFor(scratch());
    mkdirSync(loaded.config.dataDir, { recursive: true });
    writeFileSync(manifestPath(loaded.config.dataDir), '{ not json');
    expect(() => initNetwork(loaded)).toThrow(/not valid JSON/);
    expect(readFileSync(manifestPath(loaded.config.dataDir), 'utf8')).toBe('{ not json');
  });

  it('rejects a manifest whose fields were edited into nonsense', () => {
    const loaded = loadedFor(scratch(), { miningGatePublicKeys: [pub()] });
    initNetwork(loaded);
    const path = manifestPath(loaded.config.dataDir);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    for (const edit of [
      { genesisId: 'abc' },
      { genesisHash: 'zz' },
      { miningGatePublicKeys: ['not-a-key'] },
      { manifestVersion: 99 },
      { chainId: 'x' },
    ]) {
      writeFileSync(path, JSON.stringify({ ...doc, ...edit }));
      expect(() => readManifest(loaded.config.dataDir), JSON.stringify(edit)).toThrow(NetworkIdentityError);
    }
  });

  it('refuses a manifest whose recorded keys no longer derive the recorded genesis id', () => {
    const loaded = loadedFor(scratch(), { miningGatePublicKeys: [pub()] });
    initNetwork(loaded);
    const path = manifestPath(loaded.config.dataDir);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    // A key swapped in by hand, with the old id left in place: the id must not be trusted over the keys.
    writeFileSync(path, JSON.stringify({ ...doc, miningGatePublicKeys: [pub()] }));
    expect(() => resolveIdentity(loadedFor(roots[roots.length - 1]!))).toThrow(/derives genesis id/);
  });
});

describe('adoption on start', () => {
  it('fills the keys in from the manifest when the operator supplies none', () => {
    const gate = pub();
    const root = scratch();
    initNetwork(loadedFor(root, { miningGatePublicKeys: [gate] }));
    const identity = resolveIdentity(loadedFor(root));
    expect(identity.state).toBe('existing');
    expect(identity.loaded.config.miningGatePublicKeys).toEqual([gate]);
    expect(identity.adopted).toContain('mining gate keys');
  });

  it('a start with no keys on a new directory is "new" (the legacy behaviour), and with chain data but no manifest is "existing-unrecorded"', () => {
    const root = scratch();
    expect(resolveIdentity(loadedFor(root)).state).toBe('new');
    const loaded = loadedFor(root);
    mkdirSync(join(loaded.config.dataDir, 'chain'), { recursive: true });
    writeFileSync(join(loaded.config.dataDir, 'chain', 'blocks.dat'), 'x');
    expect(resolveIdentity(loaded).state).toBe('existing-unrecorded');
  });

  it('a manifest written for protocol X is refused if this build derives a different genesis id from it', () => {
    const root = scratch();
    const loaded = loadedFor(root, { miningGatePublicKeys: [pub()] });
    const derived = deriveGenesis(NET, [], loaded.config.miningGatePublicKeys);
    const manifest = buildManifest(NET, derived, { kind: 'start' });
    writeManifest(loaded.config.dataDir, { ...manifest, genesisId: 'b'.repeat(40) });
    expect(() => resolveIdentity(loaded)).toThrow(/different network/);
  });
});

describe('the gate authority key', () => {
  it('is generated encrypted, outside the data directory, with a private key that is not in the manifest or the result', () => {
    const root = scratch();
    const loaded = loadedFor(root);
    const result = initNetwork(loaded, { generateGateKey: true, gatePassphrase: PASS });
    expect(result.gateAuthority?.generated).toBe(true);
    const file = result.gateAuthority!.keystore;
    expect(file.startsWith(loaded.config.dataDir)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o077).toBe(0);
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toContain(PASS);
    expect(result.miningGatePublicKeys).toEqual([result.gateAuthority!.publicKey]);
    const publicOutput = JSON.stringify(result) + readFileSync(manifestPath(loaded.config.dataDir), 'utf8');
    expect(publicOutput).not.toMatch(/privateKey|secretKey|ciphertext|salt/i);
    // The manifest and the genesis it implies carry the public key.
    expect(readManifest(loaded.config.dataDir)!.miningGatePublicKeys).toEqual([result.gateAuthority!.publicKey]);
  });

  it('is never regenerated: re-running the same command changes nothing and keeps the same key', () => {
    const root = scratch();
    const loaded = loadedFor(root);
    const first = initNetwork(loaded, { generateGateKey: true, gatePassphrase: PASS });
    const keystoreBytes = readFileSync(first.gateAuthority!.keystore, 'utf8');
    const second = initNetwork(loaded, { generateGateKey: true, gatePassphrase: PASS });
    expect(second.state).toBe('existing');
    expect(second.genesisId).toBe(first.genesisId);
    expect(second.gateAuthority).toBeUndefined();
    expect(readFileSync(first.gateAuthority!.keystore, 'utf8')).toBe(keystoreBytes);
  });

  it('will not overwrite a keystore file that is already there', () => {
    const root = scratch();
    const loaded = loadedFor(root);
    const gateDir = join(root, 'gate');
    mkdirSync(gateDir, { recursive: true });
    const target = join(gateDir, 'devnet-mining-gate.keystore.json');
    writeFileSync(target, 'precious');
    expect(() => initNetwork(loaded, { generateGateKey: true, gatePassphrase: PASS, gateDir })).toThrow(NetworkIdentityError);
    expect(readFileSync(target, 'utf8')).toBe('precious');
    expect(existsSync(manifestPath(loaded.config.dataDir))).toBe(false);
  });

  it('requires a passphrase of at least 12 characters and writes nothing without it', () => {
    const root = scratch();
    const loaded = loadedFor(root);
    expect(() => initNetwork(loaded, { generateGateKey: true, gatePassphrase: 'short' })).toThrow(/at least 12 characters/);
    expect(existsSync(manifestPath(loaded.config.dataDir))).toBe(false);
    expect(existsSync(join(loaded.config.dataDir, '..', 'gate-authority'))).toBe(false);
  });

  it('cannot be added to a directory that already holds chain data or no-gate identity', () => {
    const root = scratch();
    const loaded = loadedFor(root);
    initNetwork(loaded); // no gate key: part of this genesis forever
    expect(() => initNetwork(loaded, { generateGateKey: true, gatePassphrase: PASS })).toThrow(/cannot be added afterwards/);
  });

  it('refuses to generate a second authority when gate keys are already configured', () => {
    const loaded = loadedFor(scratch(), { miningGatePublicKeys: [pub()] });
    expect(() => initNetwork(loaded, { generateGateKey: true, gatePassphrase: PASS })).toThrow(/already configured/);
  });
});

// ── join ───────────────────────────────────────────────────────────────────

function peerReply(gate: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const derived = deriveGenesis(NET, [], gate);
  return { document: derived.document, genesisId: derived.genesisId, chainId: NET.chainId, networkId: NET.networkId, ...overrides };
}

describe('verifyPeerGenesis: the pin is the only root of trust', () => {
  const gate = pub();
  const pinned = deriveGenesis(NET, [], [gate]).genesisId;

  it('accepts a document that reproduces the pinned id', () => {
    expect(verifyPeerGenesis(NET, peerReply([gate]), pinned).genesisId).toBe(pinned);
  });

  it('rejects a peer that swaps in its own gate key, even though its own id field is self-consistent', () => {
    expect(() => verifyPeerGenesis(NET, peerReply([pub()]), pinned)).toThrow(/pinned/);
  });

  it('rejects a document whose key list was tampered with while the old id was kept', () => {
    const reply = peerReply([gate]) as { document: { miningGatePublicKeys: string[] } };
    reply.document.miningGatePublicKeys = [pub()];
    expect(() => verifyPeerGenesis(NET, reply, pinned)).toThrow(NetworkIdentityError);
  });

  it('rejects an extra key appended to the list', () => {
    const reply = peerReply([gate]) as { document: { miningGatePublicKeys: string[] } };
    reply.document.miningGatePublicKeys = [gate, pub()];
    expect(() => verifyPeerGenesis(NET, reply, pinned)).toThrow(/pinned/);
  });

  it('rejects a peer on another chain or network id', () => {
    const wrongChain = peerReply([gate]) as { document: Record<string, unknown> };
    wrongChain.document = { ...wrongChain.document, chainId: 9999 };
    expect(() => verifyPeerGenesis(NET, wrongChain, pinned)).toThrow(/not devnet|chain/);
    const wrongNet = peerReply([gate]) as { document: Record<string, unknown> };
    wrongNet.document = { ...wrongNet.document, networkId: 'obsidian-other-1' };
    expect(() => verifyPeerGenesis(NET, wrongNet, pinned)).toThrow(/obsidian-other-1/);
  });

  it('rejects a different protocol version', () => {
    const reply = peerReply([gate]) as { document: Record<string, unknown> };
    reply.document = { ...reply.document, protocolVersion: '0.0.1' };
    expect(() => verifyPeerGenesis(NET, reply, pinned)).toThrow(/protocol 0\.0\.1/);
  });

  it('rejects malformed key material and a missing document', () => {
    const reply = peerReply([gate]) as { document: Record<string, unknown> };
    reply.document = { ...reply.document, miningGatePublicKeys: ['zzzz'] };
    expect(() => verifyPeerGenesis(NET, reply, pinned)).toThrow(/unusable keys/);
    expect(() => verifyPeerGenesis(NET, {}, pinned)).toThrow(/did not return a genesis document/);
  });

  it('rejects a pin that is not 40 lowercase-hex characters (no trust on first use)', () => {
    for (const bad of ['', 'abc', 'G'.repeat(40), pinned.slice(1)]) {
      expect(() => verifyPeerGenesis(NET, peerReply([gate]), bad)).toThrow(/40 lowercase hex/);
    }
  });

  it('rejects a peer whose own genesisId field disagrees with its document', () => {
    expect(() => verifyPeerGenesis(NET, peerReply([gate], { genesisId: 'c'.repeat(40) }), pinned)).toThrow(/does not match the document/);
  });
});

describe('join', () => {
  const gate = pub();
  const pinned = deriveGenesis(NET, [], [gate]).genesisId;

  it('writes the manifest only after verification, learning only public keys', async () => {
    const loaded = loadedFor(scratch());
    const urls: string[] = [];
    const result = await joinNetwork(loaded, {
      peer: 'http://203.0.113.5:18630/',
      pinnedGenesisId: pinned,
      fetchJson: async (url) => {
        urls.push(url);
        return peerReply([gate]);
      },
    });
    expect(urls).toEqual(['http://203.0.113.5:18630/genesis']);
    expect(result.state).toBe('created');
    const manifest = readManifest(loaded.config.dataDir)!;
    expect(manifest.genesisId).toBe(pinned);
    expect(manifest.origin.kind).toBe('join');
    expect(manifest.miningGatePublicKeys).toEqual([gate]);
    expect(JSON.stringify(manifest)).not.toMatch(/privateKey|secret/i);
  });

  it('writes NOTHING when the peer lies, and the directory stays joinable afterwards', async () => {
    const root = scratch();
    const loaded = loadedFor(root);
    await expect(
      joinNetwork(loaded, { peer: 'http://evil', pinnedGenesisId: pinned, fetchJson: async () => peerReply([pub()]) }),
    ).rejects.toThrow(/Nothing was written/);
    expect(existsSync(manifestPath(loaded.config.dataDir))).toBe(false);
    expect(readdirSync(root).includes('gate-authority')).toBe(false);
    const ok = await joinNetwork(loaded, { peer: 'http://good', pinnedGenesisId: pinned, fetchJson: async () => peerReply([gate]) });
    expect(ok.state).toBe('created');
  });

  it('is idempotent, and refuses to re-point a joined directory at a different network', async () => {
    const loaded = loadedFor(scratch());
    await joinNetwork(loaded, { peer: 'http://p', pinnedGenesisId: pinned, fetchJson: async () => peerReply([gate]) });
    const again = await joinNetwork(loaded, { peer: 'http://p', pinnedGenesisId: pinned, fetchJson: async () => peerReply([gate]) });
    expect(again.state).toBe('existing');
    const otherGate = pub();
    const otherPin = deriveGenesis(NET, [], [otherGate]).genesisId;
    await expect(
      joinNetwork(loaded, { peer: 'http://p', pinnedGenesisId: otherPin, fetchJson: async () => peerReply([otherGate]) }),
    ).rejects.toThrow(/already initialised/);
  });

  it('does not run on a directory that already has chain data but no identity', async () => {
    const loaded = loadedFor(scratch());
    mkdirSync(join(loaded.config.dataDir, 'chain'), { recursive: true });
    writeFileSync(join(loaded.config.dataDir, 'chain', 'blocks.dat'), 'x');
    await expect(
      joinNetwork(loaded, { peer: 'http://p', pinnedGenesisId: pinned, fetchJson: async () => peerReply([gate]) }),
    ).rejects.toThrow(/already holds chain data/);
  });

  it('propagates a peer that cannot be reached without writing anything', async () => {
    const loaded = loadedFor(scratch());
    await expect(
      joinNetwork(loaded, {
        peer: 'http://down',
        pinnedGenesisId: pinned,
        fetchJson: async () => {
          throw new Error('no answer');
        },
      }),
    ).rejects.toThrow('no answer');
    expect(existsSync(manifestPath(loaded.config.dataDir))).toBe(false);
  });
});
