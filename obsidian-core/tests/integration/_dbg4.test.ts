import { describe, it } from 'vitest';
import { createHarness, makeWallet, onsBody, oracleBody, signedClaim, signedPayment, landBody } from '../helpers/harness.js';
import { OnsOp, TxType, LandOp } from '../../src/protocol/types.js';
import { parseObs } from '../../src/protocol/amount.js';
import { expectedGas, usdMicroToSeals } from '../../src/transactions/helpers.js';
import { divisionSeed } from '../../src/land/registry.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';

describe('dbg', () => {
  it('ons transfer + oracle bounds + land level', async () => {
    const h = await createHarness();
    const alice = makeWallet(); const bob = makeWallet();
    h.produce([]);
    h.produce([signedClaim(h, alice)]);
    console.log('alice', alice.address, 'bob', bob.address);
    const now = h.chain.protocolTime;
    h.produce([h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', 50_000_000n, now, 'aa'))]);
    h.produce([h.sign(bob, TxType.ORACLE, oracleBody('source-beta', 50_100_000n, now, 'bb'))]);
    console.log('oracle median', h.chain.world.s.oracle.medianPriceUsdMicro.toString(), 'sources', h.chain.world.s.oracle.sourceCount);

    // oracle with price 0
    const zero = h.tryBlock([h.sign(alice, TxType.ORACLE, oracleBody('source-gamma', 0n, h.chain.protocolTime, 'cc'))], { simulate: false });
    console.log('zero-price oracle:', zero.code, zero.message);

    const fee = usdMicroToSeals(CONSENSUS_PARAMS.ons.registrationFeeUsd, h.chain.world.s.oracle.medianPriceUsdMicro);
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'alice', { fee }), { gas: expectedGas(fee) })]);
    const transfer = h.sign(alice, TxType.ONS, onsBody(OnsOp.TRANSFER, 'alice', { to: bob.address }), { gas: 0n });
    console.log('transfer tx nonce', transfer.nonce, 'alice account nonce', h.chain.world.getAccount(alice.address)!.nonce);
    const blk = h.produce([transfer]);
    console.log('after transfer owner', h.chain.world.s.names.get('alice')!.owner);
    console.log('block txs', blk.transactions.length, 'type', blk.transactions[0]!.type);
    console.log('supply after transfer', h.chain.world.verifySupplyInvariant());

    // land level codes
    const { DIVISION_LEVEL_CODES } = await import('../../src/land/registry.js');
    console.log('DIVISION_LEVEL_CODES', JSON.stringify(DIVISION_LEVEL_CODES));
    const seed = divisionSeed('US-CA')!;
    console.log('seed', JSON.stringify({ ...seed, glvUsdMicro: seed.glvUsdMicro.toString() }));
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    const price = usdMicroToSeals(seed.glvUsdMicro, h.chain.world.s.oracle.medianPriceUsdMicro);
    console.log('median now', h.chain.world.s.oracle.medianPriceUsdMicro.toString());
    for (const level of [1, 2, 3]) {
      const r = h.tryBlock([h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'US-CA', countryCode: 'US', level, price }), { gas: expectedGas(price) })], { simulate: false });
      console.log('land level', level, '->', r.code, r.message);
    }
    h.close();
  });
});
