/**
 * Consensus parameters — the Obsidian Protocol Specification in constant form.
 *
 * RULE (spec §75): consensus-critical configuration must be deterministic
 * across nodes. Therefore every value in this file is a compile-time constant
 * of the protocol version, NOT an operator setting. Operators configure only
 * application-level items (ports, data directory, log level, RPC bind address).
 *
 * Changing any value below requires a protocol version bump and a documented
 * consensus upgrade — it is a hard fork.
 *
 * Values are documented in /docs/consensus.md and /docs/economics.md.
 */

import { parseObs, MAX_SUPPLY_SEALS } from './amount.js';

export const CONSENSUS_PARAMS = {
  /**
   * Protocol version that owns these parameters.
   *
   * 1.1.0 introduced two consensus-visible changes:
   *   - the consensus identity is named and documented as Proof of Time (PoT):
   *     the fork-choice weight is PoT Weight, the timing rule is PoT Difficulty
   *     and the participation metric is Time-Rate (see `proofOfTime` below);
   *   - qualifying platform revenue followed an earlier runner / treasury
   *     policy; v1.6.0 replaces it with ONS-only 90% / 10% routing.
   *
   * 1.2.0 removed external-price dependence from protocol service pricing.
   * ONS registration and renewal fees are fixed in OBS; an oracle outage can
   * never make name registration or renewal unavailable. v1.6.0 separately
   * resets the validator admission bond to exactly 20,000 OBS.
   *
   * 1.4.0 hardens mainnet consensus: each valid block contributes exactly one
   * PoT weight unit, timeout rounds remain inside the validator set, validator
   * registration binds its key to the sender, and per-transaction event limits
   * are consensus enforced.
   *
   * 1.6.0 launches a fresh genesis with a public, genesis-committed finality
   * bootstrap set; removes discontinued application transactions; fixes
   * deterministic PoT fork choice; requires an exact 20,000 OBS validator bond;
   * and routes ONS revenue 90% to node runners / 10% to treasury.
   *
   * 1.6.1 is a consensus-rule change with no economic change. Four rules move:
   *
   *   - VALIDATOR ADMISSION MODE is an explicit, state-committed indicator
   *     (`validatorSetNeverReopens`). A chain that has never accepted a valid
   *     registration is in bootstrap mode, where any node may propose so the
   *     first validator can arrive; from the first successful registration the
   *     rotation is closed for ever. A zero-validator chain after that point
   *     HALTS. It never reopens to permissionless production, because
   *     "no validators are registered" is not distinguishable, on the chain
   *     alone, from "every validator left".
   *   - JAILING IS MEASURED IN PROTOCOL TIME (`jailSlots` × target interval),
   *     not in blocks. A jail measured in blocks cannot expire on a chain that
   *     stopped producing, and stopping is exactly what a jail can cause.
   *   - SLASH LIABILITY FOLLOWS THE REGISTRATION
   *     (`slashLiabilityFollowsRegistration`): evidence about a tenure is
   *     chargeable to that tenure's bond while it is escrowed, including after
   *     the validator unregisters, and it names that exact tenure.
   *   - EQUIVOCATION EVIDENCE HAS A PER-BLOCK BUDGET (`slashing`), so a peer
   *     cannot make a block cost unbounded signature verification.
   *
   * These are rule changes, so the protocol version moves to 1.6.1 and the
   * parameter hash changes with them: two nodes cannot share a protocol
   * identity and disagree about the rules.
   */
  protocolVersion: '1.6.1',

  // ── Proof of Time (PoT) ───────────────────────────────────────────────────
  /**
   * PROOF OF TIME — the consensus identity of Obsidian Network.
   *
   * Obsidian does not hold a hash-puzzle race. A block is produced by the
   * validator whose slot it is, and acceptance depends on TIME, not on how much
   * computation anyone spent:
   *
   *   - the proposer for a height is scheduled deterministically from the
   *     validator set (`proposer = activeValidators[(height + round) mod n]`,
   *     where the round counts slots elapsed since the parent), so nobody
   *     competes by spending work, and an absent validator costs one slot
   *     rather than halting the chain;
   *   - a block's timestamp must exceed the median time past of its ancestors
   *     and may not run ahead of the network's time (see `block` below), so a
   *     node cannot manufacture time;
   *   - `PoT Difficulty` observes how actual block spacing compares with the
   *     target and is recomputed from chain history every
   *     `difficultyWindowBlocks` blocks. It is telemetry, not an acceptance
   *     threshold, and never asks anyone to hash harder;
   *   - participation itself is time-based: mining claims open on a 4-hour
   *     protocol-time schedule, six per day per wallet.
   *
   * Cryptographic hashing still happens everywhere (block ids, Merkle roots,
   * state roots, signatures). Computation is not the consensus mechanism: time
   * is. That distinction is the whole point of PoT, and it is documented in
   * /docs/proof-of-time.md.
   */
  proofOfTime: {
    /** Machine-readable consensus identity, reported by every node. */
    consensus: 'PROOF_OF_TIME' as const,
    /** Short name used in APIs and the interface. */
    shortName: 'PoT' as const,
    /**
     * Fork-choice rule. Every valid block contributes exactly one unit;
     * equal-weight/height branches resolve by the lowest block hash, independent
     * of peer arrival order or unauthenticated vote gossip.
     */
    weightRule: 'FINALIZED_ANCHOR_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH' as const,
    /** Blocks of history used to recompute PoT Difficulty. */
    difficultyWindowBlocks: 720,
    /** Reference spacing in seconds that observational PoT Difficulty compares against. */
    difficultyTargetSeconds: 5,
    /**
     * PoT Difficulty bounds, in basis points of the *time* target
     * (2_500 = 25% of the target spacing, 40_000 = 400%).
     */
    minDifficultyBps: 2_500,
    maxDifficultyBps: 40_000,
    /**
     * PoT Difficulty is published in thousandths of a second as observational
     * spacing telemetry. It is not a consensus-enforced minimum.
     */
    minBlockSpacingMs: 200,
    /** Time-Rate measurement window, seconds (one day). */
    timeRateWindowSeconds: 24 * 60 * 60,
    /**
     * Time-Rate is the protocol's participation metric: verified blocks and
     * verified transactions per minute of protocol time, across the window.
     * It is what an explorer shows where a PoW chain shows hashrate.
     */
    timeRateUnit: 'BLOCKS_AND_TXS_PER_MINUTE' as const,
  },

  // ── Platform revenue split + Node Runner rewards ───────────────────────────
  /**
   * ONS is the only source of protocol revenue. Every accepted registration or
   * renewal fee is split in the state transition:
   *
   *     ONS revenue
   *        ├── 90%  →  Node Runner Reward Pool
   *        └── 10%  →  protocol treasury wallet (genesis-designated)
   *
   * Integer allocation floors the runner share and assigns the exact remainder
   * to treasury, so no seal is lost or duplicated. Gas, issuance, validator
   * bonds, mining rewards and the genesis allocation are not ONS revenue.
   */
  nodeRewards: {
    /** 90% of ONS revenue goes to node runners. */
    nodePoolShareBps: 9_000,
    /** 10% goes to the protocol treasury wallet. */
    treasuryShareBps: 1_000,
    /** Reward period length in seconds (one day of protocol time). */
    periodSeconds: 24 * 60 * 60,
    /**
     * Minimum verified uptime (basis points) for a node to be eligible in a
     * period. Below this the node is scored but receives nothing.
     */
    minUptimeBps: 5_000,
    /** Minimum total score (basis points) required to receive a share. */
    minScoreBps: 1_000,
    /**
     * Attestations needed before a node's liveness is considered independently
     * verified, when enough peers exist. With n registered nodes the protocol
     * requires `min(minAttesters, n - 1)` distinct attesters: a two-node
     * network can verify each other, a single-node network cannot.
     */
    minAttesters: 2,
    /** Uptime component of a single-node network, per mille of the peerless case. */
    bootstrapUptimeBps: 5_000,
    /** Maximum subjects one node may attest in one period. */
    maxAttestationsPerAttester: 64,
    /** Heartbeats accepted per node per period. */
    heartbeatsPerPeriod: 1,
    /** Fault reports accepted per reporter per period. */
    maxFaultReportsPerReporterPerPeriod: 8,
    /** Score weight of one corroborated fault report, basis points. */
    faultPenaltyBps: 2_000,
    /** Maximum block lag still counted as "responsive" in an attestation. */
    responsiveHeightLag: 12,
    /**
     * Score composition (basis points, must sum to 10_000). Every component is
     * computed by each node from chain data; no operator ever reports a number.
     */
    scoreWeights: {
      uptimeBps: 4_000,
      participationBps: 2_500,
      reliabilityBps: 2_000,
      responsivenessBps: 1_500,
    },
    /** Within participation: produced blocks vs. attested peer coverage. */
    participationWeights: { blocksBps: 6_000, coverageBps: 4_000 },
    /** Ceiling on what one node may take from a period's pool (5%). */
    maxNodeShareBps: 500,
    /** Reward-wallet changes take effect after this many periods. */
    walletChangeDelayPeriods: 1,
    /** Evidence kept per node, in periods (older periods are archived). */
    evidenceWindowPeriods: 3,
    /** Minimum registration age, in blocks, before a node can earn. */
    minRegistrationBlocks: 1,
    /**
     * Maximum validity of a signed node statement (registration, deregistration),
     * in seconds of protocol time. Short windows mean a captured statement is
     * useless by the time an attacker can mine it into a block.
     */
    proofMaxValiditySeconds: 3_600,
    /** Endpoint hint length limits (informational field, never an identity). */
    maxEndpointLength: 120,
  },


  // ── Supply ────────────────────────────────────────────────────────────────
  /** Hard cap. Issuance of ANY kind is rejected if it would exceed this. */
  maxSupply: MAX_SUPPLY_SEALS,
  /** One-time genesis allocation reserved for the first protocol-valid miner. */
  genesisAllocation: parseObs('100000'),
  /**
   * The legacy 3,000,000 OBS genesis allocation is REMOVED and MUST NOT exist.
   * This constant exists purely so the automated compliance checklist can
   * assert its value is zero. Nothing may ever read it for issuance.
   */
  legacyGenesisAllocationRemoved: 0n,

  // ── Mining ────────────────────────────────────────────────────────────────
  mining: {
    /** Minimum seconds between two accepted claims by the same wallet. */
    claimIntervalSeconds: 4 * 60 * 60,
    /** Maximum accepted claims per wallet per rolling 24-hour cycle. */
    maxClaimsPerCycle: 6,
    /** Length of the claim cycle in seconds. */
    cycleSeconds: 24 * 60 * 60,
    /** Genesis-era total daily reward across the whole network. */
    initialDailyReward: parseObs('0.001'),
    /** Per-claim reward while the network is at genesis participation. */
    initialClaimReward: parseObs('0.000166666666666666'),
    /** Owner of a claim must have been registered at least this recent... */
    activeMinerWindowSeconds: 30 * 24 * 60 * 60,
    /**
     * Reward reduction: 0.5% per 100,000 active miners.
     * Implemented with exact integer arithmetic (see mining/schedule.ts).
     */
    reductionBasisPointsPerStep: 50, // 0.50%
    reductionStepMiners: 100_000,
    /** Absolute floor: 0.0002 OBS per 24 hours. Never crossed. */
    dailyRewardFloor: parseObs('0.0002'),
    /**
     * Grace applied to a wallet's very first claim so a miner is never forced
     * to wait for a full interval after registering the wallet on-chain.
     */
    firstClaimGraceSeconds: 0,
    /** Maximum claims accepted from one wallet inside a single block. */
    maxClaimsPerBlockPerWallet: 1,
  },

  // ── Gas ───────────────────────────────────────────────────────────────────
  gas: {
    /** 0.02% of the transferred amount, in basis points. */
    basisPoints: 2,
    /** Absolute ceiling on gas per transaction: 0.01 OBS. */
    maxGas: parseObs('0.01'),
    /** Minimum gas charged on any value-bearing transaction (anti-spam dust). */
    minGas: 0n,
    /**
     * Gas destination. Protocol rule: gas is remitted to the Mining Pool.
     * The Mining Pool is protocol state, not a wallet; see treasury/pool.ts.
     */
    destination: 'MINING_POOL' as const,
  },

  // ── Blocks ────────────────────────────────────────────────────────────────
  block: {
    /** Target spacing between blocks, seconds. */
    targetBlockSeconds: 5,
    /** Maximum serialized block size in bytes. */
    maxBlockBytes: 2 * 1024 * 1024,
    /** Maximum number of transactions in one block including the reward claim batch. */
    maxBlockTransactions: 2_000,
    /** Allowed future drift for a block timestamp relative to local node time. */
    maxFutureDriftSeconds: 60,
    /** Minimum number of parents considered when computing median time past. */
    medianTimePastWindow: 11,
    /** Blocks after which a transaction is considered buried (soft finality hint). */
    confirmationDepthSoft: 12,
    /** Deeper advisory confirmation threshold; not irreversible or mathematical finality. */
    confirmationDepthHard: 64,
    /** Emission decade length used by the halving-style issuance cap. */
    issuanceDecadeSeconds: 10 * 365.25 * 24 * 60 * 60,
  },

  // ── Validators / consensus ────────────────────────────────────────────────
  consensus: {
    /** Slots per producer rotation (proposer = validators[height % validatorCount]). */
    validatorSlotsPerRotation: 1,
    /** Exact admission bond required from every validator: 20,000 OBS. */
    validatorBond: parseObs('20000'),
    /**
     * Share of the bond taken from a validator that is proven, with signatures
     * every node can check, to have equivocated — two conflicting block
     * proposals or two conflicting finality votes for one slot. 5,000 bps =
     * exactly half of the 20,000 OBS bond, so a proven offence costs 10,000 OBS
     * and leaves 10,000 OBS held by the validator.
     *
     * The penalty is a parameter and the amount is derived from the validator's
     * own recorded bond, so no submitter can name an amount, and a change to the
     * ratio is a visible, hash-committed protocol change rather than a number
     * buried in an executor.
     */
    equivocationSlashBps: 5_000,
    /** Unbonding delay in blocks before bond funds return. */
    unbondingBlocks: 20_160, // ~28 hours at 5s blocks
    /**
     * Net missed slots tolerated before jailing. The counter is leaky: a
     * recorded miss adds one, a block the validator actually produced subtracts
     * one, so an absent validator's count only rises.
     */
    maxMissedSlotsPerWindow: 40,
    /**
     * Jail term, expressed in SLOTS (see VALIDATOR_JAIL_SECONDS below):
     * 10,080 × 5 s = 50,400 s = 14 hours of protocol time.
     *
     * A jail measured in BLOCKS cannot end on a chain that has stopped
     * producing blocks, and stopping is precisely what a jail can cause once it
     * empties the active set — the chain would then be halted for as long as
     * nobody could produce the blocks that count the jail down. Measuring the
     * term in protocol time keeps it honest on a halted chain: it lapses
     * whether or not anyone produces, and the validator returns in the first
     * block that reaches the instant.
     */
    jailSlots: 10_080,
    /**
     * THE VALIDATOR SET NEVER REOPENS (1.6.1 consensus rule).
     *
     * The first VALIDATOR_REGISTER that succeeds sets a committed indicator,
     * and from then on block production is a privilege of the active set alone.
     * An established chain with no active validator halts instead of accepting
     * a block from any key that happens to sign one. The indicator is consensus
     * state: it is committed in the state root, restored on restart, and set
     * only by a state transition — never inferred from how many validators a
     * node currently sees, and never cleared.
     */
    validatorSetNeverReopens: true,
    /**
     * SLASH LIABILITY FOLLOWS THE REGISTRATION (1.6.1 consensus rule).
     *
     * Equivocation evidence is about a tenure: the key, the bond and the
     * validator set that were in force when the offence happened. The bond
     * stays answerable for that tenure for as long as it is still escrowed, so
     * unregistering after an offence does not move the penalty to the next
     * registration, and a later registration is not answerable for an offence
     * committed by an earlier one.
     */
    slashLiabilityFollowsRegistration: true,
    /**
     * A branch must contain finalized history. Compare fixed PoT weight, then
     * height, then the lexicographically lowest canonical block hash.
     */
    forkChoice: 'FINALIZED_ANCHOR_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH' as const,
    /** Maximum reorg depth accepted by the node's ordinary chain reorganiser. */
    maxReorgDepth: 256,
    /** Native PoT checkpoint finality; bond is admission collateral, not vote weight. */
    finality: {
      voteType: 'POT_FINALITY' as const,
      quorumNumerator: 2,
      quorumDenominator: 3,
      maxValidators: 256,
      maxPendingVotes: 512,
      maxCandidatesPerHeight: 8,
      maxEvidenceRecords: 256,
      maxEvidenceBytes: 16 * 1024,
      /** Bootstrap committee must remain active for this many parent blocks. */
      bootstrapSetStabilityBlocks: 64,
    },
    /**
     * Equivocation-evidence budget for ONE block — a consensus limit, so every
     * node accepts exactly the same blocks and no block can be made to cost an
     * unbounded amount of signature verification.
     *
     * A report that does not fit stays in the mempool for a later slot; it is
     * never rejected. SLASH remains permissionlessly submittable: these limits
     * bound what one block carries, not who may report.
     */
    slashing: {
      /** Maximum equivocation reports in a single block. */
      maxEvidencePerBlock: 8,
      /** Maximum canonical evidence bytes in a single block. */
      maxEvidenceBytesPerBlock: 65_536,
    },
  },

  // ── Accounts / transactions ───────────────────────────────────────────────
  tx: {
    /** Replay window: a transaction is invalid if included after this many blocks. */
    expiryBlocks: 240,
    /** Maximum memo length in bytes. */
    maxMemoBytes: 256,
    /** Maximum signed transaction size in bytes. */
    maxTxBytes: 16 * 1024,
    /** Maximum number of out-messages a transaction executor may enqueue. */
    maxEventsPerTx: 64,
    /** Minimum transfer amount enforced by the protocol (anti-dust). */
    minTransfer: 1n, // one seal = 1e-18 OBS
  },

  // ── ONS (Obsidian Name Service) ───────────────────────────────────────────
  ons: {
    minLength: 3,
    maxLength: 63,
    /**
     * Registration and renewal fees, denominated in OBS itself.
     *
     * Previously $5.00 converted at the oracle price, which made name
     * registration unavailable whenever the oracle was absent or stale. The
     * protocol now prices its own services in its own currency: no external
     * price source participates in consensus at all.
     */
    registrationFee: parseObs('0.05'),
    renewalFee: parseObs('0.05'),
    /** Registration grants ownership for this many seconds (1 year). */
    termSeconds: 365 * 24 * 60 * 60,
    /** Grace period after expiry before the name returns to the pool. */
    graceSeconds: 30 * 24 * 60 * 60,
    /** Protocol-reserved names that can never be registered by users. */
    reserved: [
      'obs',
      'www',
      'admin',
      'root',
      'treasury',
      'foundation',
      'blackseal',
      'core',
      'node',
      'genesis',
      'support',
      'api',
      'wallet',
      'explorer',
      'developer',
    ] as const,
  },

  // ── Oracle ────────────────────────────────────────────────────────────────
  oracle: {
    /** Price is invalid if older than this many seconds. */
    maxAgeSeconds: 6 * 60 * 60,
    /** Quorum: observations required to form a median price. */
    minSources: 2,
    /** Sanity bound: reject any single observation this far from local median. */
    maxDeviationBps: 2_500, // 25%
    /** Absolute bounds on OBS/USD price in micro-USD. */
    minPriceUsdMicro: 1n, // $0.000001
    maxPriceUsdMicro: 1_000_000_000_000n, // $1,000,000
    /** Maximum observation age accepted from a single source, seconds. */
    maxSourceAgeSeconds: 36 * 60 * 60,
  },

  // ── Registry / application bridge ────────────────────────────────────────
  registry: {
    /**
     * Invite-only registration is an APPLICATION policy, never consensus.
     * Each application account may invite at most this many new accounts.
     */
    maxInvitesPerAccount: 5,
    /** New accounts always begin at exactly this balance. */
    newAccountBalance: 0n,
    /**
     * WAC is removed. These constants exist so the compliance checklist can
     * assert the removal programmatically.
     */
    wacPriceUsd: 0n,
    wacEnabled: false,
    miningKycRequired: false,
    miningWithdrawalRequiresWac: false,
    nativeExchangeEnabled: false,
  },
} as const;

