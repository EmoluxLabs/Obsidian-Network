/**
 * The operator flow for gate rotation: propose, sign, then check what `submit` will send.
 * Nothing here talks to a node; the full flow against live nodes is in tests/e2e/operations.test.mjs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keystore } from '../../src/crypto/keystore.js';
import { generateKeyPair } from '../../src/crypto/keys.js';
import { GATE_PROPOSAL_FORMAT, describeProposal, readProposal, signProposal, writeProposal, type GateProposal } from '../../src/cli/gate.js';
import { verifyGateUpdate } from '../../src/mining/gate-authority.js';
import { GateAuthorityOp } from '../../src/protocol/types.js';

const PASS = 'a-long-enough-test-passphrase';
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obs-gate-cli-'));
  roots.push(dir);
  return dir;
}

function setup() {
  const dir = scratch();
  const holders = [1, 2, 3].map((i) => {
    const pair = generateKeyPair('tobs');
    const path = join(dir, `k${i}.json`);
    Keystore.write(path, pair.privateKey, PASS);
    return { pair, path };
  });
  const newKey = generateKeyPair('tobs').publicKey;
  const proposal: GateProposal = {
    format: GATE_PROPOSAL_FORMAT,
    network: 'testnet',
    networkId: 'obsidian-testnet-1',
    chainId: 7778,
    epoch: 1,
    add: [newKey],
    remove: [holders[0]!.pair.publicKey],
    activeKeys: holders.map((h) => h.pair.publicKey).sort(),
    quorum: 2,
    approvals: [],
  };
  return { dir, holders, proposal, newKey };
}

describe('gate proposal files', () => {
  it('collects approvals from different holders, and the result is exactly what the chain verifies', () => {
    const { dir, holders, proposal } = setup();
    let current = proposal;
    for (const holder of [holders[1]!, holders[2]!]) current = signProposal(current, holder.path, PASS).proposal;
    expect(current.approvals).toHaveLength(2);
    const outcome = verifyGateUpdate(
      { active: proposal.activeKeys, revoked: [], epoch: 0 },
      { op: GateAuthorityOp.UPDATE, epoch: current.epoch, add: current.add, remove: current.remove, approvals: current.approvals },
      { networkId: proposal.networkId, chainId: proposal.chainId },
    );
    expect(outcome.removed).toEqual(proposal.remove);
    expect(describeProposal(current)).toMatch(/2 of 2 needed/);
    // Written files are private to the user, and hold no secret: only public keys and signatures.
    const file = join(dir, 'p.json');
    writeProposal(file, current);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toMatch(/privateKey|passphrase|ciphertext/i);
    expect(readProposal(file)).toEqual(current);
  });

  it('signing twice with the same key keeps ONE approval from that key', () => {
    const { holders, proposal } = setup();
    const once = signProposal(proposal, holders[1]!.path, PASS).proposal;
    const twice = signProposal(once, holders[1]!.path, PASS).proposal;
    expect(twice.approvals).toHaveLength(1);
  });

  it('refuses to sign with a key that is not an active issuer, or with the wrong passphrase', () => {
    const { dir, holders, proposal } = setup();
    const stranger = generateKeyPair('tobs');
    const path = join(dir, 'stranger.json');
    Keystore.write(path, stranger.privateKey, PASS);
    expect(() => signProposal(proposal, path, PASS)).toThrow(/not one of the active issuers/);
    expect(() => signProposal(proposal, holders[0]!.path, 'the-wrong-passphrase!')).toThrow();
    expect(() => signProposal(proposal, holders[0]!.path, 'short')).toThrow(/at least 12/);
  });

  it('rejects files that are not proposals', () => {
    const dir = scratch();
    const file = join(dir, 'x.json');
    writeProposal(file, { ...(setup().proposal), format: 'something-else' as never });
    expect(() => readProposal(file)).toThrow(/not a gate proposal/);
    expect(() => readProposal(join(dir, 'missing.json'))).toThrow(/not found/);
  });
});
