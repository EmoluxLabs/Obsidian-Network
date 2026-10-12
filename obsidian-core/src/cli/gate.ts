/**
 * `gate status | propose | sign | submit`: operating the mining gate authority (protocol 1.8.0).
 *
 * Rotation and revocation need approvals from a majority of the CURRENT issuer keys. Those keys live with different
 * people or machines, so the flow is a file that travels between them:
 *
 *   propose  anyone, no secret  → writes proposal.json (what changes, the epoch, who must approve)
 *   sign     each key holder    → decrypts THEIR keystore, adds their approval to the file, shows what they approved
 *   submit   anyone, no secret  → checks the quorum, then sends the update to a node
 *
 * Nothing here holds a key longer than one command, nothing prints one, and `submit` signs the transaction envelope
 * with a throwaway key made for that one submission: the envelope's sender decides nothing about who may change the
 * gate (the approvals do), and it needs no balance because the update carries no gas.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keystore } from '../crypto/keystore.js';
import { generateKeyPair } from '../crypto/keys.js';
import {
  approveGateUpdate,
  encodeGateAuthorityBody,
  gateQuorum,
  planGateUpdate,
  verifyGateUpdate,
} from '../mining/gate-authority.js';
import { signTransaction, encodeSignedTx } from '../transactions/encode.js';
import { GateAuthorityOp, TxType, type GateApproval } from '../protocol/types.js';
import { PROTOCOL_VERSION } from '../version.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { toHex } from '../crypto/hash.js';
import { httpGetJson } from './ops.js';

export const GATE_PROPOSAL_FORMAT = 'obsidian-gate-proposal-1';

export interface GateProposal {
  format: typeof GATE_PROPOSAL_FORMAT;
  network: string;
  networkId: string;
  chainId: number;
  /** The epoch this update creates (the chain's epoch when proposed, plus one). */
  epoch: number;
  add: string[];
  remove: string[];
  /** The active keys when proposed: who may approve, and what the quorum is computed from. */
  activeKeys: string[];
  quorum: number;
  approvals: GateApproval[];
}

export interface GateInfo {
  network: string;
  networkId: string;
  chainId: number;
  epoch: number;
  issuerKeys: string[];
  revokedKeys: string[];
  genesisKeys: string[];
  quorum: number | null;
  open: boolean;
  protocolTime: number;
}

const list = (raw: string | undefined): string[] => (raw ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);

export async function fetchGate(base: string): Promise<GateInfo> {
  const reply = await httpGetJson(`${base}/gate`, { timeoutMs: 8000, maxBytes: 64 * 1024 });
  if (reply.status === 404) {
    throw new Error(`${base} has no /gate endpoint: it is running software older than protocol 1.8.0, which has no gate rotation`);
  }
  if (reply.status !== 200 || !reply.body || typeof reply.body !== 'object') throw new Error(`${base}/gate answered HTTP ${reply.status}`);
  const body = reply.body as Record<string, unknown>;
  const keys = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  if (typeof body.epoch !== 'number' || typeof body.chainId !== 'number' || typeof body.networkId !== 'string') {
    throw new Error(`${base}/gate did not answer with a gate description`);
  }
  return {
    network: String(body.network ?? ''),
    networkId: body.networkId,
    chainId: body.chainId,
    epoch: body.epoch,
    issuerKeys: keys(body.issuerKeys),
    revokedKeys: keys(body.revokedKeys),
    genesisKeys: keys(body.genesisKeys),
    quorum: typeof body.quorum === 'number' ? body.quorum : null,
    open: body.open === true,
    protocolTime: typeof body.protocolTime === 'number' ? body.protocolTime : Math.floor(Date.now() / 1000),
  };
}

export function renderGate(info: GateInfo): string {
  const lines = [
    `Mining gate — ${info.network} (${info.networkId}, chain ${info.chainId})`,
    `  state:        ${info.open ? 'open (certificates from the keys below are accepted)' : 'CLOSED: no issuer key, so no mining claim can be accepted'}`,
    `  epoch:        ${info.epoch} (${info.epoch} update(s) applied since genesis)`,
    `  active keys:  ${info.issuerKeys.length}${info.quorum ? `   an update needs ${info.quorum} approval(s)` : ''}`,
    ...info.issuerKeys.map((key) => `    ${key}`),
  ];
  if (info.revokedKeys.length > 0) lines.push(`  revoked keys: ${info.revokedKeys.length} (never valid again)`, ...info.revokedKeys.map((key) => `    ${key}`));
  const removedFromGenesis = info.genesisKeys.filter((key) => !info.issuerKeys.includes(key));
  if (removedFromGenesis.length > 0) lines.push(`  note: ${removedFromGenesis.length} genesis key(s) are no longer active.`);
  if (info.issuerKeys.length === 1) lines.push('  warning: a single issuer key can replace itself and nothing else protects it; add keys (see docs/gate-authority.md).');
  return `${lines.join('\n')}\n`;
}