/** Convenience: reward floor per claim derived from the daily floor. */
export const MIN_CLAIM_REWARD = CONSENSUS_PARAMS.mining.dailyRewardFloor;

/**
 * Jail term in seconds of protocol time, derived from `consensus.jailSlots`.
 *
 * Derived rather than declared: two nodes that disagreed about the length of a
 * jail would disagree about the first block a jailed validator may propose
 * again, which is a consensus split. Keeping one source of truth makes that
 * impossible, and `computeParamsHash` commits the slot count to the state root.
 */
export const VALIDATOR_JAIL_SECONDS =
  CONSENSUS_PARAMS.consensus.jailSlots * CONSENSUS_PARAMS.block.targetBlockSeconds;

/**
 * Protocol time at which a validator's jail ends, or null when it is not jailed.
 *
 * A JAILED record with no term returns null and is treated as jailed for ever:
 * the term is what makes a jail end, and guessing a default would let a
 * malformed record free a validator that the chain had removed.
 */
export function jailEndsAt(validator: { status: string; jailedUntilTime?: number }): number | null {
  if (validator.status !== 'JAILED') return null;
  const until = validator.jailedUntilTime;
  if (typeof until !== 'number' || !Number.isFinite(until)) return null;
  return until;
}

/**
 * Whether a jail has lapsed at `atTimestamp`.
 *
 * Deliberately a pure function of committed state and a protocol timestamp: the
 * same question asked about the same block gets the same answer on every node,
 * and it keeps working on a chain that has stopped producing blocks — which is
 * exactly the chain a jail can cause once it empties the active set.
 *
 * It lives beside the parameter it interprets, in a module the browser build
 * keeps, because the validator executor needs the same answer the chain
 * computes: a browser-safe module may not reach into node-only state code.
 */
export function jailIsOver(validator: { status: string; jailedUntilTime?: number }, atTimestamp: number): boolean {
  const until = jailEndsAt(validator);
  return until !== null && atTimestamp >= until;
}
