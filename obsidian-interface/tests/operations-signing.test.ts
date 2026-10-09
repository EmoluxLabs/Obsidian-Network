// @vitest-environment jsdom
/**
 * Browser transactions must be signed with the protocol version the node
 * accepts.
 *
 * This is not hypothetical. `operations.ts` hard-coded `protocolVersion:
 * '1.0.0'` while the state machine accepts exactly one version — the one in
 * `CONSENSUS_PARAMS` — so every transaction a user signed in the browser was
 * rejected with `VERSION_MISMATCH`, and no test noticed, because nothing drove
 * the signing path.
 *
 * These tests decode what the operations actually sign, using the core's own
 * decoder, and compare the envelope against the parameter set the node
 * validates with. A page that cannot produce an acceptable envelope is a page
 * that cannot move a single seal, whatever the UI says.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { operations } from '../web/src/lib/operations.js';
import { Wallet } from '../web/src/lib/wallet.js';
import type { ObsidianClient } from '../web/src/lib/client.js';
import { PROTOCOL_VERSION } from '../web/core/version.js';
import { CONSENSUS_PARAMS } from '../web/core/protocol/params.js';
import { decodeSignedTxFromBytes } from '../web/core/transactions/encode.js';
import { TxType } from '../web/core/protocol/types.js';
import { decodeMiningBody } from '../web/core/transactions/executors/mining.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVNET_CHAIN_ID = 7780;
const PROTOCOL_TIME = 1_790_597_000;
const PASSPHRASE = 'a passphrase long enough for the vault';

/** A node and a mempool, answering exactly what the operations read. */
function stubClient() {
  const submitted: Uint8Array[] = [];
  const client = {
    async status() {
      return { chainId: DEVNET_CHAIN_ID, lastBlockTimestamp: PROTOCOL_TIME };
    },
    async balance(address: string) {
      return {
        address,
        nonce: 7,
        balanceSeals: (100n * 10n ** 18n).toString(),
        balanceObs: '100.000000000000000000',
      };
    },
    async network() {
      return { networkId: 'obsidian-devnet-1', network: { chainId: DEVNET_CHAIN_ID } };
    },
    async submit(signed: Uint8Array | string) {
      if (!(signed instanceof Uint8Array)) throw new Error('the wallet must submit raw bytes');
      submitted.push(signed);
      return { accepted: true, txId: 'ab'.repeat(32) };
    },
    async miningStatus(address: string) {
      return {
        address,
        eligible: true,
        nextClaimId: 'cd'.repeat(32),
        nextClaimSequence: 3,
        rewardPerClaimObs: '0.000166666666666666',
      };
    },
  };
  return { client: client as unknown as ObsidianClient, submitted };
}

let wallet: Wallet;

beforeEach(async () => {
  // jsdom has no WebCrypto; give the wallet the real one so derivation,
  // signing and the vault's PBKDF2/AES-GCM run for real.
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  window.localStorage.clear();
  wallet = await Wallet.create('dobs', PASSPHRASE);
});

describe('browser signing carries the node\u2019s protocol version', () => {
  it('signs a payment the state machine will accept', async () => {
    const { client, submitted } = stubClient();
    await operations.send(client, wallet, { to: 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5z3j', amountObs: '1.5' });

    expect(submitted).toHaveLength(1);
    const tx = decodeSignedTxFromBytes(submitted[0]!);
    expect(tx.protocolVersion, 'the node rejects any other version with VERSION_MISMATCH').toBe(
      CONSENSUS_PARAMS.protocolVersion,
    );
    expect(tx.chainId).toBe(DEVNET_CHAIN_ID);
    expect(tx.type).toBe(TxType.PAYMENT);
    expect(tx.nonce).toBe(7);
    expect(tx.sender).toBe(wallet.address);
  });

  it('signs a mining claim with the same version', async () => {
    const { client, submitted } = stubClient();
    const asked: Array<[string, string]> = [];
    const certificate = { issuer: '02'.repeat(33), issuedAt: 1_700_000_000, signature: 'ab'.repeat(64) };
    await operations.claim(client, wallet, async (address, claimId) => {
      asked.push([address, claimId]);
      return certificate;
    });

    const tx = decodeSignedTxFromBytes(submitted[0]!);
    expect(tx.type).toBe(TxType.MINING_CLAIM);
    // The certificate is requested for THIS wallet and the claim id the node named, and rides inside the signed claim.
    expect(asked).toEqual([[wallet.address, 'cd'.repeat(32)]]);
    expect(decodeMiningBody(tx.body).gate).toEqual(certificate);
    expect(tx.protocolVersion).toBe(CONSENSUS_PARAMS.protocolVersion);
    // Claims never pay gas: the reward is issued, not transferred.
    expect(tx.gas).toBe(0n);
  });

  it('signs nothing when the platform refuses the certificate', async () => {
    const { client, submitted } = stubClient();
    await expect(
      operations.claim(client, wallet, async () => {
        throw new Error('mining is closed on this account until you confirm two-factor authentication');
      }),
    ).rejects.toThrow(/two-factor/);
    expect(submitted).toHaveLength(0);
  });

  it('keeps the synced copy of the protocol version current', () => {
    // `web/core` is generated from obsidian-core by scripts/sync-core.mjs, so a
    // stale copy would silently reproduce the original bug on every page.
    expect(PROTOCOL_VERSION).toBe(CONSENSUS_PARAMS.protocolVersion);
  });

  it('has no hard-coded protocol version left in the operations module', () => {
    // The regression was one string literal. Freezing it as a literal is what
    // let the interface drift a protocol version behind the node.
    const source = readFileSync(resolve(HERE, '../web/src/lib/operations.ts'), 'utf8');
    expect(source).toMatch(/from '\.\.\/\.\.\/core\/version\.js'/);
    expect(source).not.toMatch(/protocolVersion:\s*['"]/);
  });
});
