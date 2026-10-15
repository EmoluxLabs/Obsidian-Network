/**
 * The network manifest: `<dataDir>/network.json`.
 *
 * WHY IT EXISTS
 *   A network's identity (its genesis id) is a hash over PUBLIC inputs that are supplied through configuration:
 *   the mining gate issuer keys. Until now the only record of which inputs a
 *   data directory was created from was the chain itself, so an operator who restarted with the environment
 *   variable missing, or mistyped, got a refusal ("genesis mismatch") that did not say what differed, and
 *   a joining node had no safe way to learn the keys at all.
 *
 *   The manifest writes those public inputs and the resulting identity down, once, when the directory is
 *   created. From then on:
 *     - `start` takes the keys from the manifest when the operator supplies none, so one directory is one network
 *       with no environment to keep in sync;
 *     - `start` REFUSES, naming both sides, when the operator supplies keys that differ from the manifest
 *       (a different list is a different network, never a silent upgrade of trust);
 *     - `init` is idempotent: run twice it reports "existing network" and changes nothing;
 *     - `join` learns the keys from a peer, but only against a genesis id the operator pinned out of band.
 *
 * WHAT IT IS NOT
 *   It holds no secret and no private key, and it is not consensus: the chain still verifies its own genesis.
 *   It is a safeguard against operator error and against a peer lying about which network it is on.
 *
 * TRUST MODEL FOR `join`
 *   The genesis id is a hash that COMMITS to every public input (see genesis/initialize.ts). A peer can therefore
 *   serve the keys but cannot alter them: the joiner recomputes the id from what it received and compares it to
 *   the id the operator pinned. Which peer the document came from does not matter, so "B joined through A" needs
 *   no trust in B. The pinned id is the ONE thing that must reach the operator by a channel an attacker on the
 *   peer-to-peer network cannot rewrite (the first node's `init` output, the project's published release notes).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../storage/atomic.js';
import { Keystore } from '../crypto/keystore.js';
import { generateKeyPair } from '../crypto/keys.js';
import { MIN_GATE_KEYS_MAINNET, gateQuorum } from '../mining/gate-authority.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { blockHash } from '../blockchain/block.js';
import {
  buildGenesisBlock,
  genesisDocumentFor,
  genesisId,
  normalizeMiningGatePublicKeys,
} from '../genesis/initialize.js';
import type { GenesisDocument } from '../blockchain/chain.js';
import { PROTOCOL_VERSION } from '../version.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import type { LoadedConfig } from './config.js';

export const MANIFEST_FILE = 'network.json';
export const MANIFEST_VERSION = 2;

export type ManifestOrigin =
  | { kind: 'init' }
  | { kind: 'start' }
  | { kind: 'adopted' }
  | { kind: 'join'; peer: string; pinnedGenesisId: string };

export interface NetworkManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  network: string;
  networkId: string;
  chainId: number;
  protocolVersion: string;
  genesisId: string;
  genesisHash: string;
  miningGatePublicKeys: string[];
  createdAt: string;
  origin: ManifestOrigin;
}

/** A refusal that must stop the process with a clear message and a non-zero exit (never a silent fix-up). */
export class NetworkIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkIdentityError';
  }
}

export function manifestPath(dataDir: string): string {
  return join(dataDir, MANIFEST_FILE);
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Read and validate the manifest. `undefined` when there is none; a corrupt one is an error, never ignored. */
export function readManifest(dataDir: string): NetworkManifest | undefined {
  const path = manifestPath(dataDir);
  if (!existsSync(path)) return undefined;
  let parsed: Partial<NetworkManifest>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<NetworkManifest>;
  } catch (error) {
    throw new NetworkIdentityError(
      `${path} is not valid JSON (${(error as Error).message}). It records which network this directory belongs to, ` +
        'so it will not be guessed at or overwritten. Restore it from a backup, or move it aside and run `init` again ' +
        'only if you are certain which network this directory holds.',
    );
  }
  const bad = (what: string): never => {
    throw new NetworkIdentityError(`${path} is malformed (${what}). Restore it from a backup; it is not rewritten automatically.`);
  };
  if (parsed.manifestVersion !== MANIFEST_VERSION) bad(`unsupported manifestVersion ${String(parsed.manifestVersion)}`);
  if (typeof parsed.network !== 'string' || typeof parsed.networkId !== 'string') bad('network identifiers missing');
  if (!Number.isSafeInteger(parsed.chainId)) bad('chainId missing');
  if (typeof parsed.protocolVersion !== 'string') bad('protocolVersion missing');
  if (typeof parsed.genesisId !== 'string' || !HEX40.test(parsed.genesisId)) bad('genesisId is not 40 hex characters');
  if (typeof parsed.genesisHash !== 'string' || !HEX64.test(parsed.genesisHash)) bad('genesisHash is not 64 hex characters');
  if (!Array.isArray(parsed.miningGatePublicKeys)) bad('key list missing');
  try {
    normalizeMiningGatePublicKeys(parsed.miningGatePublicKeys as string[]);
  } catch (error) {
    bad((error as Error).message);
  }
  return parsed as NetworkManifest;
}

