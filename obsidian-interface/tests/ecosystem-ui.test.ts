// @vitest-environment jsdom
/**
 * What the interface signs and shows for the protocol's only revenue source.
 *
 * ONS registration and renewal fees are the whole of protocol revenue: 90% to
 * the node-runner pool, 10% to the treasury, split inside the state transition
 * with integer arithmetic that loses nothing. These tests drive the real
 * operations module and decode what it signed with the core's own decoder, so
 * what is asserted is what the node reads.
 *
 * They also assert the negative: the discontinued products (Circle/land,
 * Capsules, Social) are gone from the module that signs transactions and from
 * the browser client that could read them. A UI-level removal that left the
 * handlers in place would still be a product shipped.
 */

import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObsidianClient, type RevenueResponse } from '../web/src/lib/client.js';
import { operations, gasFor } from '../web/src/lib/operations.js';
import { revenueTimingRows } from '../web/src/lib/revenue.js';
import { kv } from '../web/src/lib/ui.js';
import { Wallet } from '../web/src/lib/wallet.js';
import { decodeSignedTxFromBytes } from '../web/core/transactions/encode.js';
import { decodeOnsBody } from '../web/core/transactions/executors/ons.js';
import { OnsOp, TxType } from '../web/core/protocol/types.js';
import { parseObs } from '../web/core/protocol/amount.js';
import { expectedGas } from '../web/core/transactions/helpers.js';

const DEVNET_CHAIN_ID = 7780;
const PROTOCOL_TIME = Math.floor(Date.now() / 1000);
const PASSPHRASE = 'a passphrase long enough for the vault';
const HOUR = 3600;

let wallet: Wallet;