export async function proposeGateUpdate(base: string, change: { add?: string; remove?: string }): Promise<GateProposal> {
  const info = await fetchGate(base);
  const add = list(change.add);
  const remove = list(change.remove);
  // The chain's own checks, before anybody is asked to sign something it would refuse.
  planGateUpdate({ active: info.issuerKeys, revoked: info.revokedKeys, epoch: info.epoch }, { epoch: info.epoch + 1, add, remove });
  return {
    format: GATE_PROPOSAL_FORMAT,
    network: info.network,
    networkId: info.networkId,
    chainId: info.chainId,
    epoch: info.epoch + 1,
    add: [...add].sort(),
    remove: [...remove].sort(),
    activeKeys: [...info.issuerKeys].sort(),
    quorum: gateQuorum(info.issuerKeys.length),
    approvals: [],
  };
}

export function readProposal(path: string): GateProposal {
  if (!existsSync(path)) throw new Error(`proposal file not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const p = parsed as Partial<GateProposal> | null;
  if (
    !p || p.format !== GATE_PROPOSAL_FORMAT || typeof p.networkId !== 'string' || !Number.isSafeInteger(p.chainId) ||
    !Number.isSafeInteger(p.epoch) || !Array.isArray(p.add) || !Array.isArray(p.remove) || !Array.isArray(p.activeKeys) || !Array.isArray(p.approvals)
  ) {
    throw new Error(`${path} is not a gate proposal (expected format ${GATE_PROPOSAL_FORMAT})`);
  }
  return p as GateProposal;
}

export function writeProposal(path: string, proposal: GateProposal): void {
  writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 });
}

/** Add one holder's approval. Prints nothing secret; the key is read, used and dropped inside this call. */
export function signProposal(proposal: GateProposal, keystorePath: string, passphrase: string): { proposal: GateProposal; signer: string } {
  if (passphrase.length < 12) throw new Error('set OBSIDIAN_GATE_KEYSTORE_PASSPHRASE (or _FILE) to the keystore passphrase (at least 12 characters)');
  const pair = Keystore.read(keystorePath, passphrase);
  if (!proposal.activeKeys.includes(pair.publicKey)) {
    throw new Error(`this keystore's key (${pair.publicKey}) is not one of the active issuers named in the proposal, so its approval would not count`);
  }
  const approval = approveGateUpdate(
    pair.privateKey,
    pair.publicKey,
    { networkId: proposal.networkId, chainId: proposal.chainId },
    proposal.epoch,
    proposal.add,
    proposal.remove,
  );
  const others = proposal.approvals.filter((entry) => entry.key !== approval.key);
  return { proposal: { ...proposal, approvals: [...others, approval].sort((a, b) => a.key.localeCompare(b.key)) }, signer: pair.publicKey };
}

export function describeProposal(proposal: GateProposal): string {
  return [
    `Gate update for ${proposal.network || proposal.networkId} (chain ${proposal.chainId}), creating epoch ${proposal.epoch}`,
    `  add:     ${proposal.add.length ? proposal.add.join(', ') : '(none)'}`,
    `  remove:  ${proposal.remove.length ? proposal.remove.join(', ') : '(none)'}`,
    `  approvals: ${proposal.approvals.length} of ${proposal.quorum} needed (${proposal.activeKeys.length} active keys)`,
  ].join('\n');
}

/** Build the transaction, check it exactly as the chain will, and send it. `dryRun` stops after the check. */
export async function submitProposal(base: string, proposal: GateProposal, options: { dryRun?: boolean } = {}): Promise<{ txId: string; accepted: boolean; detail: unknown }> {
  const info = await fetchGate(base);
  if (info.networkId !== proposal.networkId || info.chainId !== proposal.chainId) {
    throw new Error(`the proposal is for ${proposal.networkId} (chain ${proposal.chainId}) but ${base} follows ${info.networkId} (chain ${info.chainId})`);
  }
  const body = { op: GateAuthorityOp.UPDATE, epoch: proposal.epoch, add: proposal.add, remove: proposal.remove, approvals: proposal.approvals };
  // The chain's own verifier, on the chain's own current state: a refusal here is the refusal the node would give.
  verifyGateUpdate({ active: info.issuerKeys, revoked: info.revokedKeys, epoch: info.epoch }, body, { networkId: info.networkId, chainId: info.chainId });
  const hrp = info.networkId.includes('mainnet') ? 'obs' : 'tobs';
  const ephemeral = generateKeyPair(hrp);
  const tx = signTransaction({
    sender: ephemeral.address,
    privateKeyHex: ephemeral.privateKey,
    publicKeyHex: ephemeral.publicKey,
    chainId: info.chainId,
    protocolVersion: PROTOCOL_VERSION,
    nonce: 0,
    type: TxType.GATE_AUTHORITY,
    gas: 0n,
    body: encodeGateAuthorityBody(body),
    memo: '',
    validUntil: info.protocolTime + Math.floor((CONSENSUS_PARAMS.tx.expiryBlocks * CONSENSUS_PARAMS.block.targetBlockSeconds) / 2),
  });
  if (options.dryRun) return { txId: tx.id, accepted: false, detail: 'dry run: checked against the chain state, not sent' };
  const response = await fetch(`${base}/tx/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: toHex(encodeSignedTx(tx)) }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const reply = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(`the node refused the update: ${String(reply?.error ?? `HTTP ${response.status}`)}`);
  return { txId: tx.id, accepted: true, detail: reply };
}
