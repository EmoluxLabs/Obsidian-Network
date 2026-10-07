/**
 * Committed finality bootstrap committees.
 *
 * WHY THIS FILE EXISTS
 *   v1.6.0 replaces the previous open-genesis bootstrap ("any stable bonded set
 *   may finalize the first checkpoint") with a committee that is fixed in the
 *   genesis document and therefore committed by the genesis id. A node that
 *   does not have exactly this list is not on this chain: it derives a different
 *   genesis id and refuses to peer, so nobody can offer a node an alternative
 *   "initial trusted committee" and have it accepted.
 *
 *   These are PUBLIC keys. They are hashed into the genesis id, printed by
 *   `GET /genesis` and documented in docs/consensus.md. The private halves are
 *   held by the operators who run those validators and are never in this
 *   repository (see bootstrap-keys/README.md).
 *
 * WHAT A COMMITTED KEY MEANS
 *   Each committed key must appear in the active validator registry with exactly
 *   the 20,000 OBS bond before the first checkpoint:
 *
 *     - the key's own address registers with `VALIDATOR.REGISTER`,
 *     - the bond is the operator's own funds (100,000 OBS of genesis allocation
 *       is exactly five bonds), and
 *     - until the first certificate, ONLY these keys may vote, so additional
 *       registrations cannot join the bootstrap committee.
 *
 *   After the first certificate the ordinary rule applies: every ACTIVE
 *   validator with the exact bond is a finality validator, equal-weighted.
 *
 * OPERATIONAL MEANING OF THE SIZES
 *   mainnet: 4 keys. Quorum is floor(2N/3)+1 = 3, so one validator may be
 *            offline. Four is not arbitrary: it is the largest committee the
 *            genesis allocation can fund. Every validator costs its owner one
 *            exact bond plus the gas the registration transaction itself
 *            requires:
 *
 *              20,000.01 OBS × 4 = 80,000.04 OBS  ≤ 100,000 OBS  ✓
 *              20,000.01 OBS × 5 = 100,000.05 OBS >  100,000 OBS  ✗ (by 0.05)
 *
 *            The allocation is exactly 100,000 OBS to the first protocol-valid
 *            mining claim, and the bond is exactly 20,000 OBS, so five bonds
 *            plus five registration fees are unaffordable by construction. The
 *            invariant is asserted by tests/integration/bootstrap-committee.test.ts.
 *            A fifth validator is welcome later: after the first checkpoint any
 *            ACTIVE, exactly-bonded validator is a finality validator, so a
 *            later operator joins by registering normally once the network has
 *            mined enough to fund one more bond.
 *   testnet: 3 keys. Quorum 3: a smaller, easier-to-run public test committee
 *            (three bonds cost 60,000.03 OBS, well inside the allocation).
 *   staging / devnet: intentionally empty. Operators of those networks supply
 *            their own list with OBSIDIAN_BOOTSTRAP_VALIDATOR_PUBLIC_KEYS.
 *            An empty list is valid and means "no finality bootstrap" — the
 *            node mines and serves, and finality simply never advances.
 *
 * CHANGING A SET
 *   Changing the list changes the genesis id, so it is a new network, not an
 *   upgrade. Generate with `node scripts/generate-bootstrap-keys.mjs`, paste the
 *   printed public keys here, rebuild, and update the genesis ids in the docs
 *   and CHANGELOG. Never edit these lists at runtime.
 */

import type { NetworkDefinition, NetworkName } from '../protocol/networks.js';

/** Networks whose bootstrap committee is a protocol constant. */
export type CommittedBootstrapNetwork = Extract<NetworkName, 'mainnet' | 'testnet'>;

/**
 * Canonical bootstrap committees, sorted as the protocol normalises them
 * (lexicographic by compressed public key hex).
 */
export const COMMITTED_BOOTSTRAP_VALIDATOR_KEYS: Readonly<Record<CommittedBootstrapNetwork, readonly string[]>> = {
  mainnet: [
    '025931d58a08936022cb00e1ed3e60ca03e437476282e1d904d126551f8604df49',
    '03110e877fba4cb32bbda9265170780ce6052930f1af3858d886a4fd25ea688420',
    '03cfb7f43c7cc838bb019536e4bdebc754f3139139d9d5d31ba89be01d70239f01',
    '03d785f3be58bce4ad94c80d81570adc7a3d96a460f049115e8d67cfe720778ac3',
  ],
  testnet: [
    '026a8177028b722cacd5779763e1d6b33e1e39c4f1eb5fad6ef2a3183c9f3d6d1d',
    '0271c91f092fc1f09e21d85a50041b3691a635185f1939697b2b6d650d718be117',
    '03a616c68bc180b126d2358b34cfa8f28eb9b9afb5755e746df2318477f4aa935a',
  ],
};

/** The committed set for a network, or an empty list when it has none. */
export function committedBootstrapValidatorKeys(net: NetworkDefinition): readonly string[] {
  const committed = (COMMITTED_BOOTSTRAP_VALIDATOR_KEYS as Record<string, readonly string[] | undefined>)[net.name];
  return committed ?? [];
}
