/**
 * The v1.9.0 genesis is a fresh start, and every node derives the same one.
 *
 * Replaces the bootstrap-committee suite. There is no committee any more, so the properties worth pinning are:
 * the genesis identity and state root are a pure function of the document (reproducible on every node and every
 * platform), the genesis state holds no allocation, no node, no validator and no finality progress, the gate issuer
 * set is still part of the identity, and nothing from a validator-era chain can be loaded into it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import { blockHash } from '../../src/blockchain/block.js';
import { computeStateRoot } from '../../src/blockchain/state-root.js';
import { buildGenesisBlock, genesisDocumentFor, genesisFingerprint, genesisId, createGenesisState } from '../../src/genesis/initialize.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { generateKeyPair } from '../../src/crypto/keys.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { GATE_ISSUER, createHarness, type Harness } from '../helpers/harness.js';

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('genesis is reproducible', () => {
  for (const name of ['mainnet', 'testnet', 'devnet'] as const) {
    it(`derives the same id, block hash and state root every time on ${name}`, () => {
      const net = getNetwork(name);
      const gate = [GATE_ISSUER.publicKey];
      const docs = [genesisDocumentFor(net, gate), genesisDocumentFor(net, [...gate])];
      const built = docs.map((doc) => ({
        id: genesisId(doc, net),
        hash: blockHash(buildGenesisBlock(doc, net).header),
        root: buildGenesisBlock(doc, net).header.stateRoot,
        fingerprint: genesisFingerprint(doc, net),
      }));
      expect(built[1]).toEqual(built[0]);
      expect(built[0].id).toMatch(/^[0-9a-f]{40}$/);
      expect(built[0].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(built[0].root).toBe(computeStateRoot(createGenesisState(buildGenesisBlock(docs[0], net), net, gate).s));
    });
  }

  it('is the same on two independently initialised nodes', async () => {
    const a = await createHarness();
    const b = await createHarness();
    harnesses.push(a, b);
    expect(a.chain.store.getMeta()!.genesisHash).toBe(b.chain.store.getMeta()!.genesisHash);
    expect(a.chain.store.getMeta()!.genesisId).toBe(b.chain.store.getMeta()!.genesisId);
    expect(computeStateRoot(a.chain.world.s)).toBe(computeStateRoot(b.chain.world.s));
  });

  it('commits the gate issuer set, so a different issuer set is a different network (gate mechanism unchanged)', () => {
    const net = getNetwork('devnet');
    const other = generateKeyPair(net.addressHrp).publicKey;
    const ids = [[GATE_ISSUER.publicKey], [other], [GATE_ISSUER.publicKey, other]].map((keys) => genesisId(genesisDocumentFor(net, keys), net));
    expect(new Set(ids).size).toBe(3);
  });

  it('is built for protocol 1.9.0 and says so in its note', () => {
    const doc = genesisDocumentFor(getNetwork('mainnet'));
    expect(doc.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(doc.note).toMatch(/v1\.9\.0/);
    expect(doc.note).toMatch(/No validators/);
    expect(doc.note).toMatch(/No premine/);
  });
});

describe('the genesis state is empty of everything the redesign removed', () => {
  it('holds no allocation, no accounts, no nodes, no committee and no finality progress', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const s = h.chain.world.s;
    expect(s.metrics.totalSupply).toBe(0n);
    expect(s.accounts.size).toBe(0);
    expect(s.nodes.size).toBe(0);
    expect(s.nodeWallets.size).toBe(0);
    expect(s.finality).toEqual({ finalizedHeight: 0, finalizedHash: '', recent: [] });
    expect(s.genesis.allocationClaimed).toBe(false);
    expect(Object.keys(s.genesis)).not.toContain('bootstrapValidatorKeys');
    expect(Object.keys(s)).not.toContain('validators');
    expect(Object.keys(s)).not.toContain('validatorModeEstablished');
    const report = h.chain.finalityStatus();
    expect(report.finalizedHeight).toBe(0);
    expect(report.available).toBe(false);
  });
});

describe('nothing from an older chain can be loaded into this one', () => {
  it('refuses to open a data directory created under another protocol version', async () => {
    const h = await createHarness();
    harnesses.push(h);
    h.produce([]);
    const older = new ChainManager({
      dataDir: h.dir,
      net: h.net,
      genesisDocument: { ...h.chain.genesisDocument, protocolVersion: '1.8.2' },
      enforceProposerRotation: true,
    });
    await expect(older.init()).rejects.toThrow(/genesis|protocol|mismatch/i);
  });

  it('refuses to open a data directory created under another gate issuer set', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const other = new ChainManager({
      dataDir: h.dir,
      net: h.net,
      genesisDocument: { ...h.chain.genesisDocument, miningGatePublicKeys: [generateKeyPair(h.net.addressHrp).publicKey] },
      enforceProposerRotation: true,
    });
    await expect(other.init()).rejects.toThrow(/genesis|gate|mismatch/i);
  });

  it('starts empty in a fresh directory: no state is migrated from anywhere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-fresh-'));
    dirs.push(dir);
    const net = getNetwork('devnet');
    const chain = new ChainManager({
      dataDir: dir,
      net,
      genesisDocument: genesisDocumentFor(net, [GATE_ISSUER.publicKey]),
      enforceProposerRotation: true,
    });
    await chain.init();
    expect(chain.height).toBe(0);
    expect(chain.world.registeredNodes()).toHaveLength(0);
    expect(chain.world.s.metrics.totalSupply).toBe(0n);
  });
});