beforeEach(async () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  document.body.innerHTML = '<div id="app"></div>';
  window.localStorage.clear();
  wallet = await Wallet.create('dobs', PASSPHRASE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ── a node, as far as the operations can tell ─────────────────────────────────

function stubNode() {
  const submitted: Uint8Array[] = [];
  const client = {
    async status() {
      return { chainId: DEVNET_CHAIN_ID, lastBlockTimestamp: PROTOCOL_TIME, height: 40 };
    },
    async balance(address: string) {
      return { address, nonce: 7, balanceSeals: (1_000n * 10n ** 18n).toString(), balanceObs: '1000' };
    },
    async network() {
      return { network: { chainId: DEVNET_CHAIN_ID } };
    },
    async submit(signed: Uint8Array) {
      submitted.push(signed);
      return { accepted: true, txId: 'ab'.repeat(32) };
    },
  };
  return { client: client as unknown as ObsidianClient, submitted };
}

// ── ONS: the one thing that produces protocol revenue ─────────────────────────

describe('ONS operations', () => {
  const registrationFee = '0.050000000000000000';

  it('registers a name at the protocol fee, signed for the chain the node is on', async () => {
    const { client, submitted } = stubNode();
    await operations.registerName(client, wallet, { name: 'alice.obs', feeObs: registrationFee });

    const tx = decodeSignedTxFromBytes(submitted[0]!);
    expect(tx.type).toBe(TxType.ONS);
    expect(tx.chainId).toBe(DEVNET_CHAIN_ID);
    expect(tx.nonce).toBe(7);
    const body = decodeOnsBody(tx.body);
    expect(body.op).toBe(OnsOp.REGISTER);
    expect(body.name).toBe('alice.obs');
    expect(body.fee).toBe(parseObs(registrationFee));
    expect(tx.gas).toBe(gasFor(parseObs(registrationFee)));
    expect(tx.validUntil).toBeGreaterThan(PROTOCOL_TIME);
  });

  it('renews a name: renewal fees are ONS revenue too', async () => {
    const { client, submitted } = stubNode();
    await operations.renewName(client, wallet, { name: 'alice.obs', feeObs: '0.010000000000000000' });

    const tx = decodeSignedTxFromBytes(submitted[0]!);
    const body = decodeOnsBody(tx.body);
    expect(tx.type).toBe(TxType.ONS);
    expect(body.op).toBe(OnsOp.RENEW);
    expect(body.fee).toBe(parseObs('0.01'));
  });

  it('transfers and re-points a name without paying a fee, so neither mints revenue', async () => {
    const { client, submitted } = stubNode();
    await operations.transferName(client, wallet, { name: 'alice.obs', to: 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5z3j' });
    await operations.updateNameAddress(client, wallet, { name: 'alice.obs', address: 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5z3j' });

    const [transfer, update] = submitted.map((bytes) => decodeSignedTxFromBytes(bytes));
    expect(decodeOnsBody(transfer!.body).op).toBe(OnsOp.TRANSFER);
    expect(decodeOnsBody(transfer!.body).fee).toBe(0n);
    expect(decodeOnsBody(update!.body).op).toBe(OnsOp.UPDATE_ADDRESS);
    expect(decodeOnsBody(update!.body).fee).toBe(0n);
  });
});

// ── the discontinued products are gone from the signing path ──────────────────

describe('discontinued products', () => {
  it('leaves no Circle, Capsule or Social operation callable', () => {
    const names = Object.keys(operations);
    for (const retired of ['buyParcel', 'listParcel', 'delistParcel', 'giftParcel', 'sellParcelToProtocol', 'buyListedParcel', 'createCapsule', 'previewCapsule', 'setProfile', 'post', 'follow', 'tip', 'buyBusinessPage']) {
      expect(names, `${retired} is a discontinued product operation`).not.toContain(retired);
    }
  });

  it('exposes exactly the still-shipping protocol operations', () => {
    expect(Object.keys(operations).sort()).toEqual(
      ['claim', 'payRevenue', 'publishPrice', 'registerName', 'registerValidator', 'renewName', 'send', 'transferName', 'updateNameAddress'],
    );
  });

  it('has no retired read routes on the browser client', () => {
    const client = new ObsidianClient();
    for (const retired of ['landCountries', 'landDivisions', 'landParcels', 'landParcel', 'landQuote', 'landSearch', 'landDivision', 'capsules', 'capsule', 'socialFeed', 'socialProfile']) {
      expect(retired in client, `client.${retired}() still exists`).toBe(false);
    }
  });

  it('does not import a removed core module into the browser bundle', async () => {
    const module = (await import('../web/src/lib/operations.js')) as Record<string, unknown>;
    for (const helper of ['sealContent', 'openSealed', 'teaserFromHex', 'teaserToHex', 'parcelRef', 'nextFreePlot', 'MAX_TEASER_BYTES']) {
      expect(helper in module, `${helper} was a discontinued product's helper`).toBe(false);
    }
  });
});

// ── revenue ───────────────────────────────────────────────────────────────────

describe('where ONS revenue goes, and when', () => {
  const revenue = (over: Partial<RevenueResponse> = {}): RevenueResponse => ({
    onsRevenueObs: '10.000000000000000000',
    split: {
      nodeRunnerPoolObs: '9.000000000000000000',
      treasuryObs: '1.000000000000000000',
      treasuryCreditedObs: '1.000000000000000000',
      treasuryUnclaimedObs: '0.000000000000000000',
      nodePoolBps: 9_000,
      treasuryBps: 1_000,
      sumsBack: true,
    },
    bySource: [],
    accounts: { miningPoolObs: '0', nodeRunnerPoolObs: '9', nodeBondsObs: '0', unclaimedTreasuryRevenueObs: '0', treasuryWallet: 'dobs1treasurytreasurytreasurytreasurytreasury' },
    treasury: {
      designated: true,
      wallet: 'dobs1treasurytreasurytreasurytreasurytreasury',
      lifetimeCreditedObs: '1.000000000000000000',
      credited: 'each designated share is credited in the same block as its ONS fee',
    },
    timing: {
      treasuryShare: { paid: 'credited to the designated treasury wallet in the same block as the ONS fee', bps: 1_000 },
      nodeRunnerShare: {
        paid: 'once per protocol period, in the first block after the period closes',
        bps: 9_000,
        periodSeconds: 86_400,
        currentPeriod: 20_000,
        lastSettledPeriod: 19_999,
        nextSettlementAt: PROTOCOL_TIME + 5 * HOUR,
        secondsUntilNextSettlement: 5 * HOUR,
        registeredNodes: 0,
        poolBalanceObs: '9.000000000000000000',
        carriedWhenNoNodes: true,
        note: 'no node runner is registered yet, so the pool is carried forward and paid out once nodes register and earn a score',
      },
    },
    notOnsRevenue: [],
    gas: { destination: 'mining pool', note: '', lifetimeObs: '0' },
    ...over,
  });
  const render = (r: RevenueResponse) => kv(revenueTimingRows(r)).textContent ?? '';

  it('shows the whole treasury address, what it has been credited, and that 10% is the treasury share', () => {
    const text = render(revenue());
    expect(text).toContain('dobs1treasurytreasurytreasurytreasurytreasury');
    expect(text).not.toContain('…');
    expect(text).toContain('Treasury share credited so far');
    expect(text).toContain('1 OBS');
    expect(text).not.toContain('Treasury balance');
    expect(text).toContain('Treasury share (10%)');
    expect(text).toContain('credited to the designated treasury wallet');
  });

  it('separates the credited treasury share from what is still owed', () => {
    const pending = revenue({
      split: {
        nodeRunnerPoolObs: '9.000000000000000000',
        treasuryObs: '1.000000000000000000',
        treasuryCreditedObs: '0.000000000000000000',
        treasuryUnclaimedObs: '1.000000000000000000',
        nodePoolBps: 9_000,
        treasuryBps: 1_000,
        sumsBack: true,
      },
      treasury: { designated: false, wallet: null, lifetimeCreditedObs: '0', credited: 'no treasury wallet is designated yet' },
      accounts: { miningPoolObs: '1', nodeRunnerPoolObs: '9', nodeBondsObs: '0', unclaimedTreasuryRevenueObs: '1.000000000000000000', treasuryWallet: null },
    });
    const text = render(pending);
    expect(text).toContain('not designated yet');
    expect(text).toContain('Treasury share still owed');
    expect(text).toContain('1 OBS');
  });

  it('gives the next node-runner payout as a time and a countdown, and says what happens with no nodes', () => {
    const text = render(revenue());
    expect(text).toContain('Node-runner share (90%)');
    expect(text).toContain('in 5h 0m');
    expect(text).toContain('every 1d 0h');
    expect(text).toContain('pool is carried forward');
    expect(text).toContain('9 OBS');
  });

  it('does not invent a schedule for a node that does not report one', () => {
    const old = revenue();
    delete old.timing;
    delete old.treasury;
    const text = render(old);
    expect(text).toContain('this node does not report a payment schedule');
    expect(text).toContain('dobs1treasurytreasurytreasurytreasurytreasury');
    expect(text).not.toContain('undefined');
  });
});