export interface Derived {
  document: GenesisDocument;
  genesisId: string;
  genesisHash: string;
}

/** The genesis a set of public inputs produces. Deterministic: same inputs, same answer, on any machine. */
export function deriveGenesis(net: NetworkDefinition, gateKeys: readonly string[]): Derived {
  const document = genesisDocumentFor(net, gateKeys);
  return {
    document,
    genesisId: genesisId(document, net),
    genesisHash: blockHash(buildGenesisBlock(document, net).header),
  };
}

export function buildManifest(net: NetworkDefinition, derived: Derived, origin: ManifestOrigin): NetworkManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    network: net.name,
    networkId: net.networkId,
    chainId: net.chainId,
    protocolVersion: derived.document.protocolVersion,
    genesisId: derived.genesisId,
    genesisHash: derived.genesisHash,
    miningGatePublicKeys: [...(derived.document.miningGatePublicKeys ?? [])],
    createdAt: new Date().toISOString(),
    origin,
  };
}

export function writeManifest(dataDir: string, manifest: NetworkManifest): void {
  mkdirSync(dataDir, { recursive: true });
  atomicWriteFile(manifestPath(dataDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** True when the directory already holds chain data (so its identity is fixed, whatever the manifest says). */
export function hasChainData(dataDir: string): boolean {
  const chainDir = join(dataDir, 'chain');
  if (!existsSync(chainDir)) return false;
  try {
    return readdirSync(chainDir).length > 0;
  } catch {
    return false;
  }
}

const short = (keys: readonly string[]): string => (keys.length === 0 ? '(none)' : keys.map((key) => `${key.slice(0, 12)}…`).join(', '));

export type IdentityState = 'new' | 'existing' | 'existing-unrecorded';

export interface EffectiveIdentity {
  /** The configuration to run with: the operator's, with the manifest's keys filled in where they supplied none. */
  loaded: LoadedConfig;
  derived: Derived;
  manifest?: NetworkManifest;
  state: IdentityState;
  /** What was taken from the manifest rather than from configuration, for the log. */
  adopted: string[];
}

/**
 * Decide which public inputs this directory runs with. Pure with respect to the chain: it reads the manifest and
 * the configuration, writes nothing, and throws a NetworkIdentityError when they disagree.
 */
export function resolveIdentity(loaded: LoadedConfig): EffectiveIdentity {
  const { config, net } = loaded;
  const manifest = readManifest(config.dataDir);
  const adopted: string[] = [];
  let gate = config.miningGatePublicKeys;
  if (manifest) {
    if (manifest.network !== net.name || manifest.chainId !== net.chainId || manifest.networkId !== net.networkId) {
      throw new NetworkIdentityError(
        `${manifestPath(config.dataDir)} belongs to ${manifest.network} (${manifest.networkId}, chain ${manifest.chainId}) but this ` +
          `process was started for ${net.name} (${net.networkId}, chain ${net.chainId}). Networks never share a data directory: ` +
          'use a different --data-dir.',
      );
    }
    const operatorGate = config.miningGatePublicKeys.length > 0 ? normalizeMiningGatePublicKeys(config.miningGatePublicKeys) : [];
    if (operatorGate.length > 0 && operatorGate.join(',') !== manifest.miningGatePublicKeys.join(',')) {
      throw new NetworkIdentityError(
        'the mining gate keys you supplied differ from the ones this data directory was created with. ' +
          `Supplied: ${short(operatorGate)}. Recorded: ${short(manifest.miningGatePublicKeys)} (genesis id ${manifest.genesisId}). ` +
          'A different list is a different network. Remove the setting to use the recorded one, or use a new --data-dir for a new network.',
      );
    }
    if (operatorGate.length === 0 && manifest.miningGatePublicKeys.length > 0) adopted.push('mining gate keys');
    gate = manifest.miningGatePublicKeys;
  }
  const derived = deriveGenesis(net, gate);
  if (manifest && derived.genesisId !== manifest.genesisId) {
    throw new NetworkIdentityError(
      `this software derives genesis id ${derived.genesisId} from the recorded inputs, but the directory was created as ` +
        `${manifest.genesisId} (protocol ${manifest.protocolVersion}; this build is protocol ${PROTOCOL_VERSION}). Refusing to start: ` +
        'that would be a different network. Use the release the directory was created with, or follow the upgrade guide.',
    );
  }
  const state: IdentityState = manifest ? 'existing' : hasChainData(config.dataDir) ? 'existing-unrecorded' : 'new';
  return {
    loaded: { ...loaded, config: { ...config, miningGatePublicKeys: [...gate] } },
    derived,
    manifest,
    state,
    adopted,
  };
}

export interface InitOptions {
  /** Create the mining gate authority key now (first node of a network only). */
  generateGateKey?: boolean;
  /** Where the encrypted gate private key is written. Default: `<dataDir>/../gate-authority`, outside the node's data. */
  gateDir?: string;
  /** Passphrase for the gate keystore (at least 12 characters). Never logged. */
  gatePassphrase?: string;
  /**
   * How many gate authority keys to create (1..maxIssuers, default 1). A key can later be rotated or revoked only by a
   * majority of the active keys, so 1 key means that key can replace itself and nothing else protects it: use 3 or
   * more, held by different people or machines, for any network that matters.
   */
  gateKeyCount?: number;
  /**
   * Mainnet refuses fewer than 3 gate keys (docs/gate-authority.md). This is the explicit, named override for a
   * deliberate single-operator launch; it does not exist for any other reason and is recorded in the init notes.
   */
  allowSingleGateKey?: boolean;
}

export interface InitResult {
  state: 'created' | 'existing';
  network: string;
  networkId: string;
  chainId: number;
  genesisId: string;
  genesisHash: string;
  protocolVersion: string;
  dataDir: string;
  manifest: string;
  miningGatePublicKeys: string[];
  gateAuthority?: {
    generated: boolean;
    /** The first key's keystore and public key (kept for scripts written against 1.7.0). */
    keystore: string;
    publicKey: string;
    /** Every key created, in order. */
    keys: { keystore: string; publicKey: string }[];
    /** Approvals a later rotation or revocation will need. */
    quorum: number;
  };
  notes: string[];
}

/**
 * `init`: the explicit, idempotent way to create (or confirm) a network on this machine. It never starts a node,
 * never touches chain data, and never replaces a key. A second run reports `existing` and writes nothing.
 */
export function initNetwork(loaded: LoadedConfig, options: InitOptions = {}): InitResult {
  const { config, net } = loaded;
  mkdirSync(config.dataDir, { recursive: true });
  const identity = resolveIdentity(loaded);
  const notes: string[] = [];
  if (identity.state === 'existing') {
    if (options.generateGateKey) {
      if (identity.derived.document.miningGatePublicKeys?.length) {
        // The same command, run again: nothing to do, and above all no second issuer key.
        notes.push('the gate authority was provisioned when this network was created; it was NOT regenerated and nothing was changed.');
      } else {
        throw new NetworkIdentityError(
          `this directory is already initialised as genesis id ${identity.derived.genesisId} with no mining gate key; the keys are part of that ` +
            'identity and cannot be added afterwards. Nothing was changed. For a new network use a new --data-dir.',
        );
      }
    }
    return describeInit('existing', identity, config.dataDir, notes);
  }
  if (identity.state === 'existing-unrecorded') {
    if (options.generateGateKey) {
      throw new NetworkIdentityError('this directory already holds chain data, so its gate keys are fixed; refusing to generate a new gate authority.');
    }
    writeManifest(config.dataDir, buildManifest(net, identity.derived, { kind: 'adopted' }));
    notes.push('chain data already existed here: its identity was recorded from the current configuration (verified against the chain on the next start).');
    return describeInit('created', identity, config.dataDir, notes);
  }

  // A genuinely new network.
  let gateAuthority: InitResult['gateAuthority'];
  let finalIdentity = identity;
  if (options.generateGateKey) {
    if (identity.loaded.config.miningGatePublicKeys.length > 0) {
      throw new NetworkIdentityError(
        'mining gate public keys are already configured, so no new gate authority is generated (that would silently ' +
          'give this network a second issuer). Remove the configured keys to generate one.',
      );
    }
    const passphrase = options.gatePassphrase ?? '';
    if (passphrase.length < 12) {
      throw new NetworkIdentityError('set OBSIDIAN_GATE_KEYSTORE_PASSPHRASE (or OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE) to at least 12 characters before generating the gate authority');
    }
    const gateDir = options.gateDir ?? join(config.dataDir, '..', 'gate-authority');
    const count = options.gateKeyCount ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > CONSENSUS_PARAMS.miningGate.maxIssuers) {
      throw new NetworkIdentityError(`--gate-key-count must be a whole number from 1 to ${CONSENSUS_PARAMS.miningGate.maxIssuers}`);
    }
    if (net.name === 'mainnet' && count < MIN_GATE_KEYS_MAINNET && !options.allowSingleGateKey) {
      throw new NetworkIdentityError(
        `mainnet needs at least ${MIN_GATE_KEYS_MAINNET} gate keys (--gate-key-count ${MIN_GATE_KEYS_MAINNET}), held by different people or machines: ` +
          `with ${count}, ${count === 1 ? 'one holder can replace the whole authority and nothing protects the key' : 'losing either key freezes all further rotation'}. ` +
          'Pass --allow-single-gate-key only for a deliberate launch you accept cannot be recovered without a new genesis.',
      );
    }
    const targets = Array.from({ length: count }, (_, i) =>
      join(gateDir, count === 1 ? `${net.name}-mining-gate.keystore.json` : `${net.name}-mining-gate-${i + 1}.keystore.json`),
    );
    for (const target of targets) {
      if (existsSync(target)) {
        throw new NetworkIdentityError(
          `${target} already exists but no network is recorded here. Refusing to overwrite an issuer key: move it aside, or ` +
            'configure its public key explicitly (OBSIDIAN_MINING_GATE_PUBLIC_KEYS) to adopt it.',
        );
      }
    }
    mkdirSync(gateDir, { recursive: true, mode: 0o700 });
    const created: { keystore: string; publicKey: string }[] = [];
    for (const target of targets) {
      const pair = generateKeyPair(net.addressHrp);
      Keystore.write(target, pair.privateKey, passphrase);
      // Prove the file decrypts to the key we are about to publish before the network depends on it.
      const check = Keystore.read(target, passphrase);
      if (check.publicKey !== pair.publicKey) throw new Error('the gate keystore did not round-trip; nothing was recorded');
      created.push({ keystore: target, publicKey: pair.publicKey });
    }
    const publicKeys = created.map((entry) => entry.publicKey);
    gateAuthority = {
      generated: true,
      keystore: created[0]!.keystore,
      publicKey: created[0]!.publicKey,
      keys: created,
      quorum: gateQuorum(count),
    };
    finalIdentity = {
      ...identity,
      loaded: { ...identity.loaded, config: { ...identity.loaded.config, miningGatePublicKeys: publicKeys } },
      derived: deriveGenesis(net, publicKeys),
    };
    if (count < 3) {
      notes.push(
        `WARNING: ${count} gate key(s). A compromised key is removed by a majority of the active keys (${gateQuorum(count)} of ${count}), ` +
          'so with fewer than 3 keys one holder can replace the whole set, and losing the only key closes mining for good. ' +
          'Use --gate-key-count 3 or more, keep each keystore with a different person or machine, and back each one up.',
      );
    }
    notes.push(
      'The gate PRIVATE key(s) are in the keystore file(s) above, encrypted, outside the node data directory. The key the account ' +
        'platform signs certificates with goes on that machine only (OBSIDIAN_GATE_KEYSTORE / OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE); any ' +
        'other key goes to the person or machine that holds its share of the authority. Keys are never sent to a peer and nodes never ' +
        'need them: they hold only the public keys. Rotating or revoking a key needs a majority of them (`gate propose|sign|submit`).',
    );
  } else if (identity.loaded.config.miningGatePublicKeys.length === 0 && finalIdentity.derived.document.miningGatePublicKeys?.length === 0) {
    notes.push(
      'No mining gate key is configured: the node will run and verify blocks, but NO mining claim can be accepted. ' +
        'Re-run `init` with --generate-gate-key on a new directory, or set OBSIDIAN_MINING_GATE_PUBLIC_KEYS (the same list on every node).',
    );
  }
  writeManifest(config.dataDir, buildManifest(net, finalIdentity.derived, { kind: 'init' }));
  const result = describeInit('created', finalIdentity, config.dataDir, notes);
  if (gateAuthority) result.gateAuthority = gateAuthority;
  return result;
}

function describeInit(state: 'created' | 'existing', identity: EffectiveIdentity, dataDir: string, notes: string[]): InitResult {
  const { document } = identity.derived;
  return {
    state,
    network: identity.loaded.net.name,
    networkId: document.networkId,
    chainId: document.chainId,
    genesisId: identity.derived.genesisId,
    genesisHash: identity.derived.genesisHash,
    protocolVersion: document.protocolVersion,
    dataDir,
    manifest: manifestPath(dataDir),
    miningGatePublicKeys: [...(document.miningGatePublicKeys ?? [])],
    notes,
  };
}

export interface PeerGenesisReply {
  document?: unknown;
  genesisId?: unknown;
  chainId?: unknown;
  networkId?: unknown;
}

/**
 * Verify what a peer says its genesis is, against the id the operator pinned. Pure: no I/O. Throws on any doubt.
 * The peer's own `genesisId` field is ignored for trust (it is only cross-checked): the id is recomputed from the
 * document, because the document is what the chain will actually be built from.
 */
export function verifyPeerGenesis(net: NetworkDefinition, reply: PeerGenesisReply, pinnedGenesisId: string): Derived {
  const pinned = pinnedGenesisId.trim().toLowerCase();
  if (!HEX40.test(pinned)) throw new NetworkIdentityError('the pinned genesis id must be 40 lowercase hex characters (copy it from the first node\'s `init` output)');
  const doc = reply.document as Partial<GenesisDocument> | undefined;
  if (!doc || typeof doc !== 'object') throw new NetworkIdentityError('the peer did not return a genesis document');
  if (doc.networkId !== net.networkId || doc.chainId !== net.chainId) {
    throw new NetworkIdentityError(
      `the peer is on ${String(doc.networkId)} (chain ${String(doc.chainId)}), not ${net.networkId} (chain ${net.chainId}). Nothing was written.`,
    );
  }
  if (doc.protocolVersion !== PROTOCOL_VERSION) {
    throw new NetworkIdentityError(
      `the peer's genesis is protocol ${String(doc.protocolVersion)} and this build is protocol ${PROTOCOL_VERSION}: they cannot be the same network. Nothing was written.`,
    );
  }
  let gate: string[];
  try {
    gate = normalizeMiningGatePublicKeys((doc.miningGatePublicKeys as string[] | undefined) ?? []);
  } catch (error) {
    throw new NetworkIdentityError(`the peer sent unusable keys (${(error as Error).message}). Nothing was written.`);
  }
  let derived: Derived;
  try {
    derived = deriveGenesis(net, gate);
  } catch (error) {
    throw new NetworkIdentityError(`the peer's keys do not form a valid genesis for ${net.name}: ${(error as Error).message}`);
  }
  if (derived.genesisId !== pinned) {
    throw new NetworkIdentityError(
      `the genesis the peer describes has id ${derived.genesisId}, but you pinned ${pinned}. The peer is on a different network, or is ` +
        'lying about its keys. Nothing was written and no key was accepted.',
    );
  }
  if (typeof reply.genesisId === 'string' && reply.genesisId.toLowerCase() !== derived.genesisId) {
    throw new NetworkIdentityError('the peer\'s own genesis id does not match the document it sent. Nothing was written.');
  }
  return derived;
}

/**
 * `join`: record a network learned from a peer. `fetchJson` is injected so the whole decision is testable; the CLI
 * passes a bounded, time-limited HTTP GET. Writes nothing unless verification passed.
 */
export async function joinNetwork(
  loaded: LoadedConfig,
  options: { peer: string; pinnedGenesisId: string; fetchJson: (url: string) => Promise<PeerGenesisReply> },
): Promise<InitResult> {
  const { config, net } = loaded;
  const identity = resolveIdentity(loaded);
  if (identity.state === 'existing-unrecorded') {
    throw new NetworkIdentityError('this directory already holds chain data; `join` is for a new node. Use `init` to record the identity of an existing one.');
  }
  const reply = await options.fetchJson(`${options.peer.replace(/\/+$/, '')}/genesis`);
  const derived = verifyPeerGenesis(net, reply, options.pinnedGenesisId);
  if (identity.manifest) {
    if (identity.manifest.genesisId !== derived.genesisId) {
      throw new NetworkIdentityError(
        `this directory is already initialised as genesis id ${identity.manifest.genesisId}; the peer's network is ${derived.genesisId}. Nothing was changed.`,
      );
    }
    return describeInit('existing', { ...identity, derived }, config.dataDir, ['already joined; nothing was changed.']);
  }
  const effective: EffectiveIdentity = {
    ...identity,
    derived,
    loaded: {
      ...identity.loaded,
      config: {
        ...identity.loaded.config,
        miningGatePublicKeys: [...(derived.document.miningGatePublicKeys ?? [])],
      },
    },
  };
  writeManifest(config.dataDir, buildManifest(net, derived, { kind: 'join', peer: options.peer, pinnedGenesisId: derived.genesisId }));
  return describeInit('created', effective, config.dataDir, [
    'Only PUBLIC keys were learned, and only because they reproduce the genesis id you pinned. No private key was requested or received.',
    'Start the node with --seeds <peer p2p address> to sync.',
  ]);
}
