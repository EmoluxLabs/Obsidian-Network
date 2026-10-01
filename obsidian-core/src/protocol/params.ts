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
   * 1.1.0 introduces two consensus-visible changes:
   *   - the consensus identity is named and documented as Proof of Time (PoT):
   *     the fork-choice weight is PoT Weight, the timing rule is PoT Difficulty
   *     and the participation metric is Time-Rate (see `proofOfTime` below);
   *   - qualifying platform revenue is split 40% Node Runner Reward Pool /
   *     60% treasury at the state-transition layer (see `nodeRewards` below).
   */
  protocolVersion: '1.1.0',

  // ── Proof of Time (PoT) ───────────────────────────────────────────────────
  /**
   * PROOF OF TIME — the consensus identity of Obsidian Network.
   *
   * Obsidian does not hold a hash-puzzle race. A block is produced by the
   * validator whose slot it is, and acceptance depends on TIME, not on how much
   * computation anyone spent:
   *
   *   - the proposer for a height is scheduled deterministically from the
   *     validator set (`proposer = activeValidators[height mod n]`), so nobody
   *     competes by spending work;
   *   - a block's timestamp must exceed the median time past of its ancestors
   *     and may not run ahead of the network's time (see `block` below), so a
   *     node cannot manufacture time;
   *   - the `PoT Difficulty` raises or lowers the required *time* between
   *     blocks, measured against protocol time, and is recomputed from chain
   *     history every `difficultyWindowBlocks` blocks — it never asks anyone to
   *     hash harder;
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
     * Fork-choice weight rule. PoT Weight replaces PoW "work": a block's weight
     * is 1 + its transaction count — a measure of how much verified state the
     * block carries into the chain, not of spent computation.
     */
    weightRule: 'POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH' as const,
    /** Blocks of history used to recompute PoT Difficulty. */
    difficultyWindowBlocks: 720,
    /** Target spacing in seconds that PoT Difficulty aims to hold. */
    difficultyTargetSeconds: 5,
    /**
     * PoT Difficulty bounds, in basis points of the *time* target
     * (2_500 = 25% of the target spacing, 40_000 = 400%).
     */
    minDifficultyBps: 2_500,
    maxDifficultyBps: 40_000,
    /**
     * PoT Difficulty is published as an integer in thousandths of a second:
     * the minimum number of milliseconds that must separate two consecutive
     * block timestamps at the current difficulty.
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
   * Qualifying platform revenue is split at the moment it is received, inside
   * the state transition, by every node — not by a website, a worker or a
   * spreadsheet:
   *
   *     qualifying platform revenue
   *        ├── 40%  →  Node Runner Reward Pool
   *        └── 60%  →  protocol treasury wallet (genesis-designated)
   *
   * The split is exact integer arithmetic: `nodePool = floor(amount * 4000 /
   * 10_000)` and `treasury = amount - nodePool`, so the two always sum back to
   * the amount with no rounding leak in either direction.
   *
   * Gas is NOT platform revenue: gas goes to the Mining Pool (see `gas`), and
   * user-to-user transfers, mining rewards, creator earnings, marketplace
   * proceeds and escrowed funds are never platform revenue either. The
   * classification is enumerated in /docs/economics.md and enforced in
   * src/economy/revenue.ts.
   */
  nodeRewards: {
    /** 40% of qualifying platform revenue goes to node runners. */
    nodePoolShareBps: 4_000,
    /** 60% goes to the protocol treasury wallet. */
    treasuryShareBps: 6_000,
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
    /**
     * Registration bond, in OBS, locked from the reward wallet when a node
     * registers. It is the operator's own money, it is returned in full when the
     * node deregisters (minus nothing), and it exists so that a Sybil farm must
     * fund every node it creates. Set to 100 OBS: enough to make a farm
     * expensive, small enough that a hobbyist operator can run a node.
     */
    registrationBond: parseObs('100'),
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
    /** Depth at which an interface may show "final" (irreversible for practical use). */
    confirmationDepthHard: 64,
    /** Emission decade length used by the halving-style issuance cap. */
    issuanceDecadeSeconds: 10 * 365.25 * 24 * 60 * 60,
  },

  // ── Validators / consensus ────────────────────────────────────────────────
  consensus: {
    /** Slots per producer rotation (proposer = validators[height % validatorCount]). */
    validatorSlotsPerRotation: 1,
    /**
     * A validator must be bonded with at least this much OBS.
     *
     * 50 OBS, lowered from 1,000. The bond exists to make misbehaviour cost
     * something, not to gate participation: at 1,000 OBS the only account that
     * could ever afford one at launch was the genesis-allocation recipient,
     * which would have made the validator set a function of who claimed first.
     */
    minValidatorBond: parseObs('50'),
    /** Unbonding delay in blocks before bond funds return. */
    unbondingBlocks: 20_160, // ~28 hours at 5s blocks
    /** Missed slots tolerated in a 100-block window before jailing. */
    maxMissedSlotsPerWindow: 40,
    /** Jailing period in blocks. */
    jailBlocks: 10_080,
    /**
     * Fork-choice rule, under Proof of Time naming:
     * greatest accumulated PoT Weight, then greatest height (the most verified
     * time in the chain), then the lowest header hash as a deterministic
     * tie-break. There is no "most work" comparison anywhere in the protocol —
     * see /docs/proof-of-time.md and src/consensus/proposer.ts.
     */
    forkChoice: 'POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH' as const,
    /** Maximum reorg depth accepted by the node's chain reorganiser. */
    maxReorgDepth: 256,
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
      'social',
      'capsule',
      'circle',
      'developer',
    ] as const,
  },

  // ── Time Capsule ──────────────────────────────────────────────────────────
  capsules: {
    /** Minimum OBS commitment. */
    minCommitment: parseObs('0.0001'),
    /** Time Travel preview price multiplier (price = 1000 * commitment). */
    timeTravelMultiplier: 1000n,
    /** Preview window, in seconds. */
    previewSeconds: 30,
    /** Minimum lock duration from creation, in seconds (1 hour). */
    minLockSeconds: 60 * 60,
    /** Maximum lock duration (100 years) — a sanity bound, not a limit on ambition. */
    maxLockSeconds: 100 * 365.25 * 24 * 60 * 60,
    /** Maximum encrypted payload size per capsule, in bytes. */
    maxContentBytes: 256 * 1024,
    /** One Time Travel preview per capsule per account. */
    maxPreviewsPerAccount: 1,
  },

  // ── Obsidian Circle (land) ────────────────────────────────────────────────
  circle: {
    /**
     * Every parcel is 1 square metre at the level of the protocol market:
     * "one plot or one square metre, or less, per protocol transaction".
     */
    parcelSquareMetres: 1,
    /** Protocol purchase and buyback are executed one parcel per transaction. */
    maxParcelsPerProtocolTx: 1,
    /**
     * GLV (Global Location Value) multiplier applied to the location's base
     * value for each protocol purchase: GLV_next = GLV * (1 + step).
     * The buyer of a purchase never retroactively benefits — see docs.
     */
    protocolPurchaseMultiplierBps: 10_000, // rebuilt dynamically; see land/pricing.ts
    /** Step applied to GLV after each protocol purchase, in basis points (0.25%). */
    appreciationStepBps: 25,
    /** Step applied to GLV after each protocol buyback, in basis points (0.25%). */
    depreciationStepBps: 25,
    /** GLV bounds in USD micro-units. */
    minGlvUsd: 100_000_000n, // $100
    maxGlvUsd: 30_000_000_000n, // $30,000
    /** A buyback is only permitted when the protocol land reserve can fund it. */
    requireReserveForBuyback: true,
  },

  // ── Social ────────────────────────────────────────────────────────────────
  social: {
    /** Post body limit, bytes. */
    maxPostBytes: 8 * 1024,
    maxCommentBytes: 2 * 1024,
    maxUsernameLength: 24,
    /** Creator monetisation eligibility thresholds. */
    monetisationMinFollowers: 10_000,
    monetisationMinMonthlyViews: 100_000,
    /** Revenue split in basis points: 70% creator, 30% Obsidian Network. */
    creatorShareBps: 7_000,
    networkShareBps: 3_000,
    /**
     * Business page activation price, denominated in OBS.
     *
     * Was $50.00 at the oracle price; now a fixed 0.005 OBS so page creation
     * never depends on an external price feed.
     */
    businessPagePrice: parseObs('0.005'),
    /** Tip minimum (one seal). */
    minTip: 1n,
    /** Feed page size ceiling enforced by the node. */
    maxPageSize: 100,
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
